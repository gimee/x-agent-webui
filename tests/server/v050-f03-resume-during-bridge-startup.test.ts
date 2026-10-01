// hermes-v050:F-03 S5 starts the Agent Bridge after listen. A socket resume that arrives in that
// startup window (browsers reconnect right after a deploy) used to probe the not-yet-existing
// endpoint, fail with ENOENT and persist a run.reattach_failed warning that every later idle
// resume replayed. It now waits for that one start and only then asks the bridge.
import { mkdtempSync, rmSync } from 'fs'
import { createServer, type Server } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ manager: null as any, endpoint: '' }))
const resumeBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const loadSessionStateFromDbMock = vi.hoisted(() => vi.fn())
const getSessionMock = vi.hoisted(() => vi.fn((sessionId?: string) => sessionId
  ? { id: sessionId, profile: 'default', source: 'cli', model: 'gpt-test', provider: 'openai' }
  : undefined))

vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', async () => {
  const { AgentBridgeClient } = await import('../../packages/server/src/modules/hermes/services/bridge/client')
  return {
    createPrimaryAgentBridge: vi.fn((options?: Record<string, unknown>) => new AgentBridgeClient({ endpoint: runtime.endpoint, ...options })),
    getPrimaryAgentBridgeManager: vi.fn(() => runtime.manager),
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
  }
})

vi.mock('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run', () => ({
  handleBridgeRun: vi.fn(async () => {}),
  resumeBridgeRun: resumeBridgeRunMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/load-state', () => ({
  loadSessionStateFromDb: loadSessionStateFromDbMock,
  resolveRunSource: vi.fn((source?: string) => source || 'cli'),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/handle-coding-agent-run', () => ({
  handleCodingAgentRun: vi.fn(async () => {}),
}))

vi.mock('../../packages/server/src/modules/studio/services/webhooks', () => ({
  observeChatRunWebhookEvent: vi.fn(() => true),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/session-command', () => ({
  handleSessionCommand: vi.fn(),
  isSessionCommand: vi.fn(() => false),
  parseSessionCommand: vi.fn(() => null),
}))

// Keep the real bridge client/manager away from the live bridge.log.
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bridgeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
  listProfileNamesFromDisk: vi.fn(() => ['default']),
}))

vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({
  authenticateUserToken: vi.fn(),
  isAuthEnabled: vi.fn(async () => false),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
  userCanAccessProfile: vi.fn(() => true),
}))

const originalEnv = { ...process.env }
let dir = ''
let server: Server | undefined
const actions: string[] = []

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  process.env = { ...originalEnv }
  dir = mkdtempSync(join(tmpdir(), 'wui-f03-'))
  process.env.HERMES_HOME = dir
  process.env.HERMES_WEB_UI_HOME = join(dir, 'web')
  // Scaled-down production timings: the resume probe gives up after 200ms (5s in production)
  // while the start keeps attaching for 3s; the bridge endpoint shows up after 1.5s.
  process.env.HERMES_AGENT_BRIDGE_CONNECT_RETRY_MS = '200'
  process.env.HERMES_AGENT_BRIDGE_ATTACH_RETRY_MS = '3000'
  process.env.HERMES_AGENT_BRIDGE_ATTACH_TIMEOUT_MS = '1000'
  runtime.endpoint = `ipc://${join(dir, 'bridge.sock')}`
  runtime.manager = null
  actions.length = 0
  loadSessionStateFromDbMock.mockImplementation(async () => ({
    messages: [],
    isWorking: false,
    isAborting: false,
    runId: undefined,
    activeRunMarker: undefined,
    profile: 'default',
    source: 'cli',
    events: [],
    queue: [],
  }))
})

afterEach(async () => {
  vi.useRealTimers()
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  server = undefined
  process.env = { ...originalEnv }
  rmSync(dir, { recursive: true, force: true })
})

function startFakeBridgeAfter(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      server = createServer((socket) => {
        let buffer = ''
        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf8')
          if (!buffer.includes('\n')) return
          const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')))
          actions.push(request.action)
          const response = request.action === 'status_if_loaded'
            ? { ok: true, exists: false, loaded: false, running: false }
            : { ok: true, pong: request.action === 'ping' }
          socket.end(`${JSON.stringify(response)}\n`)
        })
      })
      server.listen(runtime.endpoint.slice('ipc://'.length), () => resolve())
    }, ms)
  })
}

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
  return { emitted, handlers, io, socket }
}

