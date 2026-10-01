import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const DB_MODULE = '../../packages/server/src/modules/studio/infrastructure/database/index'

describe('sessions.preview persistence (no per-row correlated subquery)', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock(DB_MODULE, () => ({
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
    vi.doUnmock(DB_MODULE)
    vi.resetModules()
  })

  function storedPreview(id: string): string {
    return String((db.prepare('SELECT preview FROM sessions WHERE id = ?').get(id) as any).preview)
  }

  it('fills sessions.preview when the first user message is written via addMessage', async () => {
    const { addMessage, createSession, listSessions } = await import(
      '../../packages/server/src/modules/studio/repositories/session-store'
    )
    createSession({ id: 's1', profile: 'default', source: 'cli' })
    expect(storedPreview('s1')).toBe('')

    addMessage({ session_id: 's1', role: 'assistant', content: 'assistant first', timestamp: 1 })
    expect(storedPreview('s1')).toBe('')

    addMessage({ session_id: 's1', role: 'user', content: '  hello\nworld  ', timestamp: 2 })
    expect(storedPreview('s1')).toBe('hello world')

    // Later user messages do not overwrite the stored preview.
    addMessage({ session_id: 's1', role: 'user', content: 'second question', timestamp: 3 })
    expect(storedPreview('s1')).toBe('hello world')

    const [row] = listSessions(undefined, undefined, 10)
    expect(row.preview).toBe('hello world')
  })

  it('extracts text from content-block JSON and caps the preview at 100 chars', async () => {
    const { addMessages, createSession } = await import(
      '../../packages/server/src/modules/studio/repositories/session-store'
    )
    createSession({ id: 's2', profile: 'default', source: 'cli' })
    const longText = 'x'.repeat(150)
    addMessages([{
      session_id: 's2',
      role: 'user',
      content: JSON.stringify([
        { type: 'text', text: 'look at this' },
        { type: 'image', path: '/tmp/a.png' },
        { type: 'text', text: longText },
      ]),
      timestamp: 5,
    }])
    const preview = storedPreview('s2')
    expect(preview.startsWith('look at this x')).toBe(true)
    expect(preview.length).toBe(100)
  })

  it('backfills empty previews once at startup and is a no-op afterwards', async () => {
    const { backfillSessionPreviews, listSessions } = await import(
      '../../packages/server/src/modules/studio/repositories/session-store'
    )
    const now = Math.floor(Date.now() / 1000)
    const insertSession = db.prepare(
      `INSERT INTO sessions (id, profile, source, started_at, last_active, preview) VALUES (?, 'default', 'cli', ?, ?, '')`,
    )
    const insertMessage = db.prepare(
      `INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)`,
    )
    insertSession.run('legacy-1', now, now)
    insertMessage.run('legacy-1', 'assistant', 'welcome', 10)
    insertMessage.run('legacy-1', 'user', 'first legacy question', 20)
    insertMessage.run('legacy-1', 'user', 'second legacy question', 30)
    insertSession.run('legacy-2', now, now + 1)
    insertMessage.run('legacy-2', 'assistant', 'no user message at all', 10)
    insertSession.run('legacy-3', now, now + 2)
    insertMessage.run('legacy-3', 'user', JSON.stringify([{ type: 'text', text: 'blocks question' }]), 10)

    const first = backfillSessionPreviews()
    expect(first.updated).toBe(2)
    expect(storedPreview('legacy-1')).toBe('first legacy question')
    expect(storedPreview('legacy-2')).toBe('')
    expect(storedPreview('legacy-3')).toBe('blocks question')

    const second = backfillSessionPreviews()
    expect(second.updated).toBe(0)

    const rows = listSessions(undefined, undefined, 10)
    expect(rows.find(r => r.id === 'legacy-1')?.preview).toBe('first legacy question')
    // Fallback subquery still covers sessions that could not be backfilled.
    insertMessage.run('legacy-2', 'user', 'late user message', 40)
    expect(listSessions(undefined, undefined, 10).find(r => r.id === 'legacy-2')?.preview).toBe('late user message')
  })

  it('runs the backfill from initAllStores', async () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare(`INSERT INTO sessions (id, profile, source, started_at, last_active, preview) VALUES ('boot-1', 'default', 'cli', ?, ?, '')`).run(now, now)
    db.prepare(`INSERT INTO messages (session_id, role, content, timestamp) VALUES ('boot-1', 'user', 'boot question', 1)`).run()
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    initAllStores()
    expect(storedPreview('boot-1')).toBe('boot question')
  })
})
