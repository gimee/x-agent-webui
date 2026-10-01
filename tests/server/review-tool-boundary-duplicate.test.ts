import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyResponseStreamEvent, flushResponseRunToDb } from '../../packages/server/src/modules/studio/services/chat-run/response-stream'
import type { SessionState } from '../../packages/server/src/modules/studio/services/chat-run/types'

const { addMessageMock } = vi.hoisted(() => ({ addMessageMock: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({ addMessage: addMessageMock }))

const TEXT = 'Let me check the file.'
const message = (text: string) => ({ type: 'message', id: 'msg_resp-1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }] })

function textThenTool(state: SessionState) {
  const apply = (type: string, data: any) => applyResponseStreamEvent(state, 's1', 'run-1', type, data)
  apply('response.created', { response: { id: 'resp-1', status: 'in_progress' } })
  // ensureClaudePrintText -> output_item.added(message) is ignored by response-stream
  apply('response.output_item.added', { item: { type: 'message', id: 'msg_resp-1', role: 'assistant', content: [] } })
  apply('response.output_text.delta', { delta: TEXT })
  apply('response.output_item.added', { item: { type: 'function_call', call_id: 'toolu_1', name: 'Read', arguments: '{"path":"a"}' } })
  apply('response.output_item.done', { item: { type: 'function_call', call_id: 'toolu_1', name: 'Read', arguments: '{"path":"a"}' } })
  apply('response.output_item.done', { item: { type: 'function_call_output', call_id: 'toolu_1', output: 'contents' } })
  return apply
}

function persistedTextRows() {
  return addMessageMock.mock.calls.map(call => call[0]).filter(r => r.role === 'assistant' && !r.tool_calls)
}

describe('S-F2: a turn ending on a tool boundary never re-creates the earlier text segment', () => {
  beforeEach(() => { addMessageMock.mockReset(); let id = 100; addMessageMock.mockImplementation(() => ++id) })

  it('text -> tool -> completed(aggregate text, legacy run-manager shape): no duplicate row', () => {
    const state: SessionState = { messages: [], isWorking: true, events: [], queue: [] }
    const apply = textThenTool(state)
    // legacy completeClaudePrintTurn: terminal item carries the whole-turn aggregate
    apply('response.output_text.done', { item_id: 'msg_resp-1', text: TEXT })
    apply('response.output_item.done', { item: message(TEXT) })
    expect(apply('response.completed', { response: { id: 'resp-1', status: 'completed', output: [message(TEXT)] } })).toBeNull()

    expect(state.messages.map(m => m.role)).toEqual(['assistant', 'assistant', 'tool'])
    expect(state.messages.filter(m => m.role === 'assistant' && !m.tool_calls?.length).map(m => m.content)).toEqual([TEXT])

    flushResponseRunToDb(state, 's1')
    expect(persistedTextRows().map(r => r.content)).toEqual([TEXT])
  })

  it('text -> tool -> completed(empty segment text, fixed run-manager shape): no duplicate row', () => {
    const state: SessionState = { messages: [], isWorking: true, events: [], queue: [] }
    const apply = textThenTool(state)
    apply('response.output_text.done', { item_id: 'msg_resp-1', text: '' })
    apply('response.output_item.done', { item: message('') })
    apply('response.completed', { response: { id: 'resp-1', status: 'completed', output: [message('')] } })

    expect(state.messages.map(m => m.role)).toEqual(['assistant', 'assistant', 'tool'])
    flushResponseRunToDb(state, 's1')
    expect(persistedTextRows().map(r => r.content)).toEqual([TEXT])
  })

  it('text -> tool -> text -> completed(aggregate): both segments persisted exactly once', () => {
    const state: SessionState = { messages: [], isWorking: true, events: [], queue: [] }
    const apply = textThenTool(state)
    apply('response.output_text.delta', { delta: 'Final answer.' })
    apply('response.output_text.done', { item_id: 'msg_resp-1', text: `${TEXT}Final answer.` })
    apply('response.completed', { response: { id: 'resp-1', status: 'completed', output: [message(`${TEXT}Final answer.`)] } })

    expect(state.messages.map(m => m.role)).toEqual(['assistant', 'assistant', 'tool', 'assistant'])
    const textRows = state.messages.filter(m => m.role === 'assistant' && !m.tool_calls?.length)
    expect(textRows.map(m => m.content)).toEqual([TEXT, 'Final answer.'])
    expect(textRows[1].finish_reason).toBe('stop')

    flushResponseRunToDb(state, 's1')
    expect(persistedTextRows().map(r => r.content)).toEqual([TEXT, 'Final answer.'])
  })

  it('text -> tool -> text -> completed(last segment only): both segments persisted exactly once', () => {
    const state: SessionState = { messages: [], isWorking: true, events: [], queue: [] }
    const apply = textThenTool(state)
    apply('response.output_text.delta', { delta: 'Final answer.' })
    apply('response.output_text.done', { item_id: 'msg_resp-1', text: 'Final answer.' })
    apply('response.completed', { response: { id: 'resp-1', status: 'completed', output: [message('Final answer.')] } })

    expect(state.messages.filter(m => m.role === 'assistant' && !m.tool_calls?.length).map(m => m.content)).toEqual([TEXT, 'Final answer.'])
    flushResponseRunToDb(state, 's1')
    expect(persistedTextRows().map(r => r.content)).toEqual([TEXT, 'Final answer.'])
  })

  it('text -> tool -> completed(genuinely new text that was never streamed): a new segment is still created', () => {
    const state: SessionState = { messages: [], isWorking: true, events: [], queue: [] }
    const apply = textThenTool(state)
    apply('response.completed', { response: { id: 'resp-1', status: 'completed', output: [message('Brand new closing remark.')] } })

    expect(state.messages.map(m => m.role)).toEqual(['assistant', 'assistant', 'tool', 'assistant'])
    expect(state.messages[3]).toMatchObject({ content: 'Brand new closing remark.', finish_reason: 'stop' })
    flushResponseRunToDb(state, 's1')
    expect(persistedTextRows().map(r => r.content)).toEqual([TEXT, 'Brand new closing remark.'])
  })

  it('the terminal segment identity reported by flush is the streamed text row, not a duplicate', () => {
    const state: SessionState = { messages: [], isWorking: true, events: [], queue: [] }
    const apply = textThenTool(state)
    apply('response.completed', { response: { id: 'resp-1', status: 'completed', output: [message(TEXT)] } })
    const finalId = flushResponseRunToDb(state, 's1')
    expect(finalId).toBe('101')
    expect(state.messages[0]).toMatchObject({ id: 101, content: TEXT })
  })
})