function resumedPayloads(socket: { emit: ReturnType<typeof vi.fn> }) {
  return socket.emit.mock.calls.filter(call => call[0] === 'resumed').map(call => call[1])
}

describe('hermes-v050:F-03 resume while the Agent Bridge is still starting after listen', () => {
  it('waits for the in-flight start, then checks the bridge: no ENOENT warning, nothing replayed later', async () => {
    const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    runtime.manager = new AgentBridgeManager({ endpoint: runtime.endpoint })
    const { emitted, handlers, io, socket } = makeServerHarness()
    const chat = new ChatRunSocket(io as any)
    ;(chat as any).onConnection(socket)

    const bridgeUp = startFakeBridgeAfter(1500)
    const bootStart = runtime.manager.start() // bootstrap: startAgentBridge() right after listen
    expect(runtime.manager.getRuntimeState().starting).toBe(true)
    const started = Date.now()
    await handlers.get('resume')?.({ session_id: 'session-1' })
    const elapsed = Date.now() - started
    await Promise.all([bootStart, bridgeUp])

    expect(emitted.filter(({ event }) => event === 'run.reattach_failed')).toEqual([])
    expect(resumedPayloads(socket)).toEqual([expect.objectContaining({ session_id: 'session-1', isWorking: false, events: [] })])
    expect((chat as any).sessionMap.get('session-1').events).toEqual([])
    // The status question was asked of the bridge that came up, after the shared attach ping.
    expect(actions).toEqual(['ping', 'status_if_loaded'])
    expect(elapsed).toBeGreaterThanOrEqual(1200)
    expect(elapsed).toBeLessThan(5000)

    // A later idle resume (another tab, a reconnect) has nothing to replay.
    await handlers.get('resume')?.({ session_id: 'session-1' })
    expect(resumedPayloads(socket)[1]).toEqual(expect.objectContaining({ events: [] }))
    expect(emitted.filter(({ event }) => event === 'run.reattach_failed')).toEqual([])
  }, 15_000)

  it('does not hold a resume forever when the start hangs, and still leaves no warning', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    runtime.manager = {
      start: vi.fn(() => new Promise<void>(() => {})),
      getRuntimeState: vi.fn(() => ({ starting: true, endpoint: runtime.endpoint })),
      ensureReady: vi.fn(),
    }
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { emitted, handlers, io, socket } = makeServerHarness()
    const chat = new ChatRunSocket(io as any)
    ;(chat as any).onConnection(socket)

    let resumed = false
    const resume = Promise.resolve(handlers.get('resume')?.({ session_id: 'session-1' })).then(() => { resumed = true })
    await vi.advanceTimersByTimeAsync(9_000)
    expect(resumed).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000)
    await resume

    expect(resumed).toBe(true)
    expect(actions).toEqual([])
    expect(emitted.filter(({ event }) => event === 'run.reattach_failed')).toEqual([])
    expect(resumedPayloads(socket)).toEqual([expect.objectContaining({ events: [] })])
  })

  it('still reports an unreachable bridge once its start has failed (not a startup-window case)', async () => {
    runtime.manager = {
      start: vi.fn(async () => { throw new Error('agent bridge exited before ready code=1 signal=null') }),
      getRuntimeState: vi.fn(() => ({ starting: true, endpoint: runtime.endpoint })),
      ensureReady: vi.fn(),
    }
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { emitted, handlers, io, socket } = makeServerHarness()
    const chat = new ChatRunSocket(io as any)
    ;(chat as any).onConnection(socket)

    await handlers.get('resume')?.({ session_id: 'session-1' })

    expect(runtime.manager.start).toHaveBeenCalledTimes(1)
    expect(emitted.filter(({ event }) => event === 'run.reattach_failed')).toHaveLength(1)
    expect(resumedPayloads(socket)[0].events).toEqual([expect.objectContaining({ event: 'run.reattach_failed' })])
  })
})
