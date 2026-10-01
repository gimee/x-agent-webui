import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

// hermes-v050:S9 — the production bundle (scripts/build-server.mjs) must ship
// the search worker next to dist/server/index.js, and that file must run.
// Needs a build: `node scripts/build-server.mjs` (skipped when dist is absent).

const ROOT = resolve(__dirname, '../..')
const DIST_SERVER = resolve(ROOT, 'dist/server')
const hasDist = existsSync(resolve(DIST_SERVER, 'index.js'))
const OPTIONS = { sources: ['cli'], profiles: ['default'], includeArchived: false }

describe.skipIf(!hasDist)('hermes-v050:S9 session search worker in dist/server', () => {
  let tempDir = ''
  let database: any
  let previousTestDbDir: string | undefined

  beforeEach(() => {
    vi.resetModules()
    tempDir = mkdtempSync(join(tmpdir(), 'hermes-v050-s9-dist-'))
    previousTestDbDir = process.env.HERMES_WEB_UI_TEST_DB_DIR
    process.env.HERMES_WEB_UI_TEST_DB_DIR = tempDir
  })

  afterEach(() => {
    database?.closeDb?.()
    if (previousTestDbDir === undefined) delete process.env.HERMES_WEB_UI_TEST_DB_DIR
    else process.env.HERMES_WEB_UI_TEST_DB_DIR = previousTestDbDir
    rmSync(tempDir, { recursive: true, force: true })
    vi.resetModules()
  })

  it('ships session-search-worker.js next to index.js and the server bundle points at it', () => {
    expect(existsSync(resolve(DIST_SERVER, 'session-search-worker.js'))).toBe(true)
    expect(readFileSync(resolve(DIST_SERVER, 'index.js'), 'utf8')).toContain('session-search-worker.js')
  })

  it('answers searches from the bundled worker on a WAL database', async () => {
    database = await import('../../packages/server/src/modules/studio/infrastructure/database/index')
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    const store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    store.createSession({ id: 'dist-chat', profile: 'default', source: 'cli', title: 'Bundle check' })
    store.addMessage({ session_id: 'dist-chat', role: 'assistant', content: 'Docker 压缩 ready', timestamp: 1 })
    const { SessionSearchWorkerPool, resolveSessionSearchWorkerScript } = await import('../../packages/server/src/modules/studio/services/session-search/worker-pool')
    const scriptPath = resolveSessionSearchWorkerScript({}, DIST_SERVER)
    expect(scriptPath).toBe(resolve(DIST_SERVER, 'session-search-worker.js'))
    const pool = new SessionSearchWorkerPool({ scriptPath, dbPath: database.getStoragePath(), fallback: store.searchSessions })
    try {
      for (const query of ['docker', '压缩', 'missing']) {
        const run = await pool.searchDetailed({ profile: undefined, query, limit: 50, options: OPTIONS })
        expect(run.via).toBe('worker')
        expect(run.rows).toEqual(store.searchSessions(undefined, query, 50, OPTIONS))
      }
      expect(pool.stats().startupFailures).toBe(0)
    } finally {
      await pool.close()
    }
  })

  it('hermes-v050:E-02 ranks an untitled coding-agent session by its displayed title in the bundled worker', async () => {
    database = await import('../../packages/server/src/modules/studio/infrastructure/database/index')
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    const store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    store.createSession({ id: 'dist-cli', profile: 'default', source: 'cli', title: 'Unrelated' })
    store.addMessage({ session_id: 'dist-cli', role: 'user', content: 'nova in the preview only', timestamp: 1 })
    store.createSession({ id: 'dist-ca', profile: 'default', source: 'coding_agent' })
    store.addMessage({ session_id: 'dist-ca', role: 'user', content: 'nova 上线检查', timestamp: 2 })
    const { SessionSearchWorkerPool, resolveSessionSearchWorkerScript } = await import('../../packages/server/src/modules/studio/services/session-search/worker-pool')
    const pool = new SessionSearchWorkerPool({ scriptPath: resolveSessionSearchWorkerScript({}, DIST_SERVER), dbPath: database.getStoragePath(), fallback: store.searchSessions })
    const options = { sources: ['cli', 'coding_agent'], profiles: ['default'], includeArchived: false }
    try {
      const run = await pool.searchDetailed({ profile: undefined, query: 'nova', options })
      expect(run.via).toBe('worker')
      expect(run.rows).toEqual(store.searchSessions(undefined, 'nova', undefined, options))
      expect(run.rows.map((row: any) => [row.id, row.rank])).toEqual([['dist-ca', 1], ['dist-cli', 2]])
    } finally {
      await pool.close()
    }
  })
})
