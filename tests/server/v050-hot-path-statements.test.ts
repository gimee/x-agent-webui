import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

// hermes-v050:S12 — streaming hot path: getSession reuses one prepared
// statement per connection, run-manager checks the session row once per turn
// instead of on every delta, and emitExternalEvent only reads the session row
// when the in-memory state cannot answer (source / webhook agent).

const DB_MODULE = '../../packages/server/src/modules/studio/infrastructure/database/index'
const SESSION_LOOKUP = /^\s*SELECT \* FROM sessions WHERE id = \?\s*$/

let current: any = null
let prepared: string[] = []
let executed: string[] = []

function countingDb(target: any) {
  return new Proxy(target, {
    get(obj, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          prepared.push(sql)
          const statement = obj.prepare(sql)
          return new Proxy(statement, {
            get(stmt, key) {
              const value = stmt[key]
              if (typeof value !== 'function') return value
              if (key === 'get' || key === 'all' || key === 'run') {
                return (...args: unknown[]) => {
                  executed.push(sql)
                  return value.apply(stmt, args)
                }
              }
              return value.bind(stmt)
            },
          })
        }
      }
      const value = obj[prop]
      return typeof value === 'function' ? value.bind(obj) : value
    },
  })
}

const sessionLookups = () => executed.filter(sql => SESSION_LOOKUP.test(sql)).length

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bridgeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

async function openDb() {
  const { DatabaseSync } = await import('node:sqlite')
  return countingDb(new DatabaseSync(':memory:'))
}

