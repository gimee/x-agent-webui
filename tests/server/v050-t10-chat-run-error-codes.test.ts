// hermes-v050:T10 — run.failed / run.reattach_failed 在原英文 error 之外带稳定的 error_code + error_params，
// 客户端据此映射到 chat.errors.*；原 error / message / text 文本保持不变。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handleBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const resumeBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const handleCodingAgentRunMock = vi.hoisted(() => vi.fn(async () => {}))
const observeChatRunWebhookEventMock = vi.hoisted(() => vi.fn(() => true))
const loadSessionStateFromDbMock = vi.hoisted(() => vi.fn())
const startBridgeMock = vi.hoisted(() => vi.fn())
const ensureReadyMock = vi.hoisted(() => vi.fn())
const getRuntimeStateMock = vi.hoisted(() => vi.fn())
const userCanAccessProfileMock = vi.hoisted(() => vi.fn((_user: unknown, _profile: string) => true))
const getSessionMock = vi.hoisted(() => vi.fn((sessionId?: string) => sessionId
  ? { id: sessionId, profile: 'default', source: 'cli', model: 'gpt-test', provider: 'openai' }
  : undefined))
const bridgeMock = vi.hoisted(() => ({
  status: vi.fn(),
  statusIfLoaded: vi.fn(),
  releaseBackgroundNotification: vi.fn(async () => ({ ok: true, released: true })),
  close: vi.fn(async () => {}),
  approvalRespond: vi.fn(async () => ({ resolved: true })),
  clarifyRespond: vi.fn(async () => ({ resolved: true })),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run', () => ({
  handleBridgeRun: handleBridgeRunMock,
  resumeBridgeRun: resumeBridgeRunMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/load-state', () => ({
  loadSessionStateFromDb: loadSessionStateFromDbMock,
  resolveRunSource: vi.fn((source?: string) => source || 'cli'),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/handle-coding-agent-run', () => ({
  handleCodingAgentRun: handleCodingAgentRunMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/webhooks', () => ({
  observeChatRunWebhookEvent: observeChatRunWebhookEventMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/session-command', () => ({
  handleSessionCommand: vi.fn(),
  isSessionCommand: vi.fn(() => false),
  parseSessionCommand: vi.fn(() => null),
}))

vi.mock('../../packages/server/src/modules/hermes/services/bridge/index', () => ({
  AgentBridgeClient: vi.fn(() => bridgeMock),
}))

vi.mock('../../packages/server/src/modules/hermes/services/bridge/manager', () => ({
  getAgentBridgeManager: vi.fn(() => ({
    ensureReady: ensureReadyMock,
    getRuntimeState: getRuntimeStateMock,
  })),
}))

vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
  createPrimaryAgentBridge: vi.fn(() => bridgeMock),
  getPrimaryAgentBridgeManager: vi.fn(() => ({
    start: startBridgeMock,
    ensureReady: ensureReadyMock,
    getRuntimeState: getRuntimeStateMock,
  })),
  redactPrimaryAgentBridgeError: (error?: string, endpoint?: string, replacement = '[redacted endpoint]') => {
    if (!error) return error
    const values = [endpoint, endpoint?.replace(/^(?:ipc|tcp):\/\//, '')].filter(Boolean) as string[]
    return values.reduce((value, candidate) => value.split(candidate).join(replacement), error)
  },
  chatCodingAgentRunManager: {
    resolveApproval: vi.fn(() => ({ handled: false, resolved: false })),
    resolveClarification: vi.fn(() => ({ handled: false, resolved: false })),
    stop: vi.fn(),
  },
  handleChatCodingAgentSessionCommand: vi.fn(),
  parseChatCodingAgentSessionCommand: vi.fn(() => null),
  getChatEkkoAgent: vi.fn(() => ({ requestBoundaryInterrupt: vi.fn() })),
  respondToChatEkkoToolApproval: vi.fn(() => ({ handled: false, resolved: false })),
  respondToChatEkkoClarification: vi.fn(() => ({ handled: false, resolved: false })),
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/public/runs/prompt', () => ({
  getSystemPrompt: vi.fn(() => 'system prompt'),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSession: getSessionMock,
  getSessionMetadata: getSessionMock,
  getSessionDetail: vi.fn(() => null),
}))

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  getActiveProfileName: vi.fn(() => 'default'),
  getProfileDir: vi.fn(() => '/tmp/hermes-default'),
  listProfileNamesFromDisk: vi.fn(() => ['default', 'research']),
}))

vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({
  authenticateUserToken: vi.fn(),
  isAuthEnabled: vi.fn(async () => false),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
  userCanAccessProfile: userCanAccessProfileMock,
}))

function makeServerHarness() {
  const handlers = new Map<string, Function>()
  const emitted: Array<{ room: string; event: string; payload: any }> = []
  const namespace = {
    adapter: { rooms: new Map() },
    to: vi.fn((room: string) => ({
      emit: vi.fn((event: string, payload: any) => emitted.push({ room, event, payload })),
    })),
    use: vi.fn(),
    on: vi.fn(),
  }
  const io = { of: vi.fn(() => namespace) }
  const socket = {
    id: 'socket-1',
    connected: true,
    handshake: { auth: {}, query: { profile: 'default' } },
    data: {},
    emit: vi.fn(),
    join: vi.fn(),
    to: vi.fn(() => ({ emit: vi.fn() })),
    on: vi.fn((event: string, handler: Function) => {
      handlers.set(event, handler)
    }),
  }
  return { emitted, handlers, io, namespace, socket }
}


function resetCommonMocks() {
  vi.clearAllMocks()
  startBridgeMock.mockReset()
  startBridgeMock.mockResolvedValue(undefined)
  ensureReadyMock.mockReset()
  getRuntimeStateMock.mockReset()
  bridgeMock.statusIfLoaded.mockReset()
  handleBridgeRunMock.mockReset()
  resumeBridgeRunMock.mockReset()
  loadSessionStateFromDbMock.mockReset()
  getSessionMock.mockReset()
  getSessionMock.mockImplementation((sessionId?: string) => sessionId
    ? { id: sessionId, profile: 'default', source: 'cli', model: 'gpt-test', provider: 'openai' }
    : undefined)
  ensureReadyMock.mockResolvedValue({ reachable: true, status: 'ready', endpoint: 'ipc:///tmp/hermes-agent-bridge.sock' })
  getRuntimeStateMock.mockReturnValue({ endpoint: 'ipc:///tmp/hermes-agent-bridge.sock' })
  bridgeMock.statusIfLoaded.mockResolvedValue({ ok: true, exists: false, running: false, loaded: false })
  loadSessionStateFromDbMock.mockResolvedValue({ messages: [], isWorking: false, isAborting: false, events: [], queue: [] })
}

async function runOnce(input: Record<string, unknown>) {
  const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
  const { handlers, io, socket, emitted } = makeServerHarness()
  const server = new ChatRunSocket(io as any)
  ;(server as any).onConnection(socket)
  await handlers.get('run')?.(input)
  return { socket, emitted, server }
}

