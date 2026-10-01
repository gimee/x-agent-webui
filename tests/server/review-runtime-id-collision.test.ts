import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyResponseStreamEvent, flushResponseRunToDb } from '../../packages/server/src/modules/studio/services/chat-run/response-stream'
import type { SessionState } from '../../packages/server/src/modules/studio/services/chat-run/types'

const { addMessageMock } = vi.hoisted(() => ({ addMessageMock: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({ addMessage: addMessageMock }))

/**
 * Simulate loadSessionStateFromDb for a session whose persisted rows have small
 * SQLite ids (fresh database) and more than the 150-row resume window: the
 * loaded window holds ids 2..151, so the first runtime row's sequence number
 * (150 + 1) equals the rowid of a loaded history row.
 */
function dbWindow(): any[] {
  const rows: any[] = []
  for (let id = 2; id <= 151; id++) {
    rows.push({
      id,
      session_id: 's1',
      role: id % 2 === 0 ? 'user' : 'assistant',
      content: `db row ${id}`,
      timestamp: 1_700_000_000 + id,
      finish_reason: id % 2 === 0 ? undefined : 'stop',
    })
  }
  return rows
}

function textToolText(state: SessionState) {
  const apply = (type: string, data: any) => applyResponseStreamEvent(state, 's1', 'run-1', type, data)
  apply('response.created', { response: { id: 'resp-1', status: 'in_progress' } })
  apply('response.output_text.delta', { delta: 'Let me check.' })
  apply('response.output_item.done', { item: { type: 'function_call', call_id: 'toolu_1', name: 'Bash', arguments: '{"cmd":"ls"}' } })
  apply('response.output_item.done', { item: { type: 'function_call_output', call_id: 'toolu_1', output: 'ok' } })
  apply('response.output_text.delta', { delta: 'Final answer.' })
  apply('response.output_text.done', { text: 'Final answer.' })
  apply('response.completed', { response: { id: 'resp-1', status: 'completed', output: [] } })
}

describe('S-F1: coding-agent runtime row ids never collide with loaded DB row ids', () => {
  beforeEach(() => { addMessageMock.mockReset(); let id = 100_000; addMessageMock.mockImplementation(() => ++id) })

  it('keeps every runtime row of the run distinct from DB row 151 and persists all four rows', () => {
    const state: SessionState = { messages: dbWindow(), isWorking: true, events: [], queue: [] }
    const originalRow151 = { ...state.messages.find(m => m.id === 151)! }
    expect(state.messages).toHaveLength(150)

    textToolText(state)

    // History row untouched, four new rows appended.
    expect(state.messages).toHaveLength(154)
    expect(state.messages.find(m => m.id === 151)).toMatchObject({ content: originalRow151.content, role: originalRow151.role })
    expect(state.messages.find(m => m.id === 151)!.runMarker).toBeUndefined()

    const runRows = state.messages.filter(m => m.runMarker === 'run-1')
    expect(runRows.map(m => m.role)).toEqual(['assistant', 'assistant', 'tool', 'assistant'])
    expect(runRows.map(m => m.content)).toEqual(['Let me check.', '', 'ok', 'Final answer.'])
    // Provisional ids are negative and unique.
    for (const row of runRows) expect(typeof row.id === 'number' && row.id < 0).toBe(true)
    expect(new Set(runRows.map(m => m.id)).size).toBe(4)

    flushResponseRunToDb(state, 's1')
    const persisted = addMessageMock.mock.calls.map(call => call[0])
    expect(persisted).toHaveLength(4)
    expect(persisted.map(r => r.role)).toEqual(['assistant', 'assistant', 'tool', 'assistant'])
    expect(persisted[0].content).toBe('Let me check.')
    expect(persisted[3].content).toBe('Final answer.')
  })

  it('control: same stream with large DB ids behaves identically', () => {
    const rows = dbWindow().map(r => ({ ...r, id: r.id + 100_000 }))
    const state: SessionState = { messages: rows, isWorking: true, events: [], queue: [] }
    textToolText(state)
    expect(state.messages.filter(m => m.runMarker === 'run-1')).toHaveLength(4)
    flushResponseRunToDb(state, 's1')
    expect(addMessageMock.mock.calls).toHaveLength(4)
  })

  it('guard: a DB row whose id equals the runtime sequence number is never merged into (id, length+1, and -(length+1) shapes)', () => {
    // Three history rows carrying exactly the ids a naive `length + 1` scheme
    // would hand out to the first runtime row, plus the negative shape in case a
    // stale provisional row ever survived in state.
    const state: SessionState = {
      messages: [
        { id: 4, session_id: 's1', role: 'user', content: 'u', timestamp: 1 },
        { id: 3, session_id: 's1', role: 'assistant', content: 'db three', timestamp: 2, finish_reason: 'stop' },
        { id: -4, session_id: 's1', role: 'assistant', content: 'stale provisional', timestamp: 3, finish_reason: 'stop', runMarker: 'run-old' },
      ],
      isWorking: true,
      events: [],
      queue: [],
    }
    const apply = (type: string, data: any) => applyResponseStreamEvent(state, 's1', 'run-1', type, data)
    apply('response.created', { response: { id: 'resp-1', status: 'in_progress' } })
    apply('response.output_text.delta', { delta: 'fresh' })
    expect(state.messages).toHaveLength(4)
    expect(state.messages[0].content).toBe('u')
    expect(state.messages[1].content).toBe('db three')
    // The stale negative row belongs to another run: it must not be absorbed
    // either, even though it shares the provisional shape.
    expect(state.messages[2].content).toBe('stale provisional')
    const fresh = state.messages[3]
    expect(fresh).toMatchObject({ runMarker: 'run-1', content: 'fresh' })
    expect(typeof fresh.id === 'number' && fresh.id < 0).toBe(true)
    // The stale row already holds -4, so the fresh row must skip to the next free slot.
    expect(fresh.id).toBe(-5)
    expect(state.messages.filter(m => m.id === fresh.id)).toHaveLength(1)
  })

  it('guard: provisional negative ids are rebound to persisted positive ids on flush (including reasoningMessageId)', () => {
    const state: SessionState = { messages: dbWindow().slice(0, 3), isWorking: true, events: [], queue: [] }
    addMessageMock.mockReset()
    addMessageMock.mockReturnValueOnce(901).mockReturnValueOnce(902).mockReturnValueOnce(903).mockReturnValueOnce(904)
    const apply = (type: string, data: any) => applyResponseStreamEvent(state, 's1', 'run-1', type, data)
    apply('response.created', { response: { id: 'resp-1', status: 'in_progress' } })
    apply('response.reasoning.delta', { delta: 'thinking' })
    apply('response.output_text.delta', { delta: 'Let me check.' })
    apply('response.output_item.done', { item: { type: 'function_call', call_id: 'toolu_1', name: 'Bash', arguments: '{}' } })
    apply('response.output_item.done', { item: { type: 'function_call_output', call_id: 'toolu_1', output: 'ok' } })
    apply('response.reasoning.delta', { delta: 'more thinking' })
    apply('response.output_text.delta', { delta: 'Final answer.' })

    const runRows = state.messages.filter(m => m.runMarker === 'run-1')
    expect(runRows.map(m => m.id)).toEqual([-4, -5, -6, -7])
    expect(state.responseRun?.reasoningMessageId).toBe(-7)

    expect(flushResponseRunToDb(state, 's1')).toBe('904')
    expect(runRows.map(m => m.id)).toEqual([901, 902, 903, 904])
    expect(state.responseRun?.reasoningMessageId).toBe(904)
    // History rows keep their DB ids.
    expect(state.messages.slice(0, 3).map(m => m.id)).toEqual([2, 3, 4])
  })
})
