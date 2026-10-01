import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// hermes-v050:E-02 — coding-agent (Claude/Codex/…) sessions store title = NULL;
// the title the UI shows comes from mapSessionRow's preview fallback. Search
// ranks 0/1 must use that same displayed title, otherwise those sessions can
// never be title matches and sink below every CLI title hit.

const DB_MODULE = '../../packages/server/src/modules/studio/infrastructure/database/index'
const STORE_MODULE = '../../packages/server/src/modules/studio/repositories/session-store'
const OPTIONS = { sources: ['cli', 'coding_agent'], profiles: ['default'], includeArchived: false }

describe('hermes-v050:E-02 session search ranks by the displayed title', () => {
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

  function seed(store: any, id: string, source: string, title: string | null, preview: string, lastActive: number, body?: string) {
    store.createSession({ id, profile: 'default', source, ...(title ? { title } : {}) })
    if (body) store.addMessage({ session_id: id, role: 'assistant', content: body, timestamp: lastActive })
    db.prepare('UPDATE sessions SET title = ?, preview = ?, last_active = ? WHERE id = ?').run(title, preview, lastActive, id)
  }

  it('ranks a NULL-title coding-agent session whose preview-derived title contains the term with the CLI title hits', async () => {
    const store = await import(STORE_MODULE)
    seed(store, 'cli-title-new', 'cli', 'Nova market notes', 'unrelated', 500)
    seed(store, 'cli-title-old', 'cli', 'nova strategy', 'unrelated', 100)
    seed(store, 'cli-preview', 'cli', 'Unrelated title', 'the nova preview', 900)
    seed(store, 'cli-body', 'cli', 'Other title', 'nothing', 1000, 'body mentions nova')
    seed(store, 'ca-nova', 'coding_agent', null, 'nova 上线检查', 300)

    const results = store.searchSessions(undefined, 'nova', undefined, OPTIONS)

    expect(results.map((row: any) => [row.id, row.rank])).toEqual([
      ['cli-title-new', 1],
      ['ca-nova', 1],
      ['cli-title-old', 1],
      ['cli-preview', 2],
      ['cli-body', 3],
    ])
    expect(results[1]).toEqual(expect.objectContaining({ source: 'coding_agent', title: 'nova 上线检查' }))
    // A limited request keeps it ahead of newer preview/body matches as well.
    expect(store.searchSessions(undefined, 'nova', 2, OPTIONS).map((row: any) => row.id)).toEqual(['cli-title-new', 'ca-nova'])
  })

  it('uses the same 40-code-unit fallback as mapSessionRow (no trim, "..." suffix, UTF-16 slice)', async () => {
    const store = await import(STORE_MODULE)
    // 'nova' ends exactly at code unit 40: the displayed title still shows it.
    seed(store, 'ca-edge', 'coding_agent', null, `${'x'.repeat(36)}nova tail`, 600)
    // 'nova' starts at code unit 38: the title is cut to "xx…no..." and does not show it.
    seed(store, 'ca-cut', 'coding_agent', null, `${'x'.repeat(38)}nova tail`, 500)
    // 20 astral emoji = 40 UTF-16 code units: JS slice(0, 40) drops 'nova' although
    // SQLite's SUBSTR(preview, 1, 40) (which counts characters) would keep it.
    seed(store, 'ca-astral', 'coding_agent', null, `${'😀'.repeat(20)}nova`, 400)
    // An empty-string title falls back like NULL (`rawTitle || …`).
    seed(store, 'ca-empty-title', 'coding_agent', '', 'nova with empty title', 300)
    // Leading spaces are kept verbatim in the displayed title.
    seed(store, 'ca-spaces', 'coding_agent', null, '   nova spaced', 200)

    const results = store.searchSessions(undefined, 'nova', undefined, OPTIONS)
    const byId = new Map(results.map((row: any) => [row.id, row]))

    expect([...byId.keys()].sort()).toEqual(['ca-astral', 'ca-cut', 'ca-edge', 'ca-empty-title', 'ca-spaces'])
    expect(results.map((row: any) => [row.id, row.rank])).toEqual([
      ['ca-edge', 1],
      ['ca-empty-title', 1],
      ['ca-spaces', 1],
      ['ca-cut', 2],
      ['ca-astral', 2],
    ])
    for (const row of results as any[]) {
      // The row's title is exactly what the list/detail endpoints (mapSessionRow) show …
      expect(row.title).toBe(store.getSession(row.id)!.title)
      // … and rank 1 holds exactly when that displayed title contains the term.
      expect(row.rank === 1).toBe(String(row.title).toLowerCase().includes('nova'))
    }
    expect(byId.get('ca-cut')!.title).toBe(`${'x'.repeat(38)}no...`)
    expect(byId.get('ca-astral')!.title).toBe(`${'😀'.repeat(20)}...`)
  })

  it('gives an exact displayed-title match rank 0, like an exact CLI title', async () => {
    const store = await import(STORE_MODULE)
    seed(store, 'cli-exact', 'cli', 'Nova', 'unrelated', 100)
    seed(store, 'ca-exact', 'coding_agent', null, 'nova', 50)
    seed(store, 'cli-partial', 'cli', 'nova notes', 'unrelated', 900)

    expect(store.searchSessions(undefined, 'NOVA', undefined, OPTIONS).map((row: any) => [row.id, row.rank])).toEqual([
      ['cli-exact', 0],
      ['ca-exact', 0],
      ['cli-partial', 1],
    ])
  })

  it('matches every term of a multi-word query against the displayed title', async () => {
    const store = await import(STORE_MODULE)
    seed(store, 'ca-both', 'coding_agent', null, 'Hermes WebUI 示例项目 v0.5.0 第二轮评审', 100)
    seed(store, 'ca-one', 'coding_agent', null, 'Hermes gateway only', 200, 'hermes webui in the body')
    seed(store, 'cli-both', 'cli', 'webui for hermes', 'x', 50)

    expect(store.searchSessions(undefined, 'hermes webui', undefined, OPTIONS).map((row: any) => [row.id, row.rank])).toEqual([
      ['ca-both', 1],
      ['cli-both', 1],
      ['ca-one', 3],
    ])
  })
})
