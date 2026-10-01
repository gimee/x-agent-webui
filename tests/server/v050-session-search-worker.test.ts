import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

// hermes-v050:S9 — session search runs in a worker_thread with its own
// read-only connection to the same (WAL) database; the main thread falls back
// when the worker cannot start, and queued/aborted/stuck jobs are handled.

const ROOT = resolve(__dirname, '../..')
const WORKER_ENTRY = resolve(ROOT, 'packages/server/src/modules/studio/services/session-search/worker.ts')
const POOL_MODULE = '../../packages/server/src/modules/studio/services/session-search/worker-pool'

let tempRoot = ''
let workerScript = ''
let previousTestDbDir: string | undefined

async function bundleWorker(outfile: string) {
  const esbuild = await import('esbuild')
  await esbuild.build({
    entryPoints: [WORKER_ENTRY],
    bundle: true,
    platform: 'node',
    target: 'node23',
    format: 'cjs',
    outfile,
    external: ['node:sqlite'],
    logLevel: 'silent',
  })
}

const OPTIONS = { sources: ['cli', 'coding_agent'], profiles: ['default'], includeArchived: false }

beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), 'hermes-v050-s9-'))
  workerScript = join(tempRoot, 'session-search-worker.cjs')
  await bundleWorker(workerScript)
})

afterAll(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
})

