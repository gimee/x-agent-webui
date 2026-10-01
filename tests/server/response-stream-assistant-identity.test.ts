import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { applyResponseStreamEvent, flushResponseRunToDb } from '../../packages/server/src/modules/studio/services/chat-run/response-stream'
import type { SessionState } from '../../packages/server/src/modules/studio/services/chat-run/types'

const { addMessageMock } = vi.hoisted(() => ({ addMessageMock: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({ addMessage: addMessageMock }))

const AM = /^am_[0-9a-f-]{36}$/

function textToolText(state: SessionState) {
  const out: Array<ReturnType<typeof applyResponseStreamEvent>> = []
  const apply = (type: string, data: any) => { const mapped = applyResponseStreamEvent(state, 's1', 'run-1', type, data); out.push(mapped); return mapped }
  apply('response.created', { response: { id: 'resp-1', status: 'in_progress' } })
  apply('response.reasoning.delta', { delta: 'think ' })
  apply('response.output_text.delta', { delta: 'First segment.' })
  apply('response.output_item.done', { item: { type: 'function_call', call_id: 'toolu_1', name: 'Bash', arguments: '{"cmd":"ls"}' } })
  apply('response.output_item.done', { item: { type: 'function_call_output', call_id: 'toolu_1', output: 'ok' } })
  apply('response.output_text.delta', { delta: 'Final ' })
  apply('response.output_text.delta', { delta: 'answer.' })
  apply('response.output_text.done', { text: 'Final answer.' })
  apply('response.completed', { response: { id: 'resp-1', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'First segment.Final answer.' }] }] } })
  return out.filter(Boolean) as Array<{ event: string; payload: any }>
}

describe('response-stream assistant segment identity (coding-agent path)', () => {
  beforeEach(() => { addMessageMock.mockReset(); let id = 100; addMessageMock.mockImplementation(() => ++id) })

  it('gives every assistant segment its own am_ identity and echoes it on message deltas', () => {
    const state: SessionState = { messages: [], isWorking: false, events: [], queue: [] }
    const events = textToolText(state)
    const assistants = state.messages.filter(m => m.role === 'assistant')
    expect(assistants.map(m => m.content)).toEqual(['First segment.', '', 'Final answer.'])
    for (const row of assistants) expect(row.client_message_id).toMatch(AM)
    expect(new Set(assistants.map(m => m.client_message_id)).size).toBe(3)

    const deltas = events.filter(e => e.event === 'message.delta').map(e => e.payload)
    expect(deltas).toHaveLength(3)
    expect(deltas[0].client_message_id).toBe(assistants[0].client_message_id)
    expect(deltas[1].client_message_id).toBe(assistants[2].client_message_id)
    expect(deltas[2].client_message_id).toBe(assistants[2].client_message_id)
    // Same-run segments must be distinguishable on the wire.
    expect(deltas[0].client_message_id).not.toBe(deltas[1].client_message_id)

    const started = events.find(e => e.event === 'tool.started')!.payload
    expect(started.assistant_client_message_id).toBe(assistants[1].client_message_id)
    // Tool cards keep their own identity; they never borrow the text segment's.
    expect(assistants[1].client_message_id).not.toBe(assistants[0].client_message_id)
  })

  it('keeps a tool row identity when Claude reports the call as added + done back to back', () => {
    const state: SessionState = { messages: [], isWorking: false, events: [], queue: [] }
    const apply = (type: string, data: any) => applyResponseStreamEvent(state, 's1', 'run-1', type, data)
    apply('response.created', { response: { id: 'resp-1', status: 'in_progress' } })
    apply('response.output_text.delta', { delta: 'First segment.' })
    const started = apply('response.output_item.added', { item: { type: 'function_call', call_id: 'toolu_1', name: 'Bash', arguments: '{"cmd":"ls"}' } })
    expect(started?.event).toBe('tool.started')
    // The row is created on `done`; `added` fires before it exists, so it carries no owner yet.
    expect(started?.payload.assistant_client_message_id).toBeUndefined()
    expect(apply('response.output_item.done', { item: { type: 'function_call', call_id: 'toolu_1', name: 'Bash', arguments: '{"cmd":"ls"}' } })).toBeNull()
    const toolRow = state.messages.find(m => m.role === 'assistant' && m.tool_calls?.length)
    expect(toolRow?.client_message_id).toMatch(AM)
    expect(toolRow?.client_message_id).not.toBe(state.messages[0].client_message_id)
    const completed = apply('response.output_item.done', { item: { type: 'function_call_output', call_id: 'toolu_1', output: 'ok' } })
    expect(completed?.event).toBe('tool.completed')
    const next = apply('response.output_text.delta', { delta: 'Final answer.' })
    expect(next?.payload.client_message_id).toMatch(AM)
    expect(next?.payload.client_message_id).not.toBe(state.messages[0].client_message_id)
  })

  it('persists the segment identity and returns the final text segment id', () => {
    const state: SessionState = { messages: [], isWorking: false, events: [], queue: [] }
    textToolText(state)
    const finalId = flushResponseRunToDb(state, 's1')
    const rows = addMessageMock.mock.calls.map(call => call[0])
    const persistedAssistants = rows.filter(r => r.role === 'assistant')
    expect(persistedAssistants).toHaveLength(3)
    for (const row of persistedAssistants) expect(row.client_message_id).toMatch(AM)
    const finalRow = state.messages.find(m => String(m.id) === String(finalId))
    expect(finalRow?.content).toBe('Final answer.')
    expect(finalRow?.client_message_id).toMatch(AM)
  })

  it('run-manager never stamps the user cm_ id on streamed assistant events and reports the terminal segment', () => {
    const src = readFileSync(new URL('../../packages/server/src/modules/coding-agents/services/runtime/run-manager.ts', import.meta.url), 'utf8')
    const handler = src.slice(src.indexOf('handleResponseEvent(agentSessionId'), src.indexOf('private persistTerminalResponse'))
    expect(handler).not.toContain('client_message_id: run.clientMessageId')
    const terminal = src.slice(src.indexOf('private emitAndMarkPrintChatRunCompleted('), src.indexOf('private emitAndMarkPrintChatRunCompleted(') + 2500)
    expect(terminal).not.toContain('client_message_id: run.clientMessageId')
    expect(terminal).toContain('assistant_content')
    expect(terminal).toContain('assistant_reasoning')
  })
})