describe('hermes-v050:T10 run.failed carries a stable error code', () => {
  beforeEach(resetCommonMocks)

  it('codes an unreachable Agent Bridge and keeps the English error', async () => {
    ensureReadyMock.mockResolvedValueOnce({ reachable: false, status: 'unreachable', endpoint: 'ipc:///tmp/hermes-agent-bridge.sock', error: 'bridge offline' })
    const { socket } = await runOnce({ input: 'hello', session_id: 'session-1', source: 'cli' })
    expect(handleBridgeRunMock).not.toHaveBeenCalled()
    expect(socket.emit).toHaveBeenCalledWith('run.failed', {
      event: 'run.failed',
      session_id: 'session-1',
      error: 'Agent Bridge is not reachable: bridge offline',
      error_code: 'agent_bridge_unreachable',
      error_params: { detail: 'bridge offline' },
    })
  })

  it('codes an unavailable Runtime with its recorded reason', async () => {
    const previousSource = process.env.HERMES_RUNTIME_SOURCE
    process.env.HERMES_RUNTIME_SOURCE = 'none'
    const registry = await import('../../packages/server/src/modules/studio/public/agent-status-registry')
    registry.updateAgentStatus('hermes', { installed: false, source: 'not-installed', error: 'Runtime 0.21.0 is missing python/run_agent.py' })
    try {
      const { socket } = await runOnce({ input: 'hello', session_id: 'session-1', source: 'cli' })
      expect(socket.emit).toHaveBeenCalledWith('run.failed', expect.objectContaining({
        error: 'Hermes Runtime is unavailable: Runtime 0.21.0 is missing python/run_agent.py',
        error_code: 'hermes_runtime_unavailable',
        error_params: { detail: 'Runtime 0.21.0 is missing python/run_agent.py' },
      }))
    } finally {
      if (previousSource === undefined) delete process.env.HERMES_RUNTIME_SOURCE
      else process.env.HERMES_RUNTIME_SOURCE = previousSource
      registry.resetAgentStatusRegistryForTests()
    }
  })

  it('codes a missing Runtime (no recorded reason) as not installed', async () => {
    const previousSource = process.env.HERMES_RUNTIME_SOURCE
    process.env.HERMES_RUNTIME_SOURCE = 'none'
    const registry = await import('../../packages/server/src/modules/studio/public/agent-status-registry')
    registry.updateAgentStatus('hermes', { installed: false, source: 'not-installed', error: '' })
    try {
      const { socket } = await runOnce({ input: 'hello', session_id: 'session-1', source: 'cli' })
      const payload = socket.emit.mock.calls.find(([event]: [string]) => event === 'run.failed')?.[1]
      expect(payload).toEqual(expect.objectContaining({
        error: 'Hermes Runtime is unavailable: Hermes Runtime is not installed or is incomplete. Open Runtime Manager to repair or download a Runtime.',
        error_code: 'hermes_runtime_not_installed',
      }))
      expect(payload.error_params).toBeUndefined()
    } finally {
      if (previousSource === undefined) delete process.env.HERMES_RUNTIME_SOURCE
      else process.env.HERMES_RUNTIME_SOURCE = previousSource
      registry.resetAgentStatusRegistryForTests()
    }
  })

  it('codes the reattach warning and keeps its English message / text', async () => {
    bridgeMock.statusIfLoaded.mockRejectedValueOnce(new Error('connect ECONNREFUSED ipc:///tmp/hermes-agent-bridge.sock'))
    loadSessionStateFromDbMock.mockResolvedValueOnce({
      messages: [], isWorking: false, isAborting: true, runId: 'stale-run', activeRunMarker: 'marker-1',
      profile: 'default', source: 'cli', events: [{ event: 'run.started', data: { run_id: 'stale-run' } }], queue: [],
    })
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { emitted, handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)
    await handlers.get('resume')?.({ session_id: 'session-1' })
    const reattach = emitted.find(({ event }) => event === 'run.reattach_failed')?.payload
    expect(reattach).toEqual({
      event: 'run.reattach_failed',
      session_id: 'session-1',
      error: 'connect ECONNREFUSED configured endpoint',
      message: 'Unable to confirm Agent Bridge status while resuming: connect ECONNREFUSED configured endpoint',
      text: 'Unable to confirm Agent Bridge status while resuming: connect ECONNREFUSED configured endpoint',
      error_code: 'agent_bridge_status_unconfirmed',
      error_params: { detail: 'connect ECONNREFUSED configured endpoint' },
    })
  })
})
