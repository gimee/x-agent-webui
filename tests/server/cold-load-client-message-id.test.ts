import { describe, expect, it } from 'vitest'
import { handleMessage } from '../../packages/server/src/modules/studio/services/chat-run/message-format'

describe('S-F3: cold-loaded rows keep their identity / attribution fields', () => {
  const rows: any[] = [
    { id: 151, session_id: 's1', role: 'user', content: 'hello', client_message_id: 'cm_abc', run_marker: 'run-9', timestamp: 1 },
    {
      id: 152, session_id: 's1', role: 'assistant', content: '', client_message_id: 'am_def', run_marker: 'run-9', timestamp: 2,
      finish_reason: 'tool_calls', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'Bash', arguments: '{}' } }],
    },
    { id: 153, session_id: 's1', role: 'tool', content: 'ok', client_message_id: 'tm_ghi', run_marker: 'run-9', tool_call_id: 'call-1', tool_name: 'Bash', timestamp: 3 },
    { id: 154, session_id: 's1', role: 'assistant', content: 'hi', client_message_id: 'am_jkl', run_marker: 'run-9', timestamp: 4, finish_reason: 'stop' },
  ]

  it('copies client_message_id for user, assistant and tool rows', () => {
    const mapped = handleMessage(rows, 's1')
    expect(mapped).toHaveLength(4)
    expect(mapped.map(m => m.client_message_id)).toEqual(['cm_abc', 'am_def', 'tm_ghi', 'am_jkl'])
    expect(mapped.map(m => m.id)).toEqual([151, 152, 153, 154])
  })

  it('keeps run attribution and tool ownership fields alongside the identity', () => {
    const mapped = handleMessage(rows, 's1')
    for (const m of mapped) expect(m.runMarker).toBe('run-9')
    expect(mapped[1].tool_calls?.[0].id).toBe('call-1')
    expect(mapped[2].tool_call_id).toBe('call-1')
    expect(mapped[2].tool_name).toBe('Bash')
  })

  it('does not invent a client_message_id when the row has none', () => {
    const mapped = handleMessage([{ id: 1, session_id: 's1', role: 'user', content: 'x', timestamp: 1 } as any], 's1')
    expect(mapped[0]).not.toHaveProperty('client_message_id')
  })
})
