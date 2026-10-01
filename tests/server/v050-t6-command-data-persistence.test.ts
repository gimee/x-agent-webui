// hermes-v050:T6 — 回执的 code 与参数随消息行持久化（messages.command_data），刷新后能读回：
// REST 分页、冷启动 load-state、resume 快照都带出来；英文 content 不变；老库自动补列。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('hermes-v050:T6 command_data persistence', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      isSqliteAvailable: () => true,
      getStoragePath: () => ':memory:',
    }))
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.doUnmock('../../packages/server/src/modules/studio/services/chat-run/usage')
    vi.doUnmock('../../packages/server/src/modules/studio/services/chat-run/abort')
    vi.doUnmock('../../packages/server/src/modules/studio/public/logging')
    vi.resetModules()
  })

  it('adds a nullable command_data column to an existing messages table without touching old rows', async () => {
    db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', timestamp INTEGER NOT NULL)`)
    db.prepare(`INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)`).run('old', 'command', 'Abort requested.', 1)
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    const columns = (db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string; notnull: number; dflt_value: unknown }>)
    const column = columns.find(col => col.name === 'command_data')
    expect(column).toEqual(expect.objectContaining({ name: 'command_data', notnull: 0, dflt_value: null }))
    expect(db.prepare(`SELECT content, command_data FROM messages WHERE session_id = 'old'`).get()).toEqual({ content: 'Abort requested.', command_data: null })
  })

  it('writes and reads back code + params next to the unchanged English content', async () => {
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    const store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    store.createSession({ id: 's1', profile: 'default', source: 'cli', title: 'x' })
    const commandData = JSON.stringify({ messageCode: 'hermes_queue_queued', messageParams: { length: 2 } })
    const id = store.addMessage({ session_id: 's1', role: 'command', content: 'Queued message. Queue length: 2.', command_data: commandData, timestamp: 5 } as any)
    store.addMessage({ session_id: 's1', role: 'command', content: '/queue later', timestamp: 4 })

    const page = store.getSessionDetailPaginated('s1')!
    const row = page.messages.find(message => message.id === id) as any
    expect(row.content).toBe('Queued message. Queue length: 2.')
    expect(JSON.parse(row.command_data)).toEqual({ messageCode: 'hermes_queue_queued', messageParams: { length: 2 } })
    const echo = page.messages.find(message => message.content === '/queue later') as any
    expect(echo).toBeTruthy()
    expect('command_data' in echo).toBe(false)

    const detail = store.getSessionDetail('s1')!
    expect((detail.messages.find(message => message.id === id) as any).command_data).toBe(commandData)
  })

  it('keeps command_data through the cold-load state and the resume snapshot', async () => {
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    const store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    store.createSession({ id: 's2', profile: 'default', source: 'cli', title: 'x' })
    const commandData = JSON.stringify({ messageCode: 'hermes_abort_requested' })
    store.addMessage({ session_id: 's2', role: 'command', content: 'Abort requested.', command_data: commandData, timestamp: 5 } as any)

    const { loadSessionStateFromDb } = await import('../../packages/server/src/modules/studio/services/chat-run/load-state')
    const state = await loadSessionStateFromDb('s2', new Map())
    const loaded = state.messages.find((message: any) => message.content === 'Abort requested.') as any
    expect(loaded.command_data).toBe(commandData)

    const { buildResumeMessagePage } = await import('../../packages/server/src/modules/studio/services/chat-run/resume-payload')
    const page = buildResumeMessagePage(state.messages as any)
    expect((page.messages.find((message: any) => message.content === 'Abort requested.') as any).command_data).toBe(commandData)
  })

  it('persists a real /title receipt with its code and reads it back from the database', async () => {
    vi.doMock('../../packages/server/src/modules/studio/public/logging', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }))
    vi.doMock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
      calcAndUpdateUsage: vi.fn(async () => ({ inputTokens: 0, outputTokens: 0 })),
      contextTokensWithCachedOverhead: vi.fn((_state: any, tokens: number) => tokens),
      estimateUsageTokensFromMessages: vi.fn(() => ({ inputTokens: 0, outputTokens: 0 })),
      updateMessageContextTokenUsage: vi.fn(),
    }))
    vi.doMock('../../packages/server/src/modules/studio/services/chat-run/abort', () => ({ handleAbort: vi.fn() }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    const store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const namespaceEmit = vi.fn()
    await handleSessionCommand('s3', parseSessionCommand('/title Sprint notes')!, {
      nsp: { to: vi.fn(() => ({ emit: namespaceEmit })), adapter: { rooms: new Map([['session:s3', new Set(['socket-1'])]]) } } as any,
      socket: { id: 'socket-1', connected: true, join: vi.fn(), emit: vi.fn() } as any,
      sessionMap: new Map([['s3', state]]),
      bridge: {} as any,
      profile: 'default',
      runQueuedItem: vi.fn(),
    })

    const rows = store.getSessionDetailPaginated('s3')!.messages as any[]
    expect(rows.map(row => row.content)).toEqual(['/title Sprint notes', 'Title updated: Sprint notes'])
    expect(rows[0].command_data).toBeUndefined()
    expect(JSON.parse(rows[1].command_data)).toEqual({ messageCode: 'hermes_title_updated', messageParams: { title: 'Sprint notes' } })
  })
})
