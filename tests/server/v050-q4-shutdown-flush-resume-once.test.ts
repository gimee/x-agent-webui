// hermes-v050:Q-4 With HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN=0 the bridge (and its run) outlives
// a WebUI restart. Shutdown flushes the half-streamed reply to the DB (S-F8,
// ChatRunSocket.close -> flushBridgePendingToDb); the restarted WebUI reattaches and replays
// the run (resumeBridgeRun). The already persisted text must end up in the DB exactly once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bridgeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/public/runs/prompt', () => ({
  getSystemPrompt: vi.fn(() => 'system prompt'),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  calcAndUpdateUsage: vi.fn(async () => ({ inputTokens: 3, outputTokens: 2 })),
  contextTokensWithCachedOverhead: vi.fn((_state: any, tokens: number) => tokens),
  estimateUsageTokensFromMessages: vi.fn(() => ({ inputTokens: 3, outputTokens: 2 })),
  getCachedBridgeContextOverhead: vi.fn(() => undefined),
  updateMessageContextTokenUsage: vi.fn((_sid: string, state: any, _emit: any, tokens: number) => {
    state.contextTokens = tokens
    return tokens
  }),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/compression', async () => {
  const actual = await vi.importActual<any>('../../packages/server/src/modules/studio/services/chat-run/compression')
  return {
    ...actual,
    buildDbHistory: vi.fn(async () => []),
    buildDbSnapshotAwareHistory: vi.fn(async () => []),
    buildSnapshotAwareHistory: vi.fn(async () => []),
    buildCompressedHistory: vi.fn(),
    forceCompressBridgeHistory: vi.fn(),
  }
})

const SID = 'session-q4'
const RUN = 'run-q4'
const FLUSHED = 'The answer is being wri'
const INTRO = 'Let me check the file first. '

