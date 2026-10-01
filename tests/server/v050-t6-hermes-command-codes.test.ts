// hermes-v050:T6 — Hermes 会话斜杠命令回执：英文 message 原样保留（旧客户端、入库 content、历史照旧），
// 另带稳定的 messageCode + messageParams；入库时 code 与参数一起写进 command_data。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  addMessage: vi.fn(() => 501),
  clearSessionMessages: vi.fn(() => 7),
  createBranchedSession: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(),
  getSessionDetail: vi.fn(),
  renameSession: vi.fn(() => true),
  updateSessionStats: vi.fn(),
  calcAndUpdateUsage: vi.fn(async () => ({ inputTokens: 10, outputTokens: 20 })),
  forceCompressBridgeHistory: vi.fn(),
  readConfigYamlForProfile: vi.fn(async () => ({})),
  handleAbort: vi.fn(async () => {}),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  addMessage: mocks.addMessage,
  clearSessionMessages: mocks.clearSessionMessages,
  createBranchedSession: mocks.createBranchedSession,
  createSession: mocks.createSession,
  getSession: mocks.getSession,
  getSessionDetail: mocks.getSessionDetail,
  renameSession: mocks.renameSession,
  updateSessionStats: mocks.updateSessionStats,
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  readConfigYamlForProfile: mocks.readConfigYamlForProfile,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/compression', () => ({
  buildDbSnapshotAwareHistory: vi.fn(async () => [{ role: 'user', content: 'hi' }]),
  forceCompressBridgeHistory: mocks.forceCompressBridgeHistory,
  getOrCreateSession: vi.fn((sessionMap: Map<string, any>, sessionId: string) => sessionMap.get(sessionId)),
  replaceState: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  calcAndUpdateUsage: mocks.calcAndUpdateUsage,
  contextTokensWithCachedOverhead: vi.fn((_state: any, tokens: number) => tokens),
  estimateUsageTokensFromMessages: vi.fn(() => ({ inputTokens: 900, outputTokens: 100 })),
  updateMessageContextTokenUsage: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/abort', () => ({
  handleAbort: mocks.handleAbort,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/bridge-message', () => ({
  flushBridgePendingToDb: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({
  getModelContextLength: vi.fn(() => 256_000),
}))

const YOLO_ON = '⚡ YOLO mode ON for this session — all commands auto-approved. Use with caution.'
const YOLO_OFF = '⚠️ YOLO mode OFF for this session — dangerous commands will require approval.'

type Scenario = {
  name: string
  input: string
  working?: boolean
  queue?: any[]
  bridge?: Record<string, any>
  setup?: () => void
  code: string | undefined
  params?: Record<string, unknown>
  message: string
}

function makeBridge(overrides: Record<string, any> = {}) {
  return {
    command: vi.fn(async () => ({ handled: false })),
    status: vi.fn(async () => ({ exists: true, running: false, current_run_id: null, message_count: 0 })),
    steer: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    mcpReload: vi.fn(async () => ({ ok: true })),
    reloadSkills: vi.fn(async () => ({ added: [], removed: [], total: 3 })),
    ...overrides,
  }
}

async function run(scenario: Scenario) {
  const state: any = {
    messages: [],
    isWorking: Boolean(scenario.working),
    events: [],
    queue: scenario.queue || [],
    runId: scenario.working ? 'run-9' : undefined,
  }
  const namespaceEmit = vi.fn()
  const nsp = {
    to: vi.fn(() => ({ emit: namespaceEmit })),
    adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) },
  }
  const socket = { id: 'socket-1', connected: true, join: vi.fn(), emit: vi.fn() }
  const sessionMap = new Map([['session-1', state]])
  const bridge = makeBridge(scenario.bridge)
  const { handleSessionCommand, parseSessionCommand } = await import(
    '../../packages/server/src/modules/studio/services/chat-run/session-command'
  )
  const parsed = parseSessionCommand(scenario.input)
  expect(parsed, scenario.input).not.toBeNull()
  await handleSessionCommand('session-1', parsed!, {
    nsp: nsp as any,
    socket: socket as any,
    sessionMap,
    bridge: bridge as any,
    profile: 'default',
    model: 'test-model',
    runQueuedItem: vi.fn(),
  })
  const payloads = namespaceEmit.mock.calls
    .filter(([event]: [string]) => event === 'session.command')
    .map(([, payload]: [string, any]) => payload)
    .filter((payload: any) => typeof payload.message === 'string' && payload.message)
  return { payloads, state }
}

