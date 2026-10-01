import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createServer, type Server } from 'node:http'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

// hermes-v050:S6 — session list polling: weak ETag + `Cache-Control: private,
// no-cache` so the browser revalidates every 12s poll and gets a bodyless 304
// when nothing changed; `fields=lite` returns only what the chat sidebar reads
// while the default response keeps every column for App/MCP callers.

const DB_MODULE = '../../packages/server/src/modules/studio/infrastructure/database/index'
const PROFILE_CONFIG = '../../packages/server/src/modules/studio/public/profile-config'

const FULL_KEYS = [
  'id', 'profile', 'source', 'agent', 'agent_mode', 'agent_session_id', 'agent_native_session_id', 'user_id',
  'model', 'provider', 'api_mode', 'reasoning_effort', 'context_tokens', 'title', 'parent_session_id',
  'fork_point_message_id', 'started_at', 'ended_at', 'end_reason', 'message_count', 'tool_call_count',
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens',
  'billing_provider', 'estimated_cost_usd', 'actual_cost_usd', 'cost_status', 'preview', 'last_active',
  'is_archived', 'push_enabled', 'workspace', 'history_revision', 'parent_title', 'parent_last_message',
  'parent_last_message_role',
].sort()

let raw: any = null
let server: Server | null = null
let baseUrl = ''
let store: any

async function startApp() {
  const Koa = (await import('koa')).default
  const { createApiCompressionMiddleware } = await import('../../packages/server/src/modules/studio/middleware/api-compression')
  const controllers = await import('../../packages/server/src/modules/studio/controllers/sessions')
  const app = new Koa()
  app.use(createApiCompressionMiddleware())
  app.use(async (ctx) => {
    if (ctx.path === '/api/studio/sessions') await controllers.list(ctx)
  })
  server = createServer(app.callback())
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()))
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}

function get(path: string, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${path}`, { headers: { 'accept-encoding': 'gzip', ...headers } })
}

describe('hermes-v050:S6 session list ETag and lite fields', () => {
  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    raw = new DatabaseSync(':memory:')
    vi.doMock(DB_MODULE, () => ({
      getDb: () => raw,
      isSqliteAvailable: () => true,
      getStoragePath: () => ':memory:',
    }))
    vi.doMock(PROFILE_CONFIG, () => ({
      getActiveProfileDir: () => '/tmp/hermes-test/default',
      getActiveProfileName: () => 'default',
      getProfileDir: (name: string) => `/tmp/hermes-test/${name || 'default'}`,
      listProfileNamesFromDisk: () => ['default'],
      readConfigYamlForProfile: vi.fn(),
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    for (let index = 0; index < 12; index += 1) {
      store.createSession({
        id: `session-${index}`,
        profile: 'default',
        source: index % 3 === 0 ? 'coding_agent' : 'cli',
        agent: index % 3 === 0 ? 'claude' : 'hermes',
        title: `Session number ${index} with a reasonably long title`,
        model: 'claude-opus-5-5',
        provider: index % 2 ? '' : 'anthropic',
        workspace: `/home/agent/workspace/project-${index}`,
      })
      store.addMessage({ session_id: `session-${index}`, role: 'user', content: `first question ${index}`, timestamp: 100 + index })
    }
    await startApp()
  })

  afterEach(async () => {
    await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()))
    server = null
    raw?.close()
    raw = null
    vi.doUnmock(DB_MODULE)
    vi.doUnmock(PROFILE_CONFIG)
    vi.resetModules()
  })

  it('sends a weak ETag with private, no-cache and answers a matching If-None-Match with an empty 304', async () => {
    const first = await get('/api/studio/sessions')
    expect(first.status).toBe(200)
    const etag = first.headers.get('etag')
    expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/)
    expect(first.headers.get('cache-control')).toBe('private, no-cache')
    expect(first.headers.get('content-encoding')).toBe('gzip')
    expect((await first.json()).sessions).toHaveLength(12)

    const second = await get('/api/studio/sessions', { 'if-none-match': etag! })
    expect(second.status).toBe(304)
    expect(second.headers.get('etag')).toBe(etag)
    expect(second.headers.get('content-encoding')).toBeNull()
    expect(await second.text()).toBe('')
  })

  it('changes the ETag when the list changes', async () => {
    const etag = (await get('/api/studio/sessions')).headers.get('etag')!
    store.renameSession('session-3', 'Renamed elsewhere')

    const changed = await get('/api/studio/sessions', { 'if-none-match': etag })
    expect(changed.status).toBe(200)
    expect(changed.headers.get('etag')).not.toBe(etag)
    expect((await changed.json()).sessions.find((row: any) => row.id === 'session-3').title).toBe('Renamed elsewhere')
  })

  it('uses weak comparison for If-None-Match lists and ignores other tags', async () => {
    const etag = (await get('/api/studio/sessions')).headers.get('etag')!
    const opaque = etag.slice(2)
    expect((await get('/api/studio/sessions', { 'if-none-match': 'W/"other", "nope"' })).status).toBe(200)
    expect((await get('/api/studio/sessions', { 'if-none-match': `"nope", ${etag}` })).status).toBe(304)
    expect((await get('/api/studio/sessions', { 'if-none-match': opaque })).status).toBe(304)
    expect((await get('/api/studio/sessions', { 'if-none-match': '*' })).status).toBe(304)
  })

  it('keeps every column by default and returns only the sidebar fields for fields=lite', async () => {
    const { SESSION_LIST_LITE_FIELDS } = await import('../../packages/server/src/modules/studio/contracts/session-list')
    const full = (await (await get('/api/studio/sessions')).json()).sessions
    expect(Object.keys(full[0]).sort()).toEqual(FULL_KEYS)

    const liteResponse = await get('/api/studio/sessions?fields=lite')
    expect(liteResponse.status).toBe(200)
    expect(liteResponse.headers.get('etag')).toMatch(/^W\/"/)
    const lite = (await liteResponse.json()).sessions
    expect(lite).toHaveLength(full.length)
    expect(Object.keys(lite[0]).sort()).toEqual([...SESSION_LIST_LITE_FIELDS].sort())
    lite.forEach((row: any, index: number) => {
      for (const key of SESSION_LIST_LITE_FIELDS) expect(row[key]).toEqual(full[index][key])
    })
    expect(JSON.stringify(lite).length).toBeLessThan(JSON.stringify(full).length)

    const etag = liteResponse.headers.get('etag')!
    expect((await get('/api/studio/sessions?fields=lite', { 'if-none-match': etag })).status).toBe(304)
  })
})
