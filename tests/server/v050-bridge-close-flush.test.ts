import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// hermes-v050:S-F8 (bridge half) — ChatRunSocket.close() (server shutdown)
// aborted in-flight Hermes bridge runs without flushing the streamed text that
// was still pending in memory, so the tail of the answer was gone after the
// restart. Real handleBridgeRun → bridge-message → session-store on
// in-memory SQLite; the Hermes bridge is a fake stream.

const DB_MODULE = '../../packages/server/src/modules/studio/infrastructure/database/index'

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bridgeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../packages/server/src/modules/studio/public/runs/prompt', () => ({ getSystemPrompt: () => 'test' }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/workspace', () => ({ ensureHermesRunWorkspace: async () => null }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/workspace-diff-tracker', () => ({
  startWorkspaceRunCheckpoint: vi.fn(), completeWorkspaceRunCheckpoint: () => null,
}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/model-run-prompt', () => ({ writeModelRunProfileToken: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/model-config', () => ({
  resolveBridgeRunModelConfig: async () => ({ model: 'test', provider: 'test' }),
}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/compression', () => ({
  buildCompressedHistory: async () => [],
  buildDbSnapshotAwareHistory: async () => [],
  pushState: vi.fn(), replaceState: vi.fn(), forceCompressBridgeHistory: vi.fn(),
  getOrCreateSession: (map: Map<string, any>, id: string) => {
    if (!map.has(id)) map.set(id, { messages: [], isWorking: false, events: [], queue: [] })
    return map.get(id)
  },
}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  calcAndUpdateUsage: async () => ({ inputTokens: 0, outputTokens: 0 }),
  estimateUsageTokensFromMessages: () => ({ inputTokens: 0, outputTokens: 0 }),
  getCachedBridgeContextOverhead: () => 0, updateMessageContextTokenUsage: () => 0,
  contextTokensWithCachedOverhead: (_state: unknown, tokens: number) => tokens,
}))
vi.mock('../../packages/server/src/modules/hermes/services/bridge/index', () => ({ AgentBridgeClient: vi.fn(() => ({})) }))
vi.mock('../../packages/server/src/modules/hermes/services/bridge/manager', () => ({ getAgentBridgeManager: vi.fn(() => ({})) }))

describe('hermes-v050:S-F8 ChatRunSocket.close() flushes pending bridge text', () => {
  let db: DatabaseSync
  let releaseStream: () => void
  let running: Promise<unknown> | null = null

  beforeEach(async () => {
    vi.resetModules()
    db = new DatabaseSync(':memory:')
    vi.doMock(DB_MODULE, () => ({ getDb: () => db, isSqliteAvailable: () => true, getStoragePath: () => ':memory:' }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    const store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    store.createSession({ id: 's1', profile: 'default', source: 'cli', title: 'bridge', model: 'test', provider: 'test' })
    const { configureChatAgentRuntime } = await import('../../packages/server/src/modules/studio/public/chat-agent-runtime')
    const serverBridge = { close: vi.fn(async () => {}), releaseBackgroundNotification: vi.fn(async () => {}) }
    configureChatAgentRuntime({
      createPrimaryAgentBridge: () => serverBridge,
      getPrimaryAgentBridgeManager: () => ({}),
      redactPrimaryAgentBridgeError: (error?: string) => error,
      codingAgentRunManager: { hasSession: () => false, stop: () => false },
      sendCodingAgentRunInput: vi.fn(),
      startCodingAgentRun: vi.fn(),
      handleCodingAgentSessionCommand: vi.fn(),
      parseCodingAgentSessionCommand: () => null,
    })
  })

  afterEach(async () => {
    releaseStream?.()
    await running?.catch(() => undefined)
    running = null
    db.close()
    vi.doUnmock(DB_MODULE)
    vi.resetModules()
  })

  const chunk = (events: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
    ok: true, run_id: 'bridge-run', session_id: 's1', status: 'running',
    delta: '', output: '', cursor: 0, event_cursor: 0, done: false, events, ...extra,
  })

  function assistantRows() {
    return db.prepare(
      `SELECT content, finish_reason, client_message_id FROM messages WHERE session_id = 's1' AND role = 'assistant' ORDER BY id`,
    ).all() as Array<Record<string, any>>
  }

  it('persists the in-flight answer exactly once when the server closes mid-stream', { timeout: 30_000 }, async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    const { flushBridgePendingToDb } = await import('../../packages/server/src/modules/studio/services/chat-run/bridge-message')
    const namespace = {
      adapter: { rooms: new Map([['session:s1', new Set(['socket'])]]) },
      sockets: new Map(), emit: vi.fn(), use: vi.fn(), on: vi.fn(),
      to: () => ({ emit: vi.fn() }),
    }
    const server = new ChatRunSocket({ of: () => namespace } as any)
    const sessionMap: Map<string, any> = (server as any).sessionMap
    const state = { messages: [], isWorking: false, events: [], queue: [] }
    sessionMap.set('s1', state)
    let streamed!: () => void
    const reachedTail = new Promise<void>(resolve => { streamed = resolve })
    const hold = new Promise<void>(resolve => { releaseStream = resolve })
    const bridge = {
      chat: async () => ({ run_id: 'bridge-run', status: 'running' }),
      async *streamOutput() {
        yield chunk([{ event: 'stream.delta', delta: 'Streaming the first half, ' }])
        yield chunk([{ event: 'stream.delta', delta: 'and the tail before shutdown' }])
        streamed()
        await hold
      },
      goalEvaluate: async () => ({ should_continue: false }),
      releaseBackgroundNotification: vi.fn(async () => {}),
    }
    const socket = { data: {}, connected: true, join: vi.fn(), emit: vi.fn(), to: () => ({ emit: vi.fn() }) }
    running = handleBridgeRun(namespace as any, socket as any, { session_id: 's1', input: 'hello' }, 'default', sessionMap, bridge as any, false, async () => state as any, vi.fn() as any)
    await reachedTail
    expect(assistantRows()).toEqual([])

    await server.close()

    const rows = assistantRows()
    expect(rows).toEqual([
      expect.objectContaining({ content: 'Streaming the first half, and the tail before shutdown', finish_reason: 'stop' }),
    ])
    expect(rows[0].client_message_id).toMatch(/^am_/)
    // A later flush (the run's own error path once the stream dies) must not duplicate it.
    flushBridgePendingToDb(state as any, 's1')
    expect(assistantRows()).toHaveLength(1)
    releaseStream()
    await running
    expect(assistantRows()).toHaveLength(1)
  })
})