describe('hermes-v050:Q-4 half reply flushed at shutdown, bridge run resumed after restart', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      isSqliteAvailable: () => true,
      getStoragePath: () => ':memory:',
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })

  // Before the restart: a bridge run streamed FLUSHED, then ChatRunSocket.close() flushed it.
  async function shutDownMidReply() {
    const store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const { flushBridgePendingToDb } = await import('../../packages/server/src/modules/studio/services/chat-run/bridge-message')
    store.createSession({ id: SID, profile: 'default', source: 'cli', model: 'gpt-test', provider: 'openai' })
    const userId = store.addMessage({ session_id: SID, role: 'user', content: 'Explain it', timestamp: 1 })
    const state: any = {
      messages: [
        { id: userId, session_id: SID, role: 'user', content: 'Explain it', timestamp: 1 },
        { id: -2, session_id: SID, role: 'assistant', content: FLUSHED, runMarker: 'marker-before-restart', client_message_id: 'am_before', timestamp: 2 },
      ],
      isWorking: true,
      runId: RUN,
      activeRunMarker: 'marker-before-restart',
      profile: 'default',
      source: 'cli',
      events: [],
      queue: [],
      bridgeOutput: FLUSHED,
      bridgePendingAssistantContent: FLUSHED,
      bridgePendingReasoningContent: '',
    }
    flushBridgePendingToDb(state, SID)
    return store
  }

  // Same, but the run first said INTRO, called a tool (both persisted while streaming), then
  // streamed FLUSHED before the shutdown flush.
  async function shutDownMidSecondSegment() {
    const store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const { flushBridgePendingToDb } = await import('../../packages/server/src/modules/studio/services/chat-run/bridge-message')
    store.createSession({ id: SID, profile: 'default', source: 'cli', model: 'gpt-test', provider: 'openai' })
    const userId = store.addMessage({ session_id: SID, role: 'user', content: 'Explain it', timestamp: 1 })
    const toolCalls = [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }]
    const introId = store.addMessage({ session_id: SID, role: 'assistant', content: INTRO, tool_calls: toolCalls, run_marker: 'marker-before-restart', finish_reason: 'tool_calls', timestamp: 2 })
    const toolId = store.addMessage({ session_id: SID, role: 'tool', content: 'file body', tool_call_id: 'call-1', tool_name: 'read_file', run_marker: 'marker-before-restart', timestamp: 3 })
    const state: any = {
      messages: [
        { id: userId, session_id: SID, role: 'user', content: 'Explain it', timestamp: 1 },
        { id: introId, session_id: SID, role: 'assistant', content: INTRO, tool_calls: toolCalls, runMarker: 'marker-before-restart', finish_reason: 'tool_calls', timestamp: 2 },
        { id: toolId, session_id: SID, role: 'tool', content: 'file body', tool_call_id: 'call-1', tool_name: 'read_file', runMarker: 'marker-before-restart', timestamp: 3 },
        { id: -4, session_id: SID, role: 'assistant', content: FLUSHED, runMarker: 'marker-before-restart', client_message_id: 'am_before', timestamp: 4 },
      ],
      isWorking: true,
      runId: RUN,
      activeRunMarker: 'marker-before-restart',
      profile: 'default',
      source: 'cli',
      events: [],
      queue: [],
      bridgeOutput: INTRO + FLUSHED,
      bridgePendingAssistantContent: FLUSHED,
      bridgePendingReasoningContent: '',
    }
    flushBridgePendingToDb(state, SID)
  }

  // After the restart: fresh process state from the DB, reattached like ChatRunSocket.reattachBridgeRun.
  async function restartAndResume(bridge: Record<string, any>) {
    const { loadSessionStateFromDb } = await import('../../packages/server/src/modules/studio/services/chat-run/load-state')
    const { resumeBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    const sessionMap = new Map<string, any>()
    const state = await loadSessionStateFromDb(SID, sessionMap)
    Object.assign(state, { runStartedAt: Date.now(), isWorking: true, isAborting: false, runId: RUN, activeRunMarker: undefined, profile: 'default', source: 'cli', events: [] })
    sessionMap.set(SID, state)
    const emitted: Array<{ event: string; payload: any }> = []
    const nsp = {
      adapter: { rooms: { get: vi.fn(() => new Set(['socket-1'])) } },
      to: vi.fn(() => ({ emit: vi.fn((event: string, payload: any) => emitted.push({ event, payload })) })),
    }
    await resumeBridgeRun(
      nsp as any,
      { id: 'socket-1', connected: true, emit: vi.fn() } as any,
      { sessionId: SID, runId: RUN, profile: 'default', instructions: 'system prompt', model: 'gpt-test', provider: 'openai', source: 'cli' },
      sessionMap,
      bridge as any,
      vi.fn(),
    )
    return { emitted, state }
  }

  // The bridge kept running across the restart: DELTAS is everything it produced for the run.
  // EVENTS, when given, is the run's ordered event log (text as stream.delta events, tools).
  function runningBridge(deltas: string[], options: { snapshotFails?: boolean; events?: any[] } = {}) {
    const output = deltas.join('')
    const events = options.events || []
    return {
      getResult: vi.fn(async () => {
        if (options.snapshotFails) throw new Error('Agent bridge request timed out after 120000ms')
        return { ok: true, run_id: RUN, session_id: SID, status: 'running', output, deltas, events }
      }),
      getOutput: vi.fn(async (_runId: string, cursor: number, eventCursor: number) => ({
        ok: true,
        run_id: RUN,
        session_id: SID,
        status: 'complete',
        delta: deltas.slice(cursor).join(''),
        cursor: deltas.length,
        output,
        done: true,
        result: { completed: true, final_response: output },
        error: null,
        events: events.slice(eventCursor),
        event_cursor: events.length,
      })),
      goalEvaluate: vi.fn(async () => ({ should_continue: false })),
      contextEstimate: vi.fn(async () => { throw new Error('not needed') }),
    }
  }

  function assistantRows() {
    return (db.prepare(`SELECT content, finish_reason FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY id`).all(SID) as Array<{ content: string }>)
  }

  function copiesOf(text: string) {
    return assistantRows().filter(row => row.content.includes(text)).length
  }

  function copiesOfFlushedText() {
    return copiesOf(FLUSHED)
  }

  function toolRows() {
    return (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'tool'`).get(SID) as { n: number }).n
  }

  const SEGMENTED = [INTRO, 'The answer ', 'is being wri', 'tten down.']
  const SEGMENTED_EVENTS = [
    { event: 'stream.delta', delta: INTRO },
    { event: 'tool.started', tool_call_id: 'call-1', name: 'read_file', arguments: {} },
    { event: 'tool.completed', tool_call_id: 'call-1', name: 'read_file', result: 'file body' },
    { event: 'stream.delta', delta: 'The answer ' },
    { event: 'stream.delta', delta: 'is being wri' },
    { event: 'stream.delta', delta: 'tten down.' },
  ]

  it('persists the half reply once at shutdown', async () => {
    await shutDownMidReply()
    expect(assistantRows()).toEqual([{ content: FLUSHED, finish_reason: 'stop' }])
  })

  it('resume with a snapshot appends only what the bridge produced after the flush', async () => {
    await shutDownMidReply()
    const bridge = runningBridge(['The answer ', 'is being wri', 'tten down.'])

    await restartAndResume(bridge)

    expect(bridge.getOutput).toHaveBeenCalledWith(RUN, 3, 0)
    expect(copiesOfFlushedText()).toBe(1)
    expect(assistantRows().map(row => row.content).join('')).toBe('The answer is being written down.')
  })

  it('resume whose snapshot request fails does not replay the flushed text either (text sent as stream.delta events)', async () => {
    await shutDownMidReply()
    const bridge = runningBridge(['The answer ', 'is being wri', 'tten down.'], {
      snapshotFails: true,
      events: ['The answer ', 'is being wri', 'tten down.'].map(delta => ({ event: 'stream.delta', delta })),
    })

    await restartAndResume(bridge)

    expect(copiesOfFlushedText()).toBe(1)
    expect(assistantRows().map(row => row.content).join('')).toBe('The answer is being written down.')
  })

  it('a run with an earlier text segment and tool call: resume keeps every segment once and loses nothing', async () => {
    await shutDownMidSecondSegment()
    const bridge = runningBridge(SEGMENTED, { events: SEGMENTED_EVENTS })

    await restartAndResume(bridge)

    expect(copiesOf(INTRO)).toBe(1)
    expect(copiesOfFlushedText()).toBe(1)
    expect(toolRows()).toBe(1)
    expect(assistantRows().map(row => row.content).join('')).toBe(`${INTRO}The answer is being written down.`)
  })

  it('the same run when the snapshot request fails: still one copy of each segment and of the tool row', async () => {
    await shutDownMidSecondSegment()
    const bridge = runningBridge(SEGMENTED, { snapshotFails: true, events: SEGMENTED_EVENTS })

    await restartAndResume(bridge)

    expect(copiesOf(INTRO)).toBe(1)
    expect(copiesOfFlushedText()).toBe(1)
    expect(toolRows()).toBe(1)
    expect(assistantRows().map(row => row.content).join('')).toBe(`${INTRO}The answer is being written down.`)
  })

  it('resume whose snapshot request fails does not replay the flushed text from cursor 0', async () => {
    await shutDownMidReply()
    const bridge = runningBridge(['The answer ', 'is being wri', 'tten down.'], { snapshotFails: true })

    await restartAndResume(bridge)

    expect(copiesOfFlushedText()).toBe(1)
    expect(assistantRows().map(row => row.content).join('')).toBe('The answer is being written down.')
  })
})
