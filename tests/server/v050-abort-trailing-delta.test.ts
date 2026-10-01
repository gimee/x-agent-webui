import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

// hermes-v050:S-F10 — abort flushes the pending bridge text before awaiting
// bridge.interrupt; deltas Hermes still pushes while it stops land in a fresh,
// unflushed segment, and markAbortCompleted used to reset the run without
// persisting it: visible in the live chat, gone after a reload.
// Real handleBridgeRun + handleAbort → bridge-message → session-store on
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
}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  calcAndUpdateUsage: async () => ({ inputTokens: 0, outputTokens: 0 }),
  estimateUsageTokensFromMessages: () => ({ inputTokens: 0, outputTokens: 0 }),
  getCachedBridgeContextOverhead: () => 0, updateMessageContextTokenUsage: () => 0,
  contextTokensWithCachedOverhead: (_state: unknown, tokens: number) => tokens,
}))
vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
  chatCodingAgentRunManager: { hasSession: () => false, stop: vi.fn() },
}))

describe('hermes-v050:S-F10 bridge deltas that arrive while an abort is in flight are persisted', () => {
  let db: DatabaseSync
  let state: any
  let sessionMap: Map<string, any>
  let emitted: Array<{ event: string; payload: any }>

  beforeEach(async () => {
    vi.resetModules()
    db = new DatabaseSync(':memory:')
    vi.doMock(DB_MODULE, () => ({ getDb: () => db, isSqliteAvailable: () => true, getStoragePath: () => ':memory:' }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    const store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    store.createSession({ id: 's1', profile: 'default', source: 'cli', title: 'abort', model: 'test', provider: 'test' })
    state = { messages: [], isWorking: false, events: [], queue: [] }
    sessionMap = new Map([['s1', state]])
    emitted = []
  })

  afterEach(() => {
    db.close()
    vi.doUnmock(DB_MODULE)
    vi.resetModules()
  })

  const chunk = (events: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
    ok: true, run_id: 'bridge-run', session_id: 's1', status: 'running',
    delta: '', output: '', cursor: 0, event_cursor: 0, done: false, events, ...extra,
  })

  const nsp = {
    adapter: { rooms: new Map([['session:s1', new Set(['socket'])]]) },
    to: () => ({ emit: (event: string, payload: any) => emitted.push({ event, payload }) }),
  }
  const socket = { data: {}, connected: true, join: vi.fn(), emit: vi.fn(), to: () => ({ emit: vi.fn() }) }

  function assistantRows() {
    return db.prepare(
      `SELECT content, finish_reason, client_message_id FROM messages WHERE session_id = 's1' AND role = 'assistant' ORDER BY id`,
    ).all() as Array<Record<string, any>>
  }

  async function runWithAbort(steps: Array<Record<string, unknown> | ((ctx: { startAbort: () => void; finishInterrupt: () => Promise<void> }) => unknown)>) {
    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    const { handleAbort } = await import('../../packages/server/src/modules/studio/services/chat-run/abort')
    let resolveInterrupt!: (value: unknown) => void
    const interrupted = new Promise(resolve => { resolveInterrupt = resolve })
    let abortDone: Promise<void> = Promise.resolve()
    const bridge = {
      chat: async () => ({ run_id: 'bridge-run', status: 'running' }),
      interrupt: vi.fn(() => interrupted),
      goalPause: vi.fn(async () => ({})),
      async *streamOutput() {
        for (const step of steps) {
          if (typeof step === 'function') {
            await step({
              startAbort: () => { abortDone = handleAbort(nsp as any, socket as any, 's1', sessionMap, bridge, vi.fn()) },
              finishInterrupt: async () => { resolveInterrupt({ ok: true, synced: true }); await abortDone },
            })
          } else {
            yield step
          }
        }
      },
      goalEvaluate: async () => ({ should_continue: false }),
      releaseBackgroundNotification: vi.fn(async () => {}),
    }
    await handleBridgeRun(nsp as any, socket as any, { session_id: 's1', input: 'write something long' }, 'default', sessionMap, bridge as any, false, async () => state, vi.fn() as any)
    // A terminal chunk ends the stream loop; Hermes then confirms the interrupt.
    resolveInterrupt({ ok: true, synced: true })
    await abortDone
  }

  it('persists a delta that arrives while bridge.interrupt is pending (abort completes first)', async () => {
    await runWithAbort([
      chunk([{ event: 'stream.delta', delta: 'Here is the start. ' }]),
      ({ startAbort }) => startAbort(),
      chunk([{ event: 'stream.delta', delta: 'Trailing words' }]),
      ({ finishInterrupt }) => finishInterrupt(),
      chunk([], { done: true, status: 'interrupted' }),
    ])

    const rows = assistantRows()
    expect(rows.map(row => row.content)).toEqual(['Here is the start. ', 'Trailing words'])
    expect(new Set(rows.map(row => row.client_message_id)).size).toBe(2)
    rows.forEach(row => expect(row.finish_reason).toBe('stop'))
    expect(emitted.filter(item => item.event === 'abort.completed')).toHaveLength(1)
    expect(state.isWorking).toBe(false)
  })

  it('persists the tail carried by the terminal chunk that completes the abort', async () => {
    await runWithAbort([
      chunk([{ event: 'stream.delta', delta: 'Here is the start. ' }]),
      ({ startAbort }) => startAbort(),
      chunk([{ event: 'stream.delta', delta: 'Final tail' }], { done: true, status: 'interrupted' }),
    ])

    const rows = assistantRows()
    expect(rows.map(row => row.content)).toEqual(['Here is the start. ', 'Final tail'])
    rows.forEach(row => expect(row.finish_reason).toBe('stop'))
  })

  it('guard: an abort with nothing left pending writes no extra row', async () => {
    await runWithAbort([
      chunk([{ event: 'stream.delta', delta: 'Only this. ' }]),
      ({ startAbort }) => startAbort(),
      ({ finishInterrupt }) => finishInterrupt(),
      chunk([], { done: true, status: 'interrupted' }),
    ])

    expect(assistantRows().map(row => row.content)).toEqual(['Only this. '])
  })
})