const scenarios: Scenario[] = [
  { name: 'skill usage', input: '/skill', code: 'hermes_skill_usage', message: 'Usage: /skill <skill-name> [instructions]' },
  { name: 'bundles usage', input: '/bundles', code: 'hermes_bundles_usage', message: 'Usage: /bundles <bundle-name> [instructions]' },
  { name: 'bundles create hint', input: '/bundles create', code: 'hermes_bundles_create_hint', message: 'Use /bundles create in X-Agent to open the bundle creator.' },
  {
    name: 'skill command failed', input: '/skill foo',
    bridge: { command: vi.fn(async () => { throw new Error('bridge down') }) },
    code: 'hermes_skill_failed', params: { error: 'bridge down' }, message: 'Skill command failed: bridge down',
  },
  {
    name: 'bundle command failed', input: '/bundles foo',
    bridge: { command: vi.fn(async () => { throw new Error('bridge down') }) },
    code: 'hermes_bundle_failed', params: { error: 'bridge down' }, message: 'Bundle command failed: bridge down',
  },
  {
    name: 'bundle did not resolve', input: '/bundles foo',
    bridge: { command: vi.fn(async () => ({ handled: true, type: 'skill', message: 'expanded' })) },
    code: 'hermes_bundle_not_found', params: { name: 'foo' }, message: '/foo did not resolve to a Bundle.',
  },
  {
    name: 'skill resolved to a bundle', input: '/skill foo',
    bridge: { command: vi.fn(async () => ({ handled: true, type: 'bundle', message: 'expanded' })) },
    code: 'hermes_skill_is_bundle', params: { name: 'foo' }, message: '/foo resolved to a Bundle. Use /bundles foo instead.',
  },
  {
    name: 'unknown bridge command (fallback)', input: '/skill foo',
    code: 'hermes_unknown_command', params: { name: 'foo' }, message: 'Unknown bridge command: /foo',
  },
  {
    name: 'bridge says the command is unsupported', input: '/skill foo',
    bridge: { command: vi.fn(async () => ({ handled: false, message: 'not a supported bridge command: /foo' })) },
    code: 'hermes_bridge_command_unsupported', params: { name: 'foo' }, message: 'not a supported bridge command: /foo',
  },
  {
    name: 'other bridge text passes through without a code', input: '/skill foo',
    bridge: { command: vi.fn(async () => ({ handled: false, message: 'skill dispatch said no' })) },
    code: undefined, message: 'skill dispatch said no',
  },
  {
    name: 'learn failed', input: '/learn docs',
    bridge: { command: vi.fn(async () => { throw new Error('boom') }) },
    code: 'hermes_learn_failed', params: { error: 'boom' }, message: 'Learn command failed: boom',
  },
  { name: 'learn unavailable', input: '/learn docs', code: 'hermes_learn_unavailable', message: 'Learn command is not available.' },
  {
    name: 'moa usage', input: '/moa',
    setup: () => mocks.readConfigYamlForProfile.mockResolvedValue({
      moa: { default_preset: 'duo', presets: { duo: { reference_models: [{ provider: 'p', model: 'a' }], aggregator: { provider: 'p', model: 'b' } } } },
    }),
    code: 'hermes_moa_usage', message: 'Usage: /moa <prompt>',
  },
  {
    name: 'moa queued', input: '/moa compare these',
    setup: () => mocks.readConfigYamlForProfile.mockResolvedValue({
      moa: { default_preset: 'duo', presets: { duo: { reference_models: [{ provider: 'p', model: 'a' }], aggregator: { provider: 'p', model: 'b' } } } },
    }),
    code: 'hermes_moa_queued', params: { preset: 'duo' }, message: 'MoA one-shot queued with preset duo.',
  },
  {
    name: 'usage', input: '/usage',
    code: 'hermes_usage', params: { input: 10, output: 20, total: 30 }, message: 'Usage: input 10, output 20, total 30 tokens.',
  },
  {
    name: 'context', input: '/context',
    code: 'hermes_context', params: { input: 10, output: 20, total: 30, window: 256000, percent: 0 },
    message: 'Context: input 10, output 20, total 30 / 256000 tokens (0%).',
  },
  {
    name: 'status', input: '/status',
    code: 'hermes_status',
    params: { running: false, source: 'cli', profile: 'default', model: 'test-model', queue: 0, run: '-', bridge: 'idle' },
    message: 'Status: idle, source: cli, profile: default, model: test-model, queue: 0, run: -, bridge: idle',
  },
  {
    name: 'status without bridge', input: '/status',
    bridge: { status: vi.fn(async () => { throw new Error('offline') }) },
    code: 'hermes_status',
    params: { running: false, source: 'cli', profile: 'default', model: 'test-model', queue: 0, run: '-', bridge: null },
    message: 'Status: idle, source: cli, profile: default, model: test-model, queue: 0, run: -',
  },
  { name: 'yolo unavailable', input: '/yolo', code: 'hermes_yolo_unavailable', message: 'YOLO mode is not available in the running Hermes Agent runtime.' },
  {
    name: 'yolo unavailable (bridge text passes through)', input: '/yolo',
    bridge: { command: vi.fn(async () => ({ handled: false, message: '/yolo requires a newer Hermes Agent runtime with session-scoped YOLO support.' })) },
    code: undefined, message: '/yolo requires a newer Hermes Agent runtime with session-scoped YOLO support.',
  },
  {
    name: 'yolo on (bridge text equals the known text)', input: '/yolo',
    bridge: { command: vi.fn(async () => ({ handled: true, enabled: true, message: YOLO_ON })) },
    code: 'hermes_yolo_on', message: YOLO_ON,
  },
  {
    name: 'yolo off (server fallback)', input: '/yolo',
    bridge: { command: vi.fn(async () => ({ handled: true, enabled: false })) },
    code: 'hermes_yolo_off', message: YOLO_OFF,
  },
  {
    name: 'yolo with other bridge text passes through', input: '/yolo',
    bridge: { command: vi.fn(async () => ({ handled: true, enabled: true, message: 'YOLO is on (custom runtime)' })) },
    code: undefined, message: 'YOLO is on (custom runtime)',
  },
  {
    name: 'yolo failed', input: '/yolo',
    bridge: { command: vi.fn(async () => { throw new Error('boom') }) },
    code: 'hermes_yolo_failed', params: { error: 'boom' }, message: 'YOLO command failed: boom',
  },
  { name: 'abort', input: '/abort', code: 'hermes_abort_requested', message: 'Abort requested.' },
  { name: 'queue usage', input: '/queue', code: 'hermes_queue_usage', message: 'Usage: /queue <message>' },
  { name: 'queue idle', input: '/queue later', code: 'hermes_queue_idle', message: 'Session is idle. Send the message normally instead.' },
  {
    name: 'queue queued', input: '/queue later', working: true,
    code: 'hermes_queue_queued', params: { length: 1 }, message: 'Queued message. Queue length: 1.',
  },
  {
    name: 'plan failed', input: '/plan ship it',
    bridge: { command: vi.fn(async () => { throw new Error('boom') }) },
    code: 'hermes_plan_failed', params: { error: 'boom' }, message: 'Plan command failed: boom',
  },
  { name: 'plan unavailable', input: '/plan ship it', code: 'hermes_plan_unavailable', message: 'Plan command is not available.' },
  {
    name: 'goal busy', input: '/goal build the thing', working: true,
    code: 'hermes_goal_busy', message: 'Agent is running. Use /goal status, /goal pause, or /goal clear mid-run, or /abort before setting a new goal.',
  },
  {
    name: 'goal failed', input: '/goal status',
    bridge: { command: vi.fn(async () => { throw new Error('boom') }) },
    code: 'hermes_goal_failed', params: { error: 'boom' }, message: 'Goal command failed: boom',
  },
  {
    name: 'goal status while running', input: '/goal status',
    bridge: {
      command: vi.fn(async () => ({ handled: true, action: 'goal_status', message: 'Goal: ship (2/5 turns)' })),
      status: vi.fn(async () => ({ exists: true, running: true, current_run_id: 'run-7', message_count: 3 })),
    },
    code: 'hermes_goal_status',
    params: { text: 'Goal: ship (2/5 turns)', running: true, runId: 'run-7', turn: { current: 3, max: 5, used: 2 } },
    message: 'Goal: ship (2/5 turns)\nCurrent turn: 3/5 running (completed turns: 2/5; count updates after the judge).\nRun: running (run-7)',
  },
  {
    name: 'goal status while idle', input: '/goal status',
    bridge: { command: vi.fn(async () => ({ handled: true, action: 'goal_status', message: 'Goal: ship' })) },
    code: 'hermes_goal_status',
    params: { text: 'Goal: ship', running: false, runId: null, turn: null },
    message: 'Goal: ship\nRun: idle',
  },
  {
    name: 'goal message without bridge status passes through', input: '/goal pause',
    bridge: { command: vi.fn(async () => ({ handled: true, action: 'pause', message: '⏸ Goal paused: ship' })) },
    code: undefined, message: '⏸ Goal paused: ship',
  },
  {
    name: 'clear history busy', input: '/clear --history', working: true,
    code: 'hermes_clear_busy', message: 'Cannot clear history while the bridge run is active. Abort or destroy it first.',
  },
  {
    name: 'clear history done', input: '/clear --history',
    code: 'hermes_clear_history_done', params: { count: 7 }, message: 'Cleared 7 history messages from the database.',
  },
  { name: 'clear display', input: '/clear', code: 'hermes_clear_display_done', message: 'Cleared the current display. History in the database was not deleted.' },
  { name: 'title usage', input: '/title', code: 'hermes_title_usage', message: 'Usage: /title <new title>' },
  { name: 'title updated', input: '/title Sprint notes', code: 'hermes_title_updated', params: { title: 'Sprint notes' }, message: 'Title updated: Sprint notes' },
  {
    name: 'title not found', input: '/title Sprint notes', setup: () => mocks.renameSession.mockReturnValue(false),
    code: 'hermes_title_not_found', message: 'Session was not found in the database.',
  },
  { name: 'compress busy', input: '/compress', working: true, code: 'hermes_compress_busy', message: 'Compression can only run while the session is idle.' },
  {
    name: 'compress done', input: '/compress',
    setup: () => mocks.forceCompressBridgeHistory.mockResolvedValue({ beforeMessages: 10, resultMessages: 3, beforeTokens: 1000, afterTokens: 200, compressed: true }),
    code: 'hermes_compress_done', params: { beforeMessages: 10, resultMessages: 3, beforeTokens: 1000, afterTokens: 200 },
    message: 'Compression completed: 10 -> 3 messages, 1000 -> 200 tokens.',
  },
  {
    name: 'compress failed', input: '/compress',
    setup: () => mocks.forceCompressBridgeHistory.mockRejectedValue(new Error('summarizer offline')),
    code: 'hermes_compress_failed', params: { error: 'summarizer offline' }, message: 'Compression failed: summarizer offline',
  },
  {
    name: 'branch busy', input: '/fork', working: true,
    code: 'hermes_branch_busy', message: 'Cannot branch while the session is running. Wait for it to finish or use /abort first.',
  },
  {
    name: 'branch coding agent', input: '/fork',
    setup: () => mocks.getSession.mockReturnValue({ id: 'session-1', profile: 'default', source: 'coding_agent', agent: 'claude' }),
    code: 'hermes_branch_coding_agent', message: 'Cannot branch coding agent sessions.',
  },
  {
    name: 'branch empty', input: '/fork',
    setup: () => mocks.getSessionDetail.mockReturnValue({ messages: [] }),
    code: 'hermes_branch_empty', message: 'Cannot branch: no conversation messages found to copy.',
  },
  {
    name: 'branch done', input: '/fork Alternate',
    setup: () => {
      mocks.getSessionDetail.mockReturnValue({ messages: [{ role: 'user', content: 'Root prompt', timestamp: 1 }] })
      mocks.createBranchedSession.mockReturnValue({ id: 'child', fork_point_message_id: null })
    },
    code: 'hermes_branch_done', params: { title: 'Alternate', parent: 'session-1' },
    message: 'Branched session "Alternate" from session-1.',
  },
  { name: 'steer usage', input: '/steer', code: 'hermes_steer_usage', message: 'Usage: /steer <instruction>' },
  { name: 'steer idle', input: '/steer go left', code: 'hermes_steer_idle', message: 'No active bridge run to steer.' },
  { name: 'steer sent', input: '/steer go left', working: true, code: 'hermes_steer_sent', message: 'Steer instruction sent.' },
  {
    name: 'mcp reload busy', input: '/reload-mcp', working: true,
    code: 'hermes_mcp_reload_busy', message: 'MCP reload can only run while the session is idle. Wait for the current run to finish or abort it first.',
  },
  { name: 'mcp reloaded (one server)', input: '/reload-mcp github', code: 'hermes_mcp_reloaded', params: { server: 'github' }, message: 'MCP reloaded successfully. Server: github' },
  { name: 'mcp reloaded (all)', input: '/reload-mcp', code: 'hermes_mcp_reloaded', params: { server: null }, message: 'MCP reloaded successfully. All servers.' },
  {
    name: 'mcp reload failed', input: '/reload-mcp',
    bridge: { mcpReload: vi.fn(async () => { throw new Error('boom') }) },
    code: 'hermes_mcp_reload_failed', params: { error: 'boom' }, message: 'MCP reload failed: boom',
  },
  {
    name: 'skills reload busy', input: '/reload-skills', working: true,
    code: 'hermes_skills_reload_busy', message: 'Skills reload can only run while the session is idle. Wait for the current run to finish or abort it first.',
  },
  {
    name: 'skills reloaded without changes', input: '/reload-skills',
    code: 'hermes_skills_reloaded', params: { added: [], removed: [], total: 3 },
    message: 'Skills reloaded successfully.\nNo skill changes detected. Total skills: 3.',
  },
  {
    name: 'skills reloaded with changes', input: '/reload-skills',
    bridge: { reloadSkills: vi.fn(async () => ({ added: [{ name: 'deploy', description: 'Ship it' }], removed: ['old'], total: 4 })) },
    code: 'hermes_skills_reloaded', params: { added: ['deploy: Ship it'], removed: ['old'], total: 4 },
    message: 'Skills reloaded successfully.\nAdded skills:\n- deploy: Ship it\nRemoved skills:\n- old\nTotal skills: 4.',
  },
  {
    name: 'skills reload unsupported by the bridge', input: '/reload-skills',
    bridge: { reloadSkills: vi.fn(async () => { throw new Error('unknown action: skills_reload') }) },
    code: 'hermes_skills_reload_unsupported',
    message: 'Skills reload failed: The running Agent Bridge does not support /reload-skills yet. Restart the bridge and try again.',
  },
  {
    name: 'skills reload failed', input: '/reload-skills',
    bridge: { reloadSkills: vi.fn(async () => { throw new Error('disk full') }) },
    code: 'hermes_skills_reload_failed', params: { error: 'disk full' }, message: 'Skills reload failed: disk full',
  },
  { name: 'destroy', input: '/destroy', code: 'hermes_destroy_done', params: { stoppedRun: false }, message: 'Destroyed bridge agent.' },
  {
    name: 'destroy while running', input: '/destroy', working: true,
    code: 'hermes_destroy_done', params: { stoppedRun: true }, message: 'Destroyed bridge agent and stopped the active run.',
  },
  {
    name: 'destroy with the bridge unreachable', input: '/destroy',
    bridge: { destroy: vi.fn(async () => { throw new Error('ECONNREFUSED') }) },
    code: 'hermes_destroy_unreachable', params: { error: 'ECONNREFUSED' },
    message: 'Bridge agent was not reachable; cleared local session state. (ECONNREFUSED)',
  },
]