describe('hermes-v050:S12 streaming hot path', () => {
  beforeEach(async () => {
    vi.resetModules()
    prepared = []
    executed = []
    current = await openDb()
    vi.doMock(DB_MODULE, () => ({
      getDb: () => current,
      isSqliteAvailable: () => true,
      getStoragePath: () => ':memory:',
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
  })

  afterEach(() => {
    current?.close()
    current = null
    vi.doUnmock(DB_MODULE)
    vi.resetModules()
  })

  it('getSession prepares its statement once per connection', async () => {
    const store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    store.createSession({ id: 's1', profile: 'default', source: 'cli', title: 'one' })
    prepared = []
    expect(store.getSession('s1')?.title).toBe('one')
    expect(store.getSession('s1')?.id).toBe('s1')
    expect(store.getSession('missing')).toBeNull()
    expect(prepared.filter(sql => SESSION_LOOKUP.test(sql))).toHaveLength(0)

    // A new connection (closeDb/getDb) gets its own statement.
    const previous = current
    current = await openDb()
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    store.createSession({ id: 's2', profile: 'default', source: 'cli', title: 'two' })
    expect(store.getSession('s2')?.title).toBe('two')
    expect(store.getSession('s1')).toBeNull()
    previous.close()
  })

  it('run-manager checks the session row once per turn, not on every streamed delta', async () => {
    const store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const responseStream = await import('../../packages/server/src/modules/studio/services/chat-run/response-stream')
    const responseUtils = await import('../../packages/server/src/modules/studio/services/chat-run/response-utils')
    const { configureRunState } = await import('../../packages/server/src/modules/studio/public/run-state')
    const emitted: string[] = []
    configureRunState({
      applyResponseStreamEvent: responseStream.applyResponseStreamEvent,
      calcAndUpdateUsage: async () => ({}),
      completeWorkspaceRunCheckpoint: () => null,
      extractResponseText: responseUtils.extractResponseText,
      flushResponseRunToDb: responseStream.flushResponseRunToDb,
      getChatRunServer: () => ({ emitExternalEvent: (_sid: string, event: string) => { emitted.push(event) }, markExternalRunCompleted: () => {} }),
      getOrCreateSession: () => ({ messages: [], isWorking: false, events: [], queue: [] }),
      startWorkspaceRunCheckpoint: () => undefined,
      updateContextTokenUsage: () => undefined,
    })
    const { CodingAgentRunManager } = await import('../../packages/server/src/modules/coding-agents/services/runtime/run-manager')
    const manager = new CodingAgentRunManager(60_000)
    manager.start({
      agentSessionId: 'agent-s1',
      agentId: 'claude-code',
      mode: 'global',
      profile: 'default',
      provider: 'anthropic',
      model: 'claude-test',
      sessionId: 's1',
      command: process.execPath,
      args: [],
      shellCommand: '',
      workspaceDir: process.cwd(),
    })
    expect(store.getSession('s1')?.source).toBe('coding_agent')
    const run = (manager as any).getBySession('s1')
    // A turn in progress (what startClaudePrintTurn sets up before spawning).
    Object.assign(run, {
      printResponseId: 'resp_1', printMessageId: 'msg_resp_1', printTextStarted: false, printText: '',
      printSegmentText: '', printCompleted: false, responseStartEmitted: false, terminalEventHandled: false,
      printToolBlocks: new Map(),
    })
    const line = (event: unknown) => (manager as any).handleClaudePrintLine(run, JSON.stringify({ type: 'stream_event', event }))
    line({ type: 'message_start', message: { id: 'resp_1' } })
    line({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })
    executed = []
    for (let index = 0; index < 20; index += 1) {
      line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `d${index} ` } })
    }
    expect(emitted.filter(event => event === 'message.delta')).toHaveLength(20)
    expect(sessionLookups()).toBe(0)

    // The next turn re-checks, so a row deleted in between is recreated.
    store.deleteSession('s1')
    ;(manager as any).ensureDbSession(run, { recheck: true })
    expect(store.getSession('s1')?.source).toBe('coding_agent')
    manager.shutdown()
  })

  it('emitExternalEvent reads the session row only when the run state lacks source or agent', async () => {
    const webhookCalls: any[] = []
    vi.doMock('../../packages/server/src/modules/studio/services/webhooks', () => ({
      observeChatRunWebhookEvent: (input: any) => { webhookCalls.push(input) },
    }))
    vi.doMock('../../packages/server/src/modules/hermes/services/bridge/index', () => ({ AgentBridgeClient: vi.fn(() => ({})) }))
    vi.doMock('../../packages/server/src/modules/hermes/services/bridge/manager', () => ({ getAgentBridgeManager: vi.fn(() => ({})) }))
    const store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    store.createSession({ id: 's1', profile: 'default', source: 'coding_agent', agent: 'codex', title: 'codex' })
    const { configureChatAgentRuntime } = await import('../../packages/server/src/modules/studio/public/chat-agent-runtime')
    configureChatAgentRuntime({
      createPrimaryAgentBridge: () => ({}),
      getPrimaryAgentBridgeManager: () => ({}),
      redactPrimaryAgentBridgeError: (error?: string) => error,
      codingAgentRunManager: { hasSession: () => false, stop: () => false },
      sendCodingAgentRunInput: vi.fn(),
      startCodingAgentRun: vi.fn(),
      handleCodingAgentSessionCommand: vi.fn(),
      parseCodingAgentSessionCommand: () => null,
    })
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const roomEmit = vi.fn()
    const namespace = { adapter: { rooms: new Map() }, sockets: new Map(), emit: vi.fn(), to: vi.fn(() => ({ emit: roomEmit })), use: vi.fn(), on: vi.fn() }
    const server = new ChatRunSocket({ of: () => namespace } as any)
    ;(server as any).sessionMap.set('s1', {
      messages: [], isWorking: true, events: [], queue: [],
      source: 'coding_agent', webhookAgent: 'codex', profile: 'default',
    })

    executed = []
    for (let index = 0; index < 10; index += 1) {
      server.emitExternalEvent('s1', 'message.delta', { event: 'message.delta', delta: `d${index}` })
    }
    expect(roomEmit).toHaveBeenCalledTimes(10)
    expect(sessionLookups()).toBe(0)
    expect(webhookCalls.at(-1)).toEqual(expect.objectContaining({ source: 'coding_agent', agent: 'codex', profile: 'default' }))

    // Without in-memory state the stored row still decides source and agent.
    ;(server as any).sessionMap.delete('s1')
    executed = []
    server.emitExternalEvent('s1', 'run.completed', { event: 'run.completed' })
    expect(sessionLookups()).toBeGreaterThan(0)
    expect(webhookCalls.at(-1)).toEqual(expect.objectContaining({ source: 'coding_agent', agent: 'codex', profile: 'default' }))
    vi.doUnmock('../../packages/server/src/modules/studio/services/webhooks')
    vi.doUnmock('../../packages/server/src/modules/hermes/services/bridge/index')
    vi.doUnmock('../../packages/server/src/modules/hermes/services/bridge/manager')
  })
})
