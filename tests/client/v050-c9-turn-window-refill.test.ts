// @vitest-environment jsdom
// hermes-v050:C9 打开大会话的补页：新服务端一次带够 10 轮（olderMessages）；旧服务端退回逐页补但只提交一次；
// 顶部触达与补齐循环并发时共用同一请求，补齐不会被提前打断（原来偶发停在 2 页）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { watch } from 'vue'

type Raw = { id: number; session_id: string; role: string; content: string; timestamp: number; tool_call_id?: string }

const state = vi.hoisted(() => ({
  resume: undefined as undefined | ((data: any) => void),
  fetchPage: undefined as any,
}))
vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: vi.fn(() => ({ abort: vi.fn() })),
  resumeSession: vi.fn((_sid: string, cb: (data: any) => void) => { state.resume = cb }),
  registerSessionHandlers: vi.fn(), unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(), respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()), onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()), onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))
vi.mock('@/api/studio/sessions', () => ({
  fetchSessions: vi.fn(async () => []),
  fetchSessionMessagesPage: vi.fn((...args: any[]) => state.fetchPage(...args)),
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []), fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  archiveSession: vi.fn(), deleteSession: vi.fn(), setSessionModel: vi.fn(),
  setSessionPushEnabled: vi.fn(), setSessionReasoningEffort: vi.fn(),
}))
vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'default', hasApiKey: vi.fn(() => false) }))
vi.mock('@/api/studio/download', () => ({ getDownloadUrl: (_p: string, n: string) => `/download/${n}` }))
vi.mock('@/utils/completion-sound', () => ({ primeCompletionSound: vi.fn(), playCompletionSound: vi.fn() }))
vi.mock('@/utils/completion-notification', () => ({ showCompletionNotification: vi.fn() }))
vi.mock('@/utils/session-sync', () => ({ subscribeSessionSync: vi.fn(() => vi.fn()), publishSessionSync: vi.fn() }))

import { resumeSession } from '@/api/studio/chat'
import { fetchSessionMessagesPage } from '@/api/studio/sessions'
import { countLiveChatTurns, useChatStore, type Session } from '@/stores/hermes/chat'

// 数据库：13 个完整轮次（user + 40 tool + assistant）+ 进行到一半的第 14 轮（user + 300 tool），共 847 行。
// 最新 150 行全是 tool。
function database(): Raw[] {
  const rows: Raw[] = []
  const push = (role: string, content: string, extra: Partial<Raw> = {}) => {
    rows.push({ id: rows.length + 1, session_id: 's1', role, content, timestamp: rows.length + 1, ...extra })
  }
  for (let turn = 0; turn < 13; turn += 1) {
    push('user', `question ${turn}`)
    for (let tool = 0; tool < 40; tool += 1) push('tool', `tool ${turn}.${tool}`, { tool_call_id: `c${turn}.${tool}` })
    push('assistant', `answer ${turn}`)
  }
  push('user', 'question 13')
  for (let tool = 0; tool < 300; tool += 1) push('tool', `tool 13.${tool}`, { tool_call_id: `c13.${tool}` })
  return rows
}
const rows = database()
// 与服务端 getSessionDetailPaginated 同语义：按 id 倒序取 offset/limit，再正序返回
function page(offset: number, limit: number) {
  const end = rows.length - offset
  const messages = rows.slice(Math.max(0, end - limit), Math.max(0, end))
  return { session: { id: 's1' }, messages, total: rows.length, offset, limit, hasMore: offset + messages.length < rows.length }
}
function snapshot(extra: Record<string, unknown> = {}) {
  return {
    session_id: 's1', messages: page(0, 150).messages, messageTotal: rows.length, messageLoadedCount: 150,
    hasMoreBefore: true, isWorking: false, events: [], ...extra,
  }
}
const session = (): Session => ({ id: 's1', title: 's1', messages: [], createdAt: 1, updatedAt: 1, source: 'coding_agent', profile: 'default', messageCount: rows.length, messageTotal: rows.length, loadedMessageCount: 0, hasMoreBefore: false })

async function settle(rounds = 40) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
}

function setup() {
  const store = useChatStore()
  store.sessions = [session()]
  const live = () => store.sessions.find(item => item.id === 's1')!
  return { store, live }
}