describe('hermes-v050:T6 Hermes session command receipts carry a stable code', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getSession.mockReturnValue({ id: 'session-1', profile: 'default', source: 'cli', model: 'test-model', provider: 'openrouter', title: 'Parent' })
    mocks.getSessionDetail.mockReturnValue({ messages: [{ role: 'user', content: 'Root prompt', timestamp: 1 }] })
    mocks.createBranchedSession.mockReturnValue({ id: 'child', fork_point_message_id: null })
    mocks.renameSession.mockReturnValue(true)
    mocks.clearSessionMessages.mockReturnValue(7)
    mocks.readConfigYamlForProfile.mockResolvedValue({})
    mocks.calcAndUpdateUsage.mockResolvedValue({ inputTokens: 10, outputTokens: 20 })
  })

  for (const scenario of scenarios) {
    it(`${scenario.name}: keeps the English message and ${scenario.code ? `adds ${scenario.code}` : 'adds no code'}`, async () => {
      scenario.setup?.()
      const { payloads } = await run(scenario)
      expect(payloads).toHaveLength(1)
      const payload = payloads[0]
      expect(payload.message).toBe(scenario.message)
      if (!scenario.code) {
        expect(payload.messageCode).toBeUndefined()
        expect(payload.messageParams).toBeUndefined()
        const stored = mocks.addMessage.mock.calls.map(([row]: [any]) => row).find(row => row.content === scenario.message)
        expect(stored).toBeTruthy()
        expect(stored.command_data ?? null).toBeNull()
        return
      }
      expect(payload.messageCode).toBe(scenario.code)
      if (scenario.params) expect(payload.messageParams).toEqual(scenario.params)
      else expect(payload.messageParams).toBeUndefined()

      // Persisted row: English content unchanged, code + params beside it.
      const stored = mocks.addMessage.mock.calls.map(([row]: [any]) => row).find(row => row.content === scenario.message)
      expect(stored).toEqual(expect.objectContaining({ session_id: 'session-1', role: 'command', content: scenario.message }))
      expect(JSON.parse(stored.command_data)).toEqual(
        scenario.params
          ? { messageCode: scenario.code, messageParams: scenario.params }
          : { messageCode: scenario.code },
      )
    })
  }

  it('does not code the echoed user command row', async () => {
    await run({ name: 'echo', input: '/title Sprint notes', code: 'hermes_title_updated', message: 'Title updated: Sprint notes' })
    const echo = mocks.addMessage.mock.calls.map(([row]: [any]) => row).find(row => row.content === '/title Sprint notes')
    expect(echo).toBeTruthy()
    expect(echo.command_data ?? null).toBeNull()
  })

  it('keeps code and params on the in-memory row used by resume snapshots', async () => {
    const { state } = await run({ name: 'queue', input: '/queue later', working: true, code: 'hermes_queue_queued', message: 'Queued message. Queue length: 1.' })
    const row = state.messages.find((message: any) => message.content === 'Queued message. Queue length: 1.')
    expect(row).toEqual(expect.objectContaining({ role: 'command', id: 501 }))
    expect(JSON.parse(row.command_data)).toEqual({ messageCode: 'hermes_queue_queued', messageParams: { length: 1 } })
  })
})
