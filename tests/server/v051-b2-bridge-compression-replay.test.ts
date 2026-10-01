// hermes-v051:B2 — Hermes 对话（bridge 压缩）：压缩完成（含失败）5 秒后，压缩事件从补推（重放）列表删除。
// Mock scaffolding copied from run-chat-bridge-final-context.test.ts.
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getSystemPromptMock = vi.fn()
const getSessionMock = vi.fn()
const createSessionMock = vi.fn()
const addMessageMock = vi.fn()
const updateSessionMock = vi.fn()
const updateSessionStatsMock = vi.fn()
const updateUsageMock = vi.fn()
const buildCompressedHistoryMock = vi.fn()
const buildDbHistoryMock = vi.fn()
const buildSnapshotAwareHistoryMock = vi.fn(async (_sessionId: string, _profile: string, history: any[]) => history)
const buildDbSnapshotAwareHistoryMock = vi.fn(async (sessionId: string, profile: string, options: any, modelContext: any) => (
  buildSnapshotAwareHistoryMock(
    sessionId,
    profile,
    await buildDbHistoryMock(sessionId, options),
    modelContext,
  )
))
// Faithful copies of compression.ts pushState/replaceState: the replay list is what this test inspects.
const pushStateMock = vi.fn((sessionMap: Map<string, any>, sessionId: string, event: string, data: any) => {
  sessionMap.get(sessionId)?.events.push({ event, data })
})
const replaceStateMock = vi.fn((sessionMap: Map<string, any>, sessionId: string, event: string, data: any) => {
  const state = sessionMap.get(sessionId)
  const idx = state ? state.events.findIndex((entry: any) => entry.event === event) : -1
  if (idx >= 0) state.events[idx] = { event, data }
  else pushStateMock(sessionMap, sessionId, event, data)
})
const forceCompressBridgeHistoryMock = vi.fn()
const calcAndUpdateUsageMock = vi.fn()
const estimateUsageTokensFromMessagesMock = vi.fn()
const updateContextTokenUsageMock = vi.fn((sid: string, state: any, emit: any, contextTokens: number, usage?: { inputTokens: number; outputTokens: number }) => {
  state.contextTokens = contextTokens
  emit('usage.updated', {
    event: 'usage.updated',
    session_id: sid,
    inputTokens: usage?.inputTokens ?? state.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? state.outputTokens ?? 0,
    contextTokens,
  })
  return contextTokens
})
const getCachedBridgeContextOverheadMock = vi.fn(() => undefined)
const contextTokensWithCachedOverheadMock = vi.fn((_state: any, messageTokens: number) => messageTokens)
const updateMessageContextTokenUsageMock = vi.fn((sid: string, state: any, emit: any, messageTokens: number, usage?: { inputTokens: number; outputTokens: number }) => updateContextTokenUsageMock(sid, state, emit, messageTokens, usage))
const flushBridgePendingToDbMock = vi.fn()
const ensureOpenBridgeAssistantMessageMock = vi.fn()
const syncBridgeReasoningToMessageMock = vi.fn()
const recordBridgeToolStartedMock = vi.fn()
const recordBridgeToolCompletedMock = vi.fn()
const recordBridgeMoaDisplayToolMock = vi.fn()
const resolveBridgeRunModelConfigMock = vi.fn()
const issueModelRunJwtMock = vi.fn(async () => 'model-run-token')
const startWorkspaceRunCheckpointMock = vi.fn()
const completeWorkspaceRunCheckpointMock = vi.fn()
const homes: string[] = []

vi.mock('../../packages/server/src/modules/studio/public/runs/prompt', () => ({
  getSystemPrompt: getSystemPromptMock,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSession: getSessionMock,
  createSession: createSessionMock,
  addMessage: addMessageMock,
  updateSession: updateSessionMock,
  updateSessionStats: updateSessionStatsMock,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/usage-store', () => ({
  updateUsage: updateUsageMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bridgeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/compression', () => ({
  buildCompressedHistory: buildCompressedHistoryMock,
  buildDbHistory: buildDbHistoryMock,
  buildSnapshotAwareHistory: buildSnapshotAwareHistoryMock,
  buildDbSnapshotAwareHistory: buildDbSnapshotAwareHistoryMock,
  pushState: pushStateMock,
  replaceState: replaceStateMock,
  forceCompressBridgeHistory: forceCompressBridgeHistoryMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  calcAndUpdateUsage: calcAndUpdateUsageMock,
  estimateUsageTokensFromMessages: estimateUsageTokensFromMessagesMock,
  getCachedBridgeContextOverhead: getCachedBridgeContextOverheadMock,
  contextTokensWithCachedOverhead: contextTokensWithCachedOverheadMock,
  updateContextTokenUsage: updateContextTokenUsageMock,
  updateMessageContextTokenUsage: updateMessageContextTokenUsageMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/bridge-message', () => ({
  flushBridgePendingToDb: flushBridgePendingToDbMock,
  ensureOpenBridgeAssistantMessage: ensureOpenBridgeAssistantMessageMock,
  syncBridgeReasoningToMessage: syncBridgeReasoningToMessageMock,
  recordBridgeToolStarted: recordBridgeToolStartedMock,
  recordBridgeToolCompleted: recordBridgeToolCompletedMock,
  recordBridgeMoaDisplayTool: recordBridgeMoaDisplayToolMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/model-config', () => ({
  resolveBridgeRunModelConfig: resolveBridgeRunModelConfigMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/workspace-diff-tracker', () => ({
  startWorkspaceRunCheckpoint: startWorkspaceRunCheckpointMock,
  completeWorkspaceRunCheckpoint: completeWorkspaceRunCheckpointMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  getProfileDir: (profile: string) => `/tmp/hermes-bridge-final-context/${profile || 'default'}`,
}))

vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({
  issueModelRunJwt: issueModelRunJwtMock,
}))

function makeSocket() {
  return {
    connected: true,
    emit: vi.fn(),
    join: vi.fn(),
    to: vi.fn(() => ({ emit: vi.fn() })),
    data: {},
  } as any
}

function makeNamespace(emit: ReturnType<typeof vi.fn>) {
  const room = new Set(['socket-1'])
  return {
    adapter: { rooms: new Map([['session:session-1', room]]) },
    to: vi.fn(() => ({ emit })),
  } as any
}

function makeState() {
  return {
    messages: [],
    isWorking: false,
    events: [],
    queue: [],
  } as any
}


const replayed = (state: any) => state.events.map((entry: any) => entry.event).filter((event: string) => event.startsWith('compression.'))

async function flushIo(until: () => boolean, label: string) {
  for (let i = 0; i < 1_000; i++) {
    if (until()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function runBridgeCompression(compressionEvents: any[]) {
  const emit = vi.fn()
  const nsp = makeNamespace(emit)
  const socket = makeSocket()
  const state = makeState()
  const sessionMap = new Map([['session-1', state]])
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const bridge = {
    chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
    contextEstimate: vi.fn().mockResolvedValue({ token_count: 12345, fixed_context_tokens: 12327, message_count: 2, tool_count: 4, system_prompt_chars: 13 }),
    compressionRespond: vi.fn().mockResolvedValue(undefined),
    streamOutput: vi.fn(async function* () {
      for (const event of compressionEvents) yield { run_id: 'run-1', done: false, status: 'running', events: [event] }
      await gate
      yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
    }),
  } as any
  const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
  let settled = false
  const running = handleBridgeRun(nsp, socket, { input: 'hello', session_id: 'session-1' }, 'default', sessionMap, bridge, false, vi.fn(), vi.fn())
    .finally(() => { settled = true })
  const finish = async () => {
    release()
    for (let i = 0; i < 200 && !settled; i++) {
      await vi.advanceTimersByTimeAsync(1_000)
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(settled).toBe(true)
    await running
  }
  return { state, emit, finish }
}

describe('hermes-v051:B2 bridge compression replay', () => {
  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-v051-b2-bridge-'))
    homes.push(home)
    process.env.HERMES_WEB_UI_HOME = home
    vi.clearAllMocks()
    getSystemPromptMock.mockReturnValue('system prompt')
    issueModelRunJwtMock.mockResolvedValue('model-run-token')
    getSessionMock.mockReturnValue({ id: 'session-1', profile: 'default', model: '', provider: '' })
    resolveBridgeRunModelConfigMock.mockResolvedValue({ model: 'gpt-test', provider: 'openai' })
    buildCompressedHistoryMock.mockResolvedValue([{ role: 'user', content: 'previous' }])
    buildSnapshotAwareHistoryMock.mockImplementation(async (_sessionId: string, _profile: string, history: any[]) => history)
    buildDbHistoryMock.mockResolvedValue([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'done' },
    ])
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 11, outputTokens: 7 })
    estimateUsageTokensFromMessagesMock.mockReturnValue({ inputTokens: 11, outputTokens: 7 })
    completeWorkspaceRunCheckpointMock.mockReturnValue(null)
    ensureOpenBridgeAssistantMessageMock.mockImplementation((state: any, sessionId: string, runMarker: string) => {
      const message = { id: state.messages.length + 1, session_id: sessionId, runMarker, role: 'assistant', content: '', timestamp: 0 }
      state.messages.push(message)
      return message
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
    delete process.env.HERMES_WEB_UI_HOME
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  it('drops started/completed from the replay list 5s after the bridge compression completes', async () => {
    const { state, emit, finish } = await runBridgeCompression([
      { event: 'bridge.compression.requested', message_count: 2, approx_tokens: 9_000 },
      { event: 'bridge.compression.completed', message_count: 2, approx_tokens: 9_000, compressed: true },
    ])
    await flushIo(() => replayed(state).includes('compression.completed'), 'compression.completed')
    expect(emit).toHaveBeenCalledWith('compression.completed', expect.objectContaining({ compressed: true, source: 'bridge' }))
    expect(replayed(state)).toEqual(['compression.started', 'compression.completed'])

    await vi.advanceTimersByTimeAsync(4_999)
    expect(replayed(state)).toEqual(['compression.started', 'compression.completed'])
    await vi.advanceTimersByTimeAsync(1)
    expect(replayed(state)).toEqual([])
    expect(state.isWorking).toBe(true)
    await finish()
  })

  it('drops a failed bridge compression 5s later as well', async () => {
    const { state, finish } = await runBridgeCompression([
      { event: 'bridge.compression.requested', message_count: 2, approx_tokens: 9_000 },
      { event: 'bridge.compression.failed', message_count: 2, approx_tokens: 9_000, error: 'summary failed' },
    ])
    await flushIo(() => replayed(state).includes('compression.completed'), 'compression.completed')
    expect(state.events.find((entry: any) => entry.event === 'compression.completed')?.data).toEqual(expect.objectContaining({ compressed: false, error: 'summary failed' }))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(replayed(state)).toEqual([])
    await finish()
  })
})
