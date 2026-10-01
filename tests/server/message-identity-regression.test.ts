import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('server canonical message identity', () => {
  let db: any

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      isSqliteAvailable: () => true,
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    const { createSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    createSession({ id: 's1', profile: 'default', source: 'cli', model: 'test', provider: 'test' })
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })

  it('returns the canonical persisted id on retry and preserves same-text distinct turns', async () => {
    const store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const first = store.addMessage({ session_id: 's1', role: 'user', content: 'same', client_message_id: 'cm-1', timestamp: 1 })
    const retry = store.addMessage({ session_id: 's1', role: 'user', content: 'same', client_message_id: 'cm-1', timestamp: 2 })
    const second = store.addMessage({ session_id: 's1', role: 'user', content: 'same', client_message_id: 'cm-2', timestamp: 3 })
    expect(retry).toBe(first)
    expect(second).not.toBe(first)
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get('s1')).toEqual({ count: 2 })
    expect(store.getSessionDetail('s1')?.messages.map(message => message.client_message_id)).toEqual(['cm-1', 'cm-2'])
  })

  it('keeps tool/assistant rows in raw history and throws when paginated history cannot be read', async () => {
    const store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    store.addMessage({ session_id: 's1', role: 'user', content: 'ask', client_message_id: 'cm-1', timestamp: 1 })
    store.addMessage({ session_id: 's1', role: 'assistant', content: 'answer', run_marker: 'run-1', timestamp: 2 })
    store.addMessage({ session_id: 's1', role: 'tool', content: 'tool result', tool_call_id: 'call-1', run_marker: 'run-1', timestamp: 3 })
    expect(store.getSessionDetailPaginated('s1', 0, 150)?.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool'])

    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => null,
      isSqliteAvailable: () => false,
    }))
    vi.resetModules()
    const unavailable = await import('../../packages/server/src/modules/studio/repositories/session-store')
    expect(() => unavailable.getSessionDetailPaginated('s1', 0, 150)).toThrow('SQLite database is unavailable')
  })
})
