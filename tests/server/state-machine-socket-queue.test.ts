import { beforeEach, describe, expect, it, vi } from 'vitest'

// Server-side session state machine regressions (state-machine review
// S-F6 / S-F7 / S-F9): queue dequeue failures, socket-less dequeue and the
// coding-agent start window must all keep `isWorking` and the queue coherent.

const handleBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const resumeBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
// The real handler returns `{ runId, messageId }` once a turn was sent and
// `undefined` only when the input was a slash command handled without a turn.
const startedCodingAgentRun = { runId: 'run-mock', messageId: 1 }
const handleCodingAgentRunMock = vi.hoisted(() => vi.fn(async (): Promise<any> => ({ runId: 'run-mock', messageId: 1 })))
const loadSessionStateFromDbMock = vi.hoisted(() => vi.fn())
const ensureReadyMock = vi.hoisted(() => vi.fn())
const codingAgentRunManagerMock = vi.hoisted(() => ({
  interruptForQueueInsertion: vi.fn(),
  resolveApproval: vi.fn(() => ({ handled: false, resolved: false })),
  resolveClarification: vi.fn(() => ({ handled: false, resolved: false })),
  isSessionProcessing: vi.fn(() => false),
  stop: vi.fn(),
}))
const sessionCommandMocks = vi.hoisted(() => ({
  handleSessionCommand: vi.fn(),
  isSessionCommand: vi.fn(() => false),
  parseSessionCommand: vi.fn(() => null),
}))
const bridgeMock = vi.hoisted(() => ({
  status: vi.fn(),
  statusIfLoaded: vi.fn(),
  interrupt: vi.fn(),
  requestBoundaryInterrupt: vi.fn(),
  approvalRespond: vi.fn(),
  releaseBackgroundNotification: vi.fn(async () => {}),
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
vi.mock('../../packages/server/src/modules/studio/services/chat-run/session-command', () => sessionCommandMocks)
vi.mock('../../packages/server/src/modules/hermes/services/bridge/index', () => ({
  AgentBridgeClient: vi.fn(() => bridgeMock),
}))
vi.mock('../../packages/server/src/modules/hermes/services/bridge/manager', () => ({
  getAgentBridgeManager: vi.fn(() => ({ ensureReady: ensureReadyMock })),
}))
vi.mock('../../packages/server/src/modules/ekko/services/manager', () => ({
  getGlobalEkkoAgent: vi.fn(() => ({ requestBoundaryInterrupt: vi.fn() })),
  hasGlobalEkkoBackgroundTasks: vi.fn(() => false),
  abortGlobalEkkoBackgroundTasks: vi.fn(async () => 0),
}))
vi.mock('../../packages/server/src/modules/coding-agents/services/runtime/run-manager', () => ({
  codingAgentRunManager: codingAgentRunManagerMock,
}))
vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
  createPrimaryAgentBridge: vi.fn(() => bridgeMock),
  getPrimaryAgentBridgeManager: vi.fn(() => ({ start: vi.fn(async () => {}), ensureReady: ensureReadyMock })),
  redactPrimaryAgentBridgeError: (error?: string) => error,
  chatCodingAgentRunManager: codingAgentRunManagerMock,
  handleChatCodingAgentSessionCommand: sessionCommandMocks.handleSessionCommand,
  parseChatCodingAgentSessionCommand: sessionCommandMocks.parseSessionCommand,
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
  clearSessionMessages: vi.fn(),
  getSession: vi.fn(() => ({ id: 'session-1', profile: 'default', source: 'cli' })),
  getSessionMetadata: vi.fn(() => ({ id: 'session-1', profile: 'default', source: 'cli' })),
  getSessionDetail: vi.fn(() => null),
}))
vi.mock('../../packages/server/src/modules/studio/repositories/workspace-run-changes-store', () => ({
  listWorkspaceRunChangesForAssistantMessages: vi.fn(() => []),
}))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  getActiveProfileName: vi.fn(() => 'default'),
  getProfileDir: vi.fn(() => '/tmp/hermes-default'),
  listProfileNamesFromDisk: vi.fn(() => ['default']),
}))
vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({
  authenticateUserToken: vi.fn(),
  isAuthEnabled: vi.fn(async () => false),
}))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
  userCanAccessProfile: vi.fn(() => true),
}))

