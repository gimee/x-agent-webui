import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionState } from '../../packages/server/src/modules/studio/contracts/runs/session'

// Only external/runtime concerns are mocked: handler -> bridge-message ->
// persistRunMessages -> addMessage and the real SQLite identity index stay live.
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
  buildCompressedHistory: async () => [], buildDbSnapshotAwareHistory: async () => [],
  pushState: vi.fn(), replaceState: vi.fn(), forceCompressBridgeHistory: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  calcAndUpdateUsage: async () => ({ inputTokens: 0, outputTokens: 0 }),
  estimateUsageTokensFromMessages: () => ({ inputTokens: 0, outputTokens: 0 }),
  getCachedBridgeContextOverhead: () => 0, updateMessageContextTokenUsage: () => 0,
  contextTokensWithCachedOverhead: (_state: unknown, tokens: number) => tokens,
}))

describe('Hermes assistant wire identity through SQLite', () => {
  let db: DatabaseSync
  let store: typeof import('../../packages/server/src/modules/studio/repositories/session-store')
  let state: SessionState
  let emitted: Array<{ event: string; payload: any }>

  beforeEach(async () => {
    vi.resetModules()
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db, isSqliteAvailable: () => true,
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    store.createSession({ id: 's1', profile: 'default', source: 'cli', title: 'Manual test title', model: 'test', provider: 'test' })
    state = { messages: [], isWorking: false, events: [], queue: [] }
    emitted = []
  })

  afterEach(() => {
    db.close()
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })

  const chunk = (events: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
    ok: true, run_id: 'bridge-run', session_id: 's1', status: 'running',
    delta: '', output: '', cursor: 0, event_cursor: 0, done: false, events, ...extra,
  })
  const rows = () => store.getSessionDetail('s1')!.messages.filter(message => message.role === 'assistant')
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
    }
    await handleBridgeRun(nsp as any, socket as any, { session_id: 's1', input: 'test', ...data },
      'default', new Map([['s1', state]]), bridge as any, true, async () => state, vi.fn())
  }

  it('separates terminal segment content from aggregate output after a reasoning-only tail', async () => {
    await run([
      chunk([{event:'stream.delta',delta:'First answer'},{event:'message.interim',text:'First answer',already_streamed:true}]),
      chunk([{event:'reasoning.delta',text:'Final thought without body'}]),
      chunk([],{done:true,status:'complete'}),
    ])
    const terminal=payloads('run.completed')[0]
    expect(terminal.output).toBe('First answer') // aggregate output contract remains unchanged
    const target=rows().find(row=>String(row.id)===String(terminal.message_id))
    expect(target?.content).toBe('')
    expect(terminal.assistant_content).toBe(target?.content)
    expect(terminal.assistant_reasoning).toBe('Final thought without body')
  })

  it('uses a provisional ID outside the positive SQLite rowid space before persistence', async () => {
    let pendingId: number | undefined
    await run([
      chunk([{event:'stream.delta',delta:'Pending'}]),
      () => { pendingId = state.messages.find(m=>m.role==='assistant' && m.finish_reason==null)?.id },
      chunk([],{done:true,status:'complete'}),
    ])
    expect(pendingId).toBeLessThan(0)
    expect(rows()[0].id).toBeGreaterThan(0)
  })

  it('terminal identity never assigns the prior text to a later tool-only segment', async () => {
    await run([
      chunk([{event:'stream.delta',delta:'First answer'},{event:'turn.boundary'}]),
      chunk([{event:'tool.started',tool_name:'terminal',tool_call_id:'call-last',args:{}}]),
      chunk([{event:'tool.completed',tool_name:'terminal',tool_call_id:'call-last',result:'ok'}]),
      chunk([],{done:true,status:'complete'}),
    ])
    const terminal=payloads('run.completed')[0]
    const target=rows().find(row=>String(row.id)===String(terminal.message_id))
    if (terminal.output) expect(target?.content).toBe(terminal.output)
  })

  it('keeps reasoning attached to its tool-boundary assistant identity', async () => {
    await run([
      chunk([{ event: 'reasoning.delta', text: 'inspect' }, { event: 'turn.boundary' }]),
      chunk([{ event: 'tool.started', tool_name: 'terminal', tool_call_id: 'call-1', args: {} }]),
      chunk([{ event: 'tool.completed', tool_name: 'terminal', tool_call_id: 'call-1', result: 'ok' }]),
      chunk([{ event: 'stream.delta', delta: 'done' }]),
      chunk([], { done: true, status: 'complete' }),
    ])
    expect(rows()).toHaveLength(2)
    const identity = payloads('reasoning.delta')[0].client_message_id
    expect(rows()[0]).toMatchObject({ client_message_id: identity, content: '', reasoning: 'inspect', finish_reason: 'tool_calls' })
    expect(rows()[0].tool_calls?.[0].id).toBe('call-1')
    expect(payloads('tool.started')[0]).toMatchObject({
      assistant_client_message_id: identity, assistant_message_id: rows()[0].id,
    })
    expect(rows()[1].client_message_id).not.toBe(identity)
    expect(payloads('message.delta')[0].client_message_id).toBe(rows()[1].client_message_id)
  })

  it.each(['complete', 'error', 'throw'])('persists a reasoning-only tail on %s', async (status) => {
    await run([
      chunk([{ event: 'reasoning.delta', text: 'still thinking' }]),
      ...(status === 'throw'
        ? [() => { throw new Error('disconnected') }]
        : [chunk([], { done: true, status, error: status === 'error' ? 'failed' : null })]),
    ])
    const identity = payloads('reasoning.delta')[0].client_message_id
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ client_message_id: identity, content: '', reasoning: 'still thinking', finish_reason: 'stop' })
    const terminal = payloads(status === 'complete' ? 'run.completed' : 'run.failed')[0]
    expect(terminal.client_message_id).toBe(identity)
    expect(String(terminal.message_id)).toBe(String(rows()[0].id))
  })

  it.each(['complete', 'error', 'throw'])('allocates identity for entirely buffered markup on %s', async (status) => {
    await run([
      chunk([], { delta: '[Call' }),
      ...(status === 'throw'
        ? [() => { throw new Error('disconnected') }]
        : [chunk([], { done: true, status, error: status === 'error' ? 'failed' : null })]),
    ])
    const delta = payloads('message.delta')[0]
    expect(delta.client_message_id).toMatch(/^am_[0-9a-f-]+$/)
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ content: '[Call', client_message_id: delta.client_message_id, finish_reason: 'stop' })
    expect(payloads(status === 'complete' ? 'run.completed' : 'run.failed')[0].client_message_id).toBe(delta.client_message_id)
  })

  it('assigns identity before legacy aggregate and buffered markup deltas', async () => {
    await run([
      chunk([], { delta: 'Text [Call' }),
      () => expect(rows()).toHaveLength(0),
      chunk([], { done: true, status: 'complete' }),
    ])
    expect(payloads('message.delta').map(payload => payload.delta)).toEqual(['Text ', '[Call'])
    const identity = payloads('message.delta')[0].client_message_id
    expect(identity).toMatch(/^am_[0-9a-f-]+$/)
    expect(payloads('message.delta')[1].client_message_id).toBe(identity)
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ content: 'Text [Call', client_message_id: identity })
  })

  it.each([
    { final_response: 'same' },
    { final_response: 'same', parsed_content: 'same' },
  ])('does not allocate another identity for a terminal snapshot after the last interim: %j', async (result) => {
    await run([
      chunk([{ event: 'stream.delta', delta: 'same' }, { event: 'message.interim', text: 'same', already_streamed: true }]),
      chunk([], { done: true, status: 'complete', output: 'same', result }),
      chunk([], { done: true, status: 'complete', output: 'same', result }),
    ])
    expect(rows()).toHaveLength(1)
    expect(state.messages.filter(message => message.role === 'assistant')).toHaveLength(1)
    expect(payloads('run.completed')).toHaveLength(1)
    expect(payloads('run.completed')[0]).toMatchObject({
      client_message_id: rows()[0].client_message_id, message_id: String(rows()[0].id),
    })
  })

  it('preserves identical text in genuinely different segments of the same run', async () => {
    await run([
      chunk([{ event: 'stream.delta', delta: 'same' }, { event: 'message.interim', text: 'same', already_streamed: true }]),
      chunk([{ event: 'stream.delta', delta: 'same' }, { event: 'message.interim', text: 'same', already_streamed: true }]),
      chunk([], { done: true, status: 'complete', result: { final_response: 'same', parsed_content: 'same' } }),
    ])
    expect(rows()).toHaveLength(2)
    expect(rows().map(message => message.content)).toEqual(['same', 'same'])
    expect(new Set(rows().map(message => message.client_message_id)).size).toBe(2)
    expect(payloads('message.delta').map(payload => payload.client_message_id)).toEqual(rows().map(message => message.client_message_id))
    expect(payloads('run.completed')[0].client_message_id).toBe(rows()[1].client_message_id)
  })

  it('keeps tool metadata durable after a text boundary and parallel tool starts', async () => {
    await run([
      chunk([{ event: 'reasoning.delta', text: 'plan' }, { event: 'stream.delta', delta: 'checking' }, { event: 'turn.boundary' }]),
      chunk([{ event: 'tool.started', tool_name: 'terminal', tool_call_id: 'call-1', args: { command: 'pwd' } },
        { event: 'tool.started', tool_name: 'read_file', tool_call_id: 'call-2', args: { path: 'file' } }]),
      chunk([{ event: 'tool.completed', tool_name: 'terminal', tool_call_id: 'call-1', result: 'ok' },
        { event: 'tool.completed', tool_name: 'read_file', tool_call_id: 'call-2', result: 'data' }]),
      chunk([{ event: 'stream.delta', delta: 'done' }]),
      chunk([], { done: true, status: 'complete' }),
    ])
    expect(rows()).toHaveLength(4)
    expect(rows()[0]).toMatchObject({ content: 'checking', reasoning: 'plan', finish_reason: 'stop' })
    const tools = rows().filter(message => message.tool_calls?.length)
    expect(tools.map(message => message.tool_calls?.[0].id)).toEqual(['call-1', 'call-2'])
    expect(tools.map(message => message.finish_reason)).toEqual(['tool_calls', 'tool_calls'])
    expect(tools[0].tool_calls?.[0].function.arguments).toBe('{"command":"pwd"}')
    expect(payloads('tool.started').map(payload => payload.assistant_client_message_id)).toEqual(tools.map(message => message.client_message_id))
    expect(payloads('tool.started').map(payload => payload.assistant_message_id)).toEqual(tools.map(message => message.id))
    expect(store.getSessionDetail('s1')!.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id)).toEqual(['call-1', 'call-2'])
    expect(state.messages.filter(message => message.role === 'assistant')).toHaveLength(4)
    expect(new Set(rows().map(message => message.client_message_id)).size).toBe(4)
  })

  it('carries the first reasoning identity through text, interim, durable row and resume', async () => {
    await run([
      chunk([{ event: 'reasoning.delta', text: 'think' }]),
      chunk([{ event: 'thinking.delta', text: ' more' }, { event: 'stream.delta', delta: 'same' }]),
      () => expect(rows()).toHaveLength(0),
      chunk([{ event: 'message.interim', text: 'same', already_streamed: true }]),
      chunk([], { status: 'complete', done: true, output: 'same' }),
    ])
    const identity = payloads('reasoning.delta')[0].client_message_id
    expect(identity).toMatch(/^am_[0-9a-f-]+$/)
    for (const event of ['thinking.delta', 'message.delta', 'message.interim', 'run.completed']) {
      expect(payloads(event)[0].client_message_id, event).toBe(identity)
    }
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ client_message_id: identity, content: 'same', reasoning: 'think more', finish_reason: 'stop' })
    expect(String(payloads('message.interim')[0].message_id)).toBe(String(rows()[0].id))
    expect(String(payloads('run.completed')[0].message_id)).toBe(String(rows()[0].id))
    const { buildResumeMessages } = await import('../../packages/server/src/modules/studio/services/chat-run/resume-payload')
    expect(buildResumeMessages(store.getSessionDetailPaginated('s1', 0, 150)!.messages)[0]).toMatchObject({ id: rows()[0].id, client_message_id: identity })
    expect(state.messages.filter(message => message.role === 'assistant')).toHaveLength(1)
  })
})
