// hermes-v050:S8 resume 的 min_turns 合同：新客户端请求时空闲会话一次带够 N 轮；旧客户端（不传）与运行中会话逐字段不变。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSessionDetailPaginatedMock = vi.hoisted(() => vi.fn())
const countSessionRowsForTurnsMock = vi.hoisted(() => vi.fn())

const handleBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const resumeBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const handleCodingAgentRunMock = vi.hoisted(() => vi.fn(async () => {}))
const loadSessionStateFromDbMock = vi.hoisted(() => vi.fn())
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
    start: vi.fn(async () => {}),
    ensureReady: ensureReadyMock,
    getRuntimeState: getRuntimeStateMock,
  })),
  redactPrimaryAgentBridgeError: (error?: string) => error,
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
  getSessionDetailPaginated: getSessionDetailPaginatedMock,
  countSessionRowsForTurns: countSessionRowsForTurnsMock,
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

const row = (id: number, role: string, content = `${role} ${id}`) => ({
  id, session_id: 's1', role, content, timestamp: id, ...(role === 'tool' ? { tool_call_id: `call-${id}` } : {}),
})
// 内存窗口：最新 150 行全是 tool（进行中的 coding-agent 长轮次），数据库里更早还有 1000 行
const newestPage = Array.from({ length: 150 }, (_, index) => row(1001 + index, 'tool'))
const olderRows = [row(900, 'user', 'question'), ...Array.from({ length: 100 }, (_, index) => row(901 + index, 'tool', index === 0 ? 'y'.repeat(4_000) : `tool ${index}`))]

function idleState(overrides: Record<string, unknown> = {}) {
  return {
    messages: newestPage, events: [], queue: [], isWorking: false, profile: 'default',
    messageTotal: 1150, messageLoadedCount: 150, messagePageLimit: 150, messageStateBaselineCount: 150,
    ...overrides,
  }
}

async function resume(state: Record<string, unknown>, request: Record<string, unknown>) {
  const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
  const { handlers, io, socket } = makeServerHarness()
  ;(socket.data as any).user = { id: 1, username: 'admin', role: 'super_admin' }
  const server = new ChatRunSocket(io as any)
  ;(server as any).sessionMap.set('s1', state)
  ;(server as any).onConnection(socket)
  await handlers.get('resume')?.({ session_id: 's1', ...request })
  const resumed = socket.emit.mock.calls.find((call: any[]) => call[0] === 'resumed')
  expect(resumed).toBeTruthy()
  return resumed![1]
}

describe('resume min_turns contract (S8)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    getSessionDetailPaginatedMock.mockReset()
    countSessionRowsForTurnsMock.mockReset()
    bridgeMock.statusIfLoaded.mockReset()
    bridgeMock.statusIfLoaded.mockResolvedValue({ running: false })
    ensureReadyMock.mockResolvedValue({ reachable: true, status: 'ready', endpoint: 'ipc:///tmp/hermes-agent-bridge.sock' })
    getRuntimeStateMock.mockReturnValue({ endpoint: 'ipc:///tmp/hermes-agent-bridge.sock' })
    countSessionRowsForTurnsMock.mockReturnValue(101)
    getSessionDetailPaginatedMock.mockImplementation((_sid: string, offset: number, limit: number) => ({
      session: { id: 's1' }, messages: olderRows.slice(0, limit), total: 1150, offset, limit, hasMore: offset + limit < 1150,
    }))
  })

  it('sends older rows for an idle session when the client asks for min_turns', async () => {
    const payload = await resume(idleState(), { min_turns: 10 })
    expect(countSessionRowsForTurnsMock).toHaveBeenCalledWith('s1', 150, 10, expect.any(Number))
    expect(getSessionDetailPaginatedMock).toHaveBeenCalledWith('s1', 150, 101)
    // 最新页不变；更早的行放在 olderMessages，分页游标覆盖两段
    expect(payload.messages.map((message: any) => message.id)).toEqual(newestPage.map(message => message.id))
    expect(payload.olderMessages.map((message: any) => message.id)).toEqual(olderRows.map(message => message.id))
    expect(payload.olderMessages[1]).toMatchObject({ content_truncated: true })
    expect(payload).toMatchObject({ messageLoadedCount: 251, messageTotal: 1150, hasMoreBefore: true, messagePageOffset: 0 })
  })

  it('keeps the old payload for old clients that do not send min_turns', async () => {
    const payload = await resume(idleState(), {})
    expect(countSessionRowsForTurnsMock).not.toHaveBeenCalled()
    expect(getSessionDetailPaginatedMock).not.toHaveBeenCalled()
    expect('olderMessages' in payload).toBe(false)
    expect(payload).toMatchObject({ messageLoadedCount: 150, messageTotal: 1150, hasMoreBefore: true })
  })

  it('does not extend a working session (its live tail is still changing)', async () => {
    const payload = await resume(idleState({ isWorking: true }), { min_turns: 10 })
    expect(getSessionDetailPaginatedMock).not.toHaveBeenCalled()
    expect('olderMessages' in payload).toBe(false)
    expect(payload.messageLoadedCount).toBe(150)
  })

  it('falls back to the plain page when the older read fails', async () => {
    getSessionDetailPaginatedMock.mockImplementation(() => { throw new Error('SQLite database is unavailable') })
    const payload = await resume(idleState(), { min_turns: 10 })
    expect('olderMessages' in payload).toBe(false)
    expect(payload).toMatchObject({ messageLoadedCount: 150, hasMoreBefore: true })
  })
})