function makeServerHarness(options: { withSocket?: boolean } = {}) {
  const withSocket = options.withSocket !== false
  const handlers = new Map<string, Function>()
  const sockets = new Map<string, any>()
  const roomEmit = vi.fn()
  const namespace = {
    adapter: { rooms: new Map(withSocket ? [['session:session-1', new Set(['socket-1'])]] : []) },
    sockets,
    emit: vi.fn(),
    to: vi.fn(() => ({ emit: roomEmit, except: vi.fn(() => ({ emit: roomEmit })) })),
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
    to: vi.fn(() => { const emit = vi.fn(); return { emit, except: vi.fn(() => ({ emit })) } }),
    on: vi.fn((event: string, handler: Function) => { handlers.set(event, handler) }),
  }
  if (withSocket) sockets.set(socket.id, socket)
  return { handlers, io, namespace, roomEmit, socket }
}

const failedPayloads = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls
  .filter(call => call[0] === 'run.failed')
  .map(call => call[1])

describe('server session state machine: queue and coding-agent start window', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    handleBridgeRunMock.mockReset()
    handleBridgeRunMock.mockResolvedValue(undefined)
    handleCodingAgentRunMock.mockReset()
    // Default: a real turn was started. Slash-command tests override with `undefined`.
    handleCodingAgentRunMock.mockResolvedValue(startedCodingAgentRun)
    ensureReadyMock.mockResolvedValue({ reachable: true, status: 'ready', endpoint: 'ipc:///tmp/hermes-agent-bridge.sock' })
    bridgeMock.statusIfLoaded.mockResolvedValue({ ok: true, exists: false, running: false, loaded: false })
    codingAgentRunManagerMock.isSessionProcessing.mockReturnValue(false)
    loadSessionStateFromDbMock.mockResolvedValue({ messages: [], isWorking: false, isAborting: false, events: [], queue: [] })
  })

  // S-F6: `runQueuedItem` fired `void this.handleRun(...)` without a catch.
  it('S-F6: a rejected queued run emits run.failed, releases the session and dequeues the next item', async () => {
    handleBridgeRunMock
      .mockRejectedValueOnce(new Error('queued run exploded'))
      .mockResolvedValueOnce(undefined)
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, roomEmit, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)
    const state = {
      messages: [], isWorking: true, isAborting: false, events: [], source: 'cli', profile: 'default',
      queue: [
        { queue_id: 'queue-first', input: 'first', profile: 'default', source: 'cli' },
        { queue_id: 'queue-second', input: 'second', profile: 'default', source: 'cli' },
      ],
    }
    ;(server as any).sessionMap.set('session-1', state)

    // The previous run finished; the server dequeues the first item, which rejects.
    expect((server as any).dequeueNextQueuedRun(socket, 'session-1', 'default')).toBe(true)

    await vi.waitFor(() => expect(handleBridgeRunMock).toHaveBeenCalledTimes(2))
    const failed = [...failedPayloads(roomEmit), ...failedPayloads(socket.emit)]
    expect(failed).toHaveLength(1)
    expect(failed[0]).toEqual(expect.objectContaining({
      event: 'run.failed',
      session_id: 'session-1',
      queue_id: 'queue-first',
      queue_remaining: 1,
      error: 'queued run exploded',
    }))
    // The second item was dequeued, so the session is legitimately working again.
    expect(handleBridgeRunMock.mock.calls[1]?.[2]).toEqual(expect.objectContaining({ queue_id: 'queue-second' }))
    expect(state.queue).toEqual([])
    expect(state.isWorking).toBe(true)
  })

  it('S-F6: a rejected queued run with an empty queue leaves the session idle', async () => {
    handleBridgeRunMock.mockRejectedValueOnce(new Error('last queued run exploded'))
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, roomEmit, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)
    const state = {
      messages: [], isWorking: true, isAborting: false, events: [], source: 'cli', profile: 'default',
      queue: [{ queue_id: 'queue-only', input: 'only', profile: 'default', source: 'cli' }],
    }
    ;(server as any).sessionMap.set('session-1', state)

    ;(server as any).dequeueNextQueuedRun(socket, 'session-1', 'default')

    await vi.waitFor(() => expect([...failedPayloads(roomEmit), ...failedPayloads(socket.emit)]).toHaveLength(1))
    expect(handleBridgeRunMock).toHaveBeenCalledTimes(1)
    expect(state.isWorking).toBe(false)
    expect(state.profile).toBeUndefined()
    expect(state.queue).toEqual([])
  })

  // S-F7: `socketForQueuedRun` returned null with no connected sockets and
  // `markExternalRunCompleted` silently skipped the dequeue.
  it('S-F7: coding-agent completion with no connected socket still dequeues via the background socket', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, namespace } = makeServerHarness({ withSocket: false })
    expect(namespace.sockets.size).toBe(0)
    const server = new ChatRunSocket(io as any)
    const state = {
      messages: [], isWorking: true, isAborting: false, events: [], source: 'coding_agent', webhookAgent: 'codex',
      profile: 'default', runId: 'run-codex',
      queue: [{
        queue_id: 'queue-offline', input: 'run me later', profile: 'default', source: 'coding_agent',
        codingAgentId: 'codex', originSocketId: 'socket-gone',
      }],
    }
    ;(server as any).sessionMap.set('session-1', state)

    server.markExternalRunCompleted('session-1', 'run.completed')

    await vi.waitFor(() => expect(handleCodingAgentRunMock).toHaveBeenCalledOnce())
    expect(handleCodingAgentRunMock.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      session_id: 'session-1',
      input: 'run me later',
      queue_id: 'queue-offline',
    }))
    expect(state.queue).toEqual([])
    expect(state.isWorking).toBe(true)
    // The fallback socket must be usable by the run handlers.
    const socketArg = handleCodingAgentRunMock.mock.calls[0]?.[1] as any
    expect(typeof socketArg?.join).toBe('function')
    expect(typeof socketArg?.emit).toBe('function')
  })

  // S-F9: the socket `run` handler set `isWorking = false` for coding agents
  // until `startCodingAgentRun` finished, so a rapid second message bypassed
  // the queue and hit the "still processing" error instead.
  it('S-F9: a second coding-agent message during the start window is queued, not started', async () => {
    let releaseFirst!: () => void
    handleCodingAgentRunMock.mockImplementationOnce(() => new Promise<any>(resolve => { releaseFirst = () => resolve(startedCodingAgentRun) }))
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, roomEmit, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)

    const first = handlers.get('run')?.({
      session_id: 'session-1', input: 'first', source: 'coding_agent', coding_agent_id: 'codex',
      queue_id: 'queue-first', client_message_id: 'cm-1',
    })
    await vi.waitFor(() => expect(handleCodingAgentRunMock).toHaveBeenCalledOnce())
    const state = (server as any).sessionMap.get('session-1')
    expect(state.isWorking).toBe(true)

    await handlers.get('run')?.({
      session_id: 'session-1', input: 'second', source: 'coding_agent', coding_agent_id: 'codex',
      queue_id: 'queue-second', client_message_id: 'cm-2',
    })

    expect(handleCodingAgentRunMock).toHaveBeenCalledOnce()
    expect(state.queue.map((item: any) => item.queue_id)).toEqual(['queue-second'])
    expect(roomEmit).toHaveBeenCalledWith('run.queued', expect.objectContaining({
      session_id: 'session-1', queue_id: 'queue-second', queue_length: 1,
    }))
    expect(failedPayloads(socket.emit)).toEqual([])

    releaseFirst()
    await first
  })

  it('S-F9 follow-up: a coding-agent slash command (handled without a turn) releases the session', async () => {
    // handleCodingAgentRun returns undefined for /compact-style commands.
    handleCodingAgentRunMock.mockResolvedValueOnce(undefined)
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)

    await handlers.get('run')?.({
      session_id: 'session-1', input: '/compact', source: 'coding_agent', coding_agent_id: 'codex', queue_id: 'queue-cmd',
    })

    const state = (server as any).sessionMap.get('session-1')
    expect(handleCodingAgentRunMock).toHaveBeenCalledOnce()
    expect(state.isWorking).toBe(false)
    expect(state.runStartedAt).toBeUndefined()
    expect(failedPayloads(socket.emit)).toEqual([])
  })

  it('S-F9 follow-up: a slash command while the runner is still processing keeps the session working', async () => {
    handleCodingAgentRunMock.mockResolvedValueOnce(undefined)
    codingAgentRunManagerMock.isSessionProcessing.mockReturnValueOnce(true)
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)

    await handlers.get('run')?.({
      session_id: 'session-1', input: '/compact', source: 'coding_agent', coding_agent_id: 'codex', queue_id: 'queue-cmd',
    })

    const state = (server as any).sessionMap.get('session-1')
    expect(state.isWorking).toBe(true)
  })

  it('S-F9: a coding-agent start failure with an empty queue releases the session', async () => {
    handleCodingAgentRunMock.mockRejectedValueOnce(new Error('spawn failed'))
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)

    await handlers.get('run')?.({
      session_id: 'session-1', input: 'first', source: 'coding_agent', coding_agent_id: 'codex', queue_id: 'queue-first',
    })

    const state = (server as any).sessionMap.get('session-1')
    expect(failedPayloads(socket.emit)).toEqual([expect.objectContaining({ queue_id: 'queue-first', error: 'spawn failed' })])
    expect(state.isWorking).toBe(false)
  })

  it('S-F9: a coding-agent start failure with queued items dequeues the next one', async () => {
    handleCodingAgentRunMock
      .mockRejectedValueOnce(new Error('spawn failed'))
      .mockResolvedValueOnce(startedCodingAgentRun)
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)
    ;(server as any).sessionMap.set('session-1', {
      messages: [], isWorking: false, isAborting: false, events: [], source: 'coding_agent', profile: 'default',
      queue: [],
    })
    const state = (server as any).sessionMap.get('session-1')

    // Simulate a message that got queued during the start window before the
    // start fails: push it while the first handler is pending.
    handleCodingAgentRunMock.mockReset()
    let failFirst!: (err: Error) => void
    handleCodingAgentRunMock
      .mockImplementationOnce(() => new Promise<any>((_resolve, reject) => { failFirst = reject }))
      .mockResolvedValueOnce(startedCodingAgentRun)
    const first = handlers.get('run')?.({
      session_id: 'session-1', input: 'first', source: 'coding_agent', coding_agent_id: 'codex', queue_id: 'queue-first',
    })
    await vi.waitFor(() => expect(handleCodingAgentRunMock).toHaveBeenCalledOnce())
    await handlers.get('run')?.({
      session_id: 'session-1', input: 'second', source: 'coding_agent', coding_agent_id: 'codex', queue_id: 'queue-second',
    })
    expect(state.queue.map((item: any) => item.queue_id)).toEqual(['queue-second'])

    failFirst(new Error('spawn failed'))
    await first

    await vi.waitFor(() => expect(handleCodingAgentRunMock).toHaveBeenCalledTimes(2))
    expect(handleCodingAgentRunMock.mock.calls[1]?.[2]).toEqual(expect.objectContaining({ queue_id: 'queue-second' }))
    expect(state.queue).toEqual([])
    expect(state.isWorking).toBe(true)
  })
})