describe('hermes-v050:S9 session search worker pool', () => {
  let dbDir = ''
  let store: any
  let database: any

  beforeEach(async () => {
    vi.resetModules()
    dbDir = mkdtempSync(join(tempRoot, 'db-'))
    previousTestDbDir = process.env.HERMES_WEB_UI_TEST_DB_DIR
    process.env.HERMES_WEB_UI_TEST_DB_DIR = dbDir
    database = await import('../../packages/server/src/modules/studio/infrastructure/database/index')
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    store.createSession({ id: 'docker-chat', profile: 'default', source: 'cli', title: 'Container work' })
    store.addMessage({ session_id: 'docker-chat', role: 'assistant', content: 'Run Docker compose up', timestamp: 1 })
    store.createSession({ id: 'zh-chat', profile: 'default', source: 'coding_agent', title: '中文会话' })
    store.addMessage({ session_id: 'zh-chat', role: 'assistant', content: '上下文压缩已完成', timestamp: 2 })
    store.createSession({ id: 'tool-chat', profile: 'default', source: 'cli', title: 'Ops' })
    store.addMessage({ session_id: 'tool-chat', role: 'tool', content: 'ok', tool_name: 'Bash', timestamp: 3 })
  })

  afterEach(() => {
    database?.closeDb?.()
    if (previousTestDbDir === undefined) delete process.env.HERMES_WEB_UI_TEST_DB_DIR
    else process.env.HERMES_WEB_UI_TEST_DB_DIR = previousTestDbDir
    vi.resetModules()
  })

  async function makePool(overrides: Record<string, unknown> = {}) {
    const { SessionSearchWorkerPool } = await import(POOL_MODULE)
    return new SessionSearchWorkerPool({
      scriptPath: workerScript,
      dbPath: database.getStoragePath(),
      fallback: store.searchSessions,
      ...overrides,
    })
  }

  it('runs the search on a worker thread against the HERMES_WEB_UI_TEST_DB_DIR database', async () => {
    expect(database.getStoragePath()).toBe(join(dbDir, 'hermes-web-ui.db'))
    const pool = await makePool()
    try {
      for (const query of ['docker', 'DOCKER', '压缩', 'bash', 'nothing-here']) {
        const expected = store.searchSessions(undefined, query, 50, OPTIONS)
        const run = await pool.searchDetailed({ profile: undefined, query, limit: 50, options: OPTIONS })
        expect(run.via).toBe('worker')
        expect(run.threadId).toBeGreaterThan(0)
        expect(run.rows).toEqual(expected)
      }
    } finally {
      await pool.close()
    }
  })

  it('returns to the caller before the query finishes (the main thread is not blocked)', async () => {
    const pool = await makePool()
    try {
      await pool.search({ profile: undefined, query: 'warmup', options: OPTIONS })
      let immediateRan = false
      const started = performance.now()
      const pending = pool.searchDetailed({ profile: undefined, query: 'docker', limit: 50, options: OPTIONS })
      const syncMs = performance.now() - started
      setImmediate(() => { immediateRan = true })
      const run = await pending
      expect(run.via).toBe('worker')
      expect(syncMs).toBeLessThan(20)
      expect(immediateRan).toBe(true)
    } finally {
      await pool.close()
    }
  })

  it('serves concurrent searches independently and in order', async () => {
    const pool = await makePool()
    try {
      const queries = ['docker', '压缩', 'bash', 'ops', 'container']
      const runs = await Promise.all(queries.map(query => pool.searchDetailed({ profile: undefined, query, limit: 10, options: OPTIONS })))
      runs.forEach((run: any, index: number) => {
        expect(run.via).toBe('worker')
        expect(run.rows).toEqual(store.searchSessions(undefined, queries[index], 10, OPTIONS))
      })
    } finally {
      await pool.close()
    }
  })

  it('hermes-v050:E-02 ranks NULL-title coding-agent sessions by their displayed title identically on the worker and the main thread', async () => {
    store.createSession({ id: 'ca-docker', profile: 'default', source: 'coding_agent' })
    store.addMessage({ session_id: 'ca-docker', role: 'user', content: 'docker 上线检查', timestamp: 4 })
    // 20 astral emoji fill mapSessionRow's 40 UTF-16 code units, so 'docker' is not in the displayed title.
    store.createSession({ id: 'ca-astral', profile: 'default', source: 'coding_agent' })
    store.addMessage({ session_id: 'ca-astral', role: 'user', content: `${'😀'.repeat(20)}docker`, timestamp: 5 })
    const db = database.getDb()
    for (const [id, lastActive] of [['docker-chat', 300], ['ca-docker', 100], ['ca-astral', 200], ['zh-chat', 50], ['tool-chat', 40]] as const) {
      db.prepare('UPDATE sessions SET last_active = ? WHERE id = ?').run(lastActive, id)
    }
    const worker = await makePool()
    const main = await makePool({ scriptPath: null })
    try {
      for (const query of ['docker', 'DOCKER 上线', '上线', '😀', 'nothing-here']) {
        for (const limit of [undefined, 1, 50]) {
          const viaWorker = await worker.searchDetailed({ profile: undefined, query, limit, options: OPTIONS })
          const viaMain = await main.searchDetailed({ profile: undefined, query, limit, options: OPTIONS })
          expect(viaWorker.via).toBe('worker')
          expect(viaMain.via).toBe('main')
          expect(viaWorker.rows, `query ${JSON.stringify(query)} limit ${limit}`).toEqual(viaMain.rows)
        }
      }
      const rows = (await worker.searchDetailed({ profile: undefined, query: 'docker', options: OPTIONS })).rows
      expect(rows.map((row: any) => [row.id, row.rank])).toEqual([
        ['ca-docker', 1],
        ['ca-astral', 2],
        ['docker-chat', 3],
      ])
      expect(rows[0].title).toBe('docker 上线检查')
    } finally {
      await worker.close()
      await main.close()
    }
  })

  it('drops a queued search whose request was aborted before it reached the worker', async () => {
    const pool = await makePool()
    try {
      const first = pool.search({ profile: undefined, query: 'docker', options: OPTIONS })
      const controller = new AbortController()
      const second = pool.search({ profile: undefined, query: 'bash', options: OPTIONS }, { signal: controller.signal })
      const third = pool.search({ profile: undefined, query: '压缩', options: OPTIONS })
      controller.abort()
      await expect(second).rejects.toMatchObject({ name: 'AbortError' })
      expect((await first).map((row: any) => row.id)).toEqual(['docker-chat'])
      expect((await third).map((row: any) => row.id)).toEqual(['zh-chat'])
      expect(pool.stats().executed).toBe(2)
    } finally {
      await pool.close()
    }
  })

  it('falls back to the main thread when the worker script is missing', async () => {
    const pool = await makePool({ scriptPath: join(tempRoot, 'missing-worker.cjs') })
    try {
      const run = await pool.searchDetailed({ profile: undefined, query: 'docker', options: OPTIONS })
      expect(run.via).toBe('main')
      expect(run.rows.map((row: any) => row.id)).toEqual(['docker-chat'])
    } finally {
      await pool.close()
    }
  })

  it('falls back to the main thread when the worker cannot open the database', async () => {
    const pool = await makePool({ dbPath: join(dbDir, 'does-not-exist', 'hermes-web-ui.db') })
    try {
      const runs = await Promise.all([
        pool.searchDetailed({ profile: undefined, query: 'docker', options: OPTIONS }),
        pool.searchDetailed({ profile: undefined, query: 'bash', options: OPTIONS }),
      ])
      expect(runs.map((run: any) => run.via)).toEqual(['main', 'main'])
      expect(runs.map((run: any) => run.rows.map((row: any) => row.id))).toEqual([['docker-chat'], ['tool-chat']])
      expect(pool.stats().startupFailures).toBe(1)
    } finally {
      await pool.close()
    }
  })

  it('terminates a stuck worker after the timeout and serves the next search from a fresh worker', async () => {
    const script = join(tempRoot, 'hanging-worker.cjs')
    writeFileSync(script, `
const { parentPort, threadId } = require('node:worker_threads')
parentPort.postMessage({ type: 'ready' })
parentPort.on('message', (job) => {
  if (job.args.query === '__hang__') { for (;;) {} }
  parentPort.postMessage({ type: 'result', id: job.id, ok: true, rows: [{ id: job.args.query }], threadId, elapsedMs: 0 })
})
`)
    const pool = await makePool({ scriptPath: script, timeoutMs: 300 })
    try {
      const started = Date.now()
      await expect(pool.search({ profile: undefined, query: '__hang__', options: OPTIONS })).rejects.toMatchObject({ code: 'SESSION_SEARCH_TIMEOUT' })
      expect(Date.now() - started).toBeLessThan(5000)
      const run = await pool.searchDetailed({ profile: undefined, query: 'after', options: OPTIONS })
      expect(run.via).toBe('worker')
      expect(run.rows).toEqual([{ id: 'after' }])
      expect(pool.stats().terminated).toBe(1)
    } finally {
      await pool.close()
    }
  })

  it('hermes-v050:F-18 still replaces a stuck worker whose running search was aborted', async () => {
    const script = join(tempRoot, 'hanging-worker-abort.cjs')
    writeFileSync(script, `
const { parentPort, threadId } = require('node:worker_threads')
parentPort.postMessage({ type: 'ready' })
parentPort.on('message', (job) => {
  if (job.args.query === '__hang__') { for (;;) {} }
  parentPort.postMessage({ type: 'result', id: job.id, ok: true, rows: [{ id: job.args.query }], threadId, elapsedMs: 0 })
})
`)
    const pool = await makePool({ scriptPath: script, timeoutMs: 300 })
    try {
      const controller = new AbortController()
      const hung = pool.search({ profile: undefined, query: '__hang__', options: OPTIONS }, { signal: controller.signal })
      for (let i = 0; i < 100 && pool.stats().active === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 20))
      expect(pool.stats().active).toBe(1)
      controller.abort()
      await expect(hung).rejects.toMatchObject({ name: 'AbortError' })

      // The aborted search's deadline still guards the worker it left stuck.
      await new Promise(resolve => setTimeout(resolve, 600))
      expect(pool.stats()).toMatchObject({ terminated: 1, active: 0 })
      const run = await pool.searchDetailed({ profile: undefined, query: 'after', options: OPTIONS })
      expect(run.via).toBe('worker')
      expect(run.rows).toEqual([{ id: 'after' }])
    } finally {
      await pool.close()
    }
  })

  it('keeps the default pool on the main thread when no worker bundle sits next to the module (ts sources, tests)', async () => {
    const { getSessionSearchPool, resolveSessionSearchWorkerScript } = await import(POOL_MODULE)
    expect(resolveSessionSearchWorkerScript({})).toBeNull()
    expect(resolveSessionSearchWorkerScript({ HERMES_WEB_UI_SESSION_SEARCH_WORKER: workerScript })).toBe(workerScript)
    expect(resolveSessionSearchWorkerScript({ HERMES_WEB_UI_SESSION_SEARCH_WORKER: '0' })).toBeNull()
    const run = await getSessionSearchPool().searchDetailed({ profile: undefined, query: 'docker', options: OPTIONS })
    expect(run.via).toBe('main')
    expect(run.rows.map((row: any) => row.id)).toEqual(['docker-chat'])
  })
})

