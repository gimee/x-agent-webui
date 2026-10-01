// hermes-v050:F-15 T6 stores a command receipt's stable code in messages.command_data so the
// client can localize it. `/fork` (the branch command) copied every message but that column,
// so receipts in the child session fell back to their English text.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const COMMAND_DATA = JSON.stringify({ messageCode: 'hermes_queue_queued', messageParams: { length: 1 } })

vi.mock('../../packages/server/src/modules/studio/services/chat-run/compression', () => ({
  buildDbHistory: vi.fn(),
  estimateSnapshotAwareHistoryUsage: vi.fn(),
  forceCompressBridgeHistory: vi.fn(),
  getOrCreateSession: vi.fn((sessionMap: Map<string, any>, sessionId: string) => {
    if (!sessionMap.has(sessionId)) sessionMap.set(sessionId, { messages: [], isWorking: false, events: [], queue: [] })
    return sessionMap.get(sessionId)
  }),
  replaceState: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  calcAndUpdateUsage: vi.fn(async () => ({ inputTokens: 0, outputTokens: 0 })),
  contextTokensWithCachedOverhead: vi.fn((_state: any, tokens: number) => tokens),
  updateMessageContextTokenUsage: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/abort', () => ({
  handleAbort: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/bridge-message', () => ({
  flushBridgePendingToDb: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bridgeLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

describe('hermes-v050:F-15 /fork keeps command receipts localizable', () => {
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
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })

  it('copies command_data into the branched session (repository)', async () => {
    const { addMessage, createBranchedSession, createSession, getSessionDetail } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    createSession({ id: 'parent', source: 'cli' })
    addMessage({ session_id: 'parent', role: 'user', content: 'hello', timestamp: 1 })

    createBranchedSession({
      id: 'child',
      parent_session_id: 'parent',
      source: 'cli',
      ended_at: 3,
      last_active: 3,
      messages: [
        { role: 'user', content: 'hello', timestamp: 1 },
        { role: 'command', content: 'Queued 1 message.', timestamp: 2, command_data: COMMAND_DATA } as any,
      ],
    })

    const rows = getSessionDetail('child')!.messages
    expect(rows.map(row => [row.role, row.command_data ?? null])).toEqual([
      ['user', null],
      ['command', COMMAND_DATA],
    ])
  })

  it('/fork carries every command receipt code from the parent into the child', async () => {
    const store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    store.createSession({ id: 'session-1', profile: 'default', source: 'cli', title: 'Parent chat', model: 'gpt-test', provider: 'openai' })
    store.addMessage({ session_id: 'session-1', role: 'user', content: 'Root prompt', timestamp: 1 })
    store.addMessage({ session_id: 'session-1', role: 'command', content: 'Queued 1 message.', timestamp: 2, command_data: COMMAND_DATA })
    store.addMessage({ session_id: 'session-1', role: 'assistant', content: 'Root answer', timestamp: 3 })

    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const namespaceEmit = vi.fn()
    const nsp = { to: vi.fn(() => ({ emit: namespaceEmit })), adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) } }
    const socket = { id: 'socket-1', join: vi.fn(), emit: vi.fn(), connected: true }
    const sessionMap = new Map<string, any>([['session-1', { messages: [], isWorking: false, events: [], queue: [] }]])

    await handleSessionCommand('session-1', parseSessionCommand('/fork Alternate')!, {
      nsp,
      socket,
      sessionMap,
      bridge: { status: vi.fn(async () => ({ exists: true, running: false, currentRunId: null })) },
      profile: 'default',
      model: 'gpt-test',
      provider: 'openai',
      runQueuedItem: vi.fn(),
    } as any)

    const event = namespaceEmit.mock.calls.find(call => call[0] === 'session.command')?.[1]
    expect(event).toMatchObject({ action: 'branch', ok: true })
    const childId = event.branchSession.id
    const child = store.getSessionDetail(childId)!
    expect(child.messages.map(row => row.role)).toEqual(['user', 'command', 'assistant'])
    expect(child.messages.find(row => row.role === 'command')?.command_data).toBe(COMMAND_DATA)
    expect(child.messages.filter(row => row.role !== 'command').every(row => row.command_data == null)).toBe(true)
  })
})
