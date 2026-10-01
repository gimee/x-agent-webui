import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionState } from '../../packages/server/src/modules/studio/contracts/runs/session'

// Server-side session state machine regressions (state-machine review
// S-F4 / S-F5) through the real `handleBridgeRun` and an in-memory SQLite.

const compressionMocks = vi.hoisted(() => ({
  buildCompressedHistory: vi.fn(async () => [] as unknown[]),
}))
// Optional interceptor around the real `addMessage`; returns undefined to fall through.
let addMessageInterceptor: ((args: any) => number | undefined) | null = null

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
  buildCompressedHistory: compressionMocks.buildCompressedHistory,
  buildDbSnapshotAwareHistory: async () => [],
  pushState: vi.fn(), replaceState: vi.fn(), forceCompressBridgeHistory: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  calcAndUpdateUsage: async () => ({ inputTokens: 0, outputTokens: 0 }),
  estimateUsageTokensFromMessages: () => ({ inputTokens: 0, outputTokens: 0 }),
  getCachedBridgeContextOverhead: () => 0, updateMessageContextTokenUsage: () => 0,
  contextTokensWithCachedOverhead: (_state: unknown, tokens: number) => tokens,
}))

class ContextWindowTooSmallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContextWindowTooSmallError'
  }
}

describe('server session state machine: bridge run', () => {
  let db: DatabaseSync
  let store: typeof import('../../packages/server/src/modules/studio/repositories/session-store')
  let state: SessionState
  let emitted: Array<{ event: string; payload: any }>
  let onEvents: Array<{ event: string; payload: any }>
  let dequeueNextQueuedRun: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    compressionMocks.buildCompressedHistory.mockReset()
    compressionMocks.buildCompressedHistory.mockResolvedValue([])
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db, isSqliteAvailable: () => true,
    }))
    addMessageInterceptor = null
    vi.doMock('../../packages/server/src/modules/studio/repositories/session-store', async () => {
      const actual = await vi.importActual<typeof import('../../packages/server/src/modules/studio/repositories/session-store')>(
        '../../packages/server/src/modules/studio/repositories/session-store',
      )
      return {
        ...actual,
        addMessage: (args: any) => {
          const intercepted = addMessageInterceptor?.(args)
          return intercepted === undefined ? actual.addMessage(args) : intercepted
        },
      }
    })
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    store.createSession({ id: 's1', profile: 'default', source: 'cli', title: 'state machine', model: 'test', provider: 'test' })
    state = { messages: [], isWorking: false, events: [], queue: [] }
    emitted = []
    onEvents = []
    dequeueNextQueuedRun = vi.fn()
  })

  afterEach(() => {
    db.close()
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.doUnmock('../../packages/server/src/modules/studio/repositories/session-store')
    vi.resetModules()
  })

  const chunk = (events: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
    ok: true, run_id: 'bridge-run', session_id: 's1', status: 'running',
    delta: '', output: '', cursor: 0, event_cursor: 0, done: false, events, ...extra,
  })
  const payloads = (event: string) => emitted.filter(item => item.event === event).map(item => item.payload)

  async function run(chunks: Array<ReturnType<typeof chunk> | (() => void)>, data: Record<string, unknown> = {}) {
    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    const nsp = {
      adapter: { rooms: new Map([['session:s1', new Set(['socket'])]]) },
      to: () => ({ emit: (event: string, payload: any) => emitted.push({ event, payload }) }),
    }
    const socket = { data: {}, connected: true, join: vi.fn(), emit: vi.fn(), to: () => ({ emit: vi.fn() }) }
    const bridge = {
      chat: async () => ({ run_id: 'bridge-run', status: 'running' }),
      async *streamOutput() { for (const next of chunks) { if (typeof next === 'function') next(); else yield next } },
      goalEvaluate: async () => ({ should_continue: false }),
      releaseBackgroundNotification: vi.fn(async () => {}),
    }
    return handleBridgeRun(nsp as any, socket as any, {
      session_id: 's1', input: 'test',
      onEvent: (event: string, payload: any) => onEvents.push({ event, payload }),
      ...data,
    }, 'default', new Map([['s1', state]]), bridge as any, /* skipUserMessage */ false, async () => state, dequeueNextQueuedRun as any)
  }

  // S-F4: the bridge user row used a positive provisional id equal to
  // `state.messages.length + 1` and never adopted the SQLite rowid.
  describe('S-F4 user row identity', () => {
    it('adopts the SQLite rowid for the user row instead of a positive provisional id', async () => {
      // Warm state holds fewer rows than the DB: provisional id 1 would
      // collide with an older persisted row of the same role.
      const olderUser = store.addMessage({ session_id: 's1', role: 'user', content: 'older question', timestamp: 1 })
      store.addMessage({ session_id: 's1', role: 'assistant', content: 'older answer', timestamp: 2, finish_reason: 'stop' })
      expect(olderUser).toBe(1)

      await run([chunk([{ event: 'stream.delta', delta: 'reply' }]), chunk([], { done: true, status: 'complete' })],
        { client_message_id: 'cm-new' })

      const persisted = store.getSessionDetail('s1')!.messages.find(row => row.client_message_id === 'cm-new')
      expect(persisted).toBeDefined()
      expect(persisted!.id).toBeGreaterThan(olderUser as number)
      const inMemory = state.messages.find(row => row.client_message_id === 'cm-new')
      expect(inMemory).toBeDefined()
      expect(inMemory!.id).toBe(persisted!.id)
      // No two in-memory rows may share an id with a persisted row of a different message.
      expect(state.messages.filter(row => row.id === olderUser)).toHaveLength(0)
      // message.created must carry the DB id.
      const created = onEvents.find(item => item.event === 'message.created')
      expect(created?.payload.message_id).toBe(persisted!.id)
    })

    it('keeps the user row out of the positive rowid space before persistence', async () => {
      const seen: Array<number | string | undefined> = []
      addMessageInterceptor = (args) => {
        if (args.role === 'user') seen.push(state.messages.find(row => row.role === 'user' && row.client_message_id === 'cm-provisional')?.id)
        return undefined
      }
      await run([chunk([], { done: true, status: 'complete' })], { client_message_id: 'cm-provisional' })
      expect(seen).toHaveLength(1)
      expect(typeof seen[0]).toBe('number')
      expect(seen[0] as number).toBeLessThan(0)
    })
  })

  // S-F5: `state.isWorking = true / activeRunMarker` were set before the
  // history preprocessing, but `buildCompressedHistory` (which throws
  // ContextWindowTooSmallError) ran outside the handler's try block.
  describe('S-F5 pre-start failures', () => {
    it('recovers the session and emits run.failed when history building throws before the bridge starts', async () => {
      compressionMocks.buildCompressedHistory.mockRejectedValueOnce(new ContextWindowTooSmallError('context window too small'))

      await expect(run([], { queue_id: 'queue-1' })).resolves.toBeUndefined()

      expect(state.isWorking).toBe(false)
      expect(state.activeRunMarker).toBeUndefined()
      expect(state.runId).toBeUndefined()
      expect(state.profile).toBeUndefined()
      const failed = payloads('run.failed')
      expect(failed).toHaveLength(1)
      expect(failed[0]).toEqual(expect.objectContaining({
        session_id: 's1', queue_id: 'queue-1', error: 'context window too small', queue_remaining: 0,
      }))
      // The user row is still persisted (the user did send it).
      expect(store.getSessionDetail('s1')!.messages.map(row => row.role)).toEqual(['user'])
      expect(store.getSession('s1')?.end_reason).toBe('error')
    })

    it('dequeues the next queued run after a pre-start failure', async () => {
      compressionMocks.buildCompressedHistory.mockRejectedValueOnce(new ContextWindowTooSmallError('context window too small'))
      state.queue.push({ queue_id: 'queue-next', input: 'next', profile: 'default', source: 'cli' } as any)

      await run([], { queue_id: 'queue-1' })

      expect(state.isWorking).toBe(false)
      expect(payloads('run.failed')[0]).toEqual(expect.objectContaining({ queue_id: 'queue-1', queue_remaining: 1 }))
      expect(dequeueNextQueuedRun).toHaveBeenCalledTimes(1)
      expect(dequeueNextQueuedRun.mock.calls[0][1]).toBe('s1')
    })

    it('recovers when persisting the user row throws', async () => {
      addMessageInterceptor = () => { throw new Error('disk full') }
      await expect(run([], { queue_id: 'queue-1' })).resolves.toBeUndefined()
      expect(state.isWorking).toBe(false)
      expect(state.activeRunMarker).toBeUndefined()
      expect(payloads('run.failed')[0]).toEqual(expect.objectContaining({ error: 'disk full' }))
    })
  })
})