describe('hermes-v050:S9 search controller', () => {
  const searchMock = vi.fn()

  beforeEach(() => {
    vi.resetModules()
    searchMock.mockReset()
    vi.doMock(POOL_MODULE, () => ({
      searchSessionsOffMainThread: searchMock,
      isSessionSearchTimeout: (error: any) => error?.code === 'SESSION_SEARCH_TIMEOUT',
      isSessionSearchAbort: (error: any) => error?.name === 'AbortError',
    }))
    vi.doMock('../../packages/server/src/modules/studio/public/profile-config', () => ({
      getActiveProfileDir: () => '/tmp/hermes-test/default',
      getActiveProfileName: () => 'default',
      getProfileDir: (name: string) => `/tmp/hermes-test/${name || 'default'}`,
      listProfileNamesFromDisk: () => ['default'],
      readConfigYamlForProfile: vi.fn(),
    }))
  })

  afterEach(() => {
    vi.doUnmock(POOL_MODULE)
    vi.doUnmock('../../packages/server/src/modules/studio/public/profile-config')
    vi.resetModules()
  })

  function fakeCtx(query: Record<string, string>) {
    const listeners = new Map<string, () => void>()
    const res = {
      writableEnded: false,
      once: (event: string, listener: () => void) => { listeners.set(event, listener) },
      off: (event: string) => { listeners.delete(event) },
    }
    return { ctx: { query, state: {}, body: null as any, status: 200, res }, listeners }
  }

  it('awaits the off-thread search and passes an abort signal tied to the client connection', async () => {
    let seenSignal: AbortSignal | undefined
    searchMock.mockImplementation(async (_profile: unknown, _q: string, _limit: unknown, _options: unknown, extra: { signal?: AbortSignal }) => {
      seenSignal = extra?.signal
      return [{ id: 'docker-chat', profile: 'default', source: 'cli' }]
    })
    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const { ctx } = fakeCtx({ q: 'docker', limit: '50' })
    await mod.search(ctx)
    expect(searchMock).toHaveBeenCalledWith(undefined, 'docker', 50, expect.objectContaining({ includeArchived: false }), expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(seenSignal?.aborted).toBe(false)
    expect(ctx.body.results).toEqual([expect.objectContaining({ id: 'docker-chat' })])
  })

  it('aborts the search when the client disconnects and leaves the response alone', async () => {
    let seenSignal: AbortSignal | undefined
    let fired: (() => void) | undefined
    searchMock.mockImplementation((_p: unknown, _q: string, _l: unknown, _o: unknown, extra: { signal?: AbortSignal }) => {
      seenSignal = extra?.signal
      return new Promise((_resolve, reject) => {
        extra.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        fired?.()
      })
    })
    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const { ctx, listeners } = fakeCtx({ q: 'docker' })
    fired = () => listeners.get('close')?.()
    await mod.search(ctx)
    expect(seenSignal?.aborted).toBe(true)
    expect(ctx.body).toBeNull()
  })

  it('answers 503 when the search worker times out', async () => {
    searchMock.mockRejectedValue(Object.assign(new Error('Session search timed out'), { code: 'SESSION_SEARCH_TIMEOUT' }))
    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const { ctx } = fakeCtx({ q: 'docker' })
    await mod.search(ctx)
    expect(ctx.status).toBe(503)
    expect(ctx.body).toEqual({ error: 'Session search timed out', code: 'SESSION_SEARCH_TIMEOUT' })
  })
})