describe('C9 opening a large session fills the ten-turn window without serial re-renders', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.resume = undefined
    state.fetchPage = vi.fn(async (_sid: string, offset: number, limit: number) => page(offset, limit))
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('asks the server for the ten-turn window only when the local window is short', async () => {
    const { store, live } = setup()
    const first = store.switchSession('s1')
    expect(resumeSession).toHaveBeenLastCalledWith('s1', expect.any(Function), 'default', expect.anything(), { minTurns: 10 })
    state.resume!(snapshot({ olderMessages: page(150, 529).messages, messageLoadedCount: 679 }))
    await first
    expect(countLiveChatTurns(live().messages)).toBe(10)

    // 已经有 10 轮的会话再切回来：不再要大窗口，服务端照旧只给最新页
    const again = store.switchSession('s1')
    expect(vi.mocked(resumeSession).mock.calls.at(-1)![4]).toBeUndefined()
    state.resume!(snapshot())
    await again
  })

  it('new server: renders the older rows from the resume payload with no paged requests', async () => {
    const { store, live } = setup()
    const pending = store.switchSession('s1')
    state.resume!(snapshot({ olderMessages: page(150, 529).messages, messageLoadedCount: 679 }))
    await pending
    await settle()
    expect(fetchSessionMessagesPage).not.toHaveBeenCalled()
    expect(live().messages.map(message => message.id)).toEqual(rows.slice(rows.length - 679).map(row => String(row.id)))
    expect(live().loadedMessageCount).toBe(679)
    expect(live().hasMoreBefore).toBe(true)
  })

  it('old server: falls back to paged refill but commits the whole window once', async () => {
    const { store, live } = setup()
    const pending = store.switchSession('s1')
    state.resume!(snapshot())
    // 视图按 tick 重渲染：默认 flush 的 watcher 每个 tick 最多触发一次，正好数「重渲染了几次」
    const commits: number[] = []
    watch(() => live().messages, messages => { commits.push(messages.length) })
    await pending
    await settle()

    // 旧逻辑：并最新页 + 逐页补 4 页（每页一次重渲染）；现在请求不变，只提交一次
    expect(vi.mocked(fetchSessionMessagesPage).mock.calls.map(call => [call[1], call[2]])).toEqual([
      [0, 150], [150, 150], [300, 150], [450, 150], [600, 150],
    ])
    expect(commits).toHaveLength(1)
    expect(countLiveChatTurns(live().messages)).toBeGreaterThanOrEqual(10)
    expect(live().messages.map(message => message.id)).toEqual(rows.slice(rows.length - 750).map(row => String(row.id)))
    expect(live().loadedMessageCount).toBe(750)
    expect(live().hasMoreBefore).toBe(true)
  })

  it('a top-reach load that starts during the refill joins it instead of stopping it', async () => {
    const { store, live } = setup()
    const gates: Array<() => void> = []
    state.fetchPage = vi.fn((_sid: string, offset: number, limit: number) => new Promise(resolve => {
      gates.push(() => resolve(page(offset, limit)))
    }))
    const pending = store.switchSession('s1')
    state.resume!(snapshot())
    await settle()
    expect(gates).toHaveLength(1)

    // 快照渲染后列表在顶部触发 top-reach（原来这一刻 isLoadingOlderMessages 还是 false）
    const topReach = store.loadOlderMessages('s1')
    for (let i = 0; i < 12 && gates.length; i += 1) {
      gates.shift()!()
      await settle()
    }
    await pending
    expect(await topReach).toBe(true)
    expect(countLiveChatTurns(live().messages)).toBeGreaterThanOrEqual(10)
    expect(live().loadedMessageCount).toBe(750)
    expect(fetchSessionMessagesPage).toHaveBeenCalledTimes(5)
  })

  it('concurrent older-page loads share one request', async () => {
    const { store, live } = setup()
    Object.assign(live(), { messages: [], loadedMessageCount: 150, hasMoreBefore: true })
    const [a, b] = [store.loadOlderMessages('s1'), store.loadOlderMessages('s1')]
    expect(await a).toBe(true)
    expect(await b).toBe(true)
    expect(fetchSessionMessagesPage).toHaveBeenCalledTimes(1)
    expect(live().loadedMessageCount).toBe(300)
  })
})
