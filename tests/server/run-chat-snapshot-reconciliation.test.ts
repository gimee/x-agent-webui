import { describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/message-persistence', () => ({
  persistRunMessages: vi.fn(() => ({ ids: [], messages: [] })),
}))

describe('runtime resume snapshot reconciliation', () => {
  it('updates a DB tool row instead of appending a runtime row with another id', async () => {
    const { applyResponseStreamEvent } = await import('../../packages/server/src/modules/studio/services/chat-run/response-stream')
    const state: any = {
      messages: [{ id: 42, session_id: 's1', role: 'tool', content: 'old', tool_call_id: 'call-1', runMarker: 'run-1', timestamp: 1 }],
      events: [], queue: [], isWorking: true,
    }
    applyResponseStreamEvent(state, 's1', 'run-1', 'response.output_item.done', {
      item: { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{"cmd":"true"}' },
    })
    applyResponseStreamEvent(state, 's1', 'run-1', 'response.output_item.done', {
      item: { type: 'function_call_output', call_id: 'call-1', output: 'new result' },
    })
    expect(state.messages.filter((message: any) => message.role === 'tool')).toHaveLength(1)
    expect(state.messages.find((message: any) => message.role === 'tool')).toMatchObject({ id: 42, content: 'new result' })
  })

  it('keeps tool calls with the same provider id separate across runs', async () => {
    const { applyResponseStreamEvent } = await import('../../packages/server/src/modules/studio/services/chat-run/response-stream')
    const state: any = { messages: [], events: [], queue: [], isWorking: true }
    for (const run of ['run-1', 'run-2']) {
      applyResponseStreamEvent(state, 's1', run, 'response.output_item.done', {
        item: { type: 'function_call', call_id: 'same-call', name: 'shell', arguments: '{}' },
      })
      applyResponseStreamEvent(state, 's1', run, 'response.output_item.done', {
        item: { type: 'function_call_output', call_id: 'same-call', output: run },
      })
    }
    expect(state.messages.filter((message: any) => message.role === 'tool')).toHaveLength(2)
    expect(state.messages.filter((message: any) => message.role === 'tool').map((message: any) => message.runMarker)).toEqual(['run-1', 'run-2'])
  })
})
