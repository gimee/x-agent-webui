// @vitest-environment jsdom
// hermes-v050:C10 12s 轮询：列表数据没变时不替换 sessions.value（侧栏整表不重算）；字段变化就地更新，增删/换序才换数组。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { watch } from 'vue'

const state = vi.hoisted(() => ({ list: [] as any[] }))
vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: vi.fn(() => ({ abort: vi.fn() })),
  resumeSession: vi.fn(), registerSessionHandlers: vi.fn(), unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(), respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()), onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()), onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))
vi.mock('@/api/studio/sessions', () => ({
  fetchSessions: vi.fn(async (source?: string) => (source === 'global_agent' ? [] : state.list.map(item => ({ ...item })))),
  fetchSessionMessagesPage: vi.fn(async () => null),
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []), fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  archiveSession: vi.fn(), deleteSession: vi.fn(), setSessionModel: vi.fn(),
  setSessionPushEnabled: vi.fn(), setSessionReasoningEffort: vi.fn(),
}))
vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'default', hasApiKey: vi.fn(() => false) }))
vi.mock('@/api/studio/download', () => ({ getDownloadUrl: (_p: string, n: string) => `/download/${n}` }))
vi.mock('@/utils/completion-sound', () => ({ primeCompletionSound: vi.fn(), playCompletionSound: vi.fn() }))
vi.mock('@/utils/completion-notification', () => ({ showCompletionNotification: vi.fn() }))
vi.mock('@/utils/session-sync', () => ({ subscribeSessionSync: vi.fn(() => vi.fn()), publishSessionSync: vi.fn() }))

import { useChatStore } from '@/stores/hermes/chat'

const summary = (id: string, lastActive: number, extra: Record<string, unknown> = {}) => ({
  id, title: `title ${id}`, source: 'cli', profile: 'default', model: 'm', provider: 'p',
  started_at: 100, last_active: lastActive, ended_at: null, message_count: 4, input_tokens: 1, output_tokens: 2,
  ...extra,
})

async function primed() {
  const store = useChatStore()
  state.list = [summary('a', 300), summary('b', 200), summary('c', 100)]
  await store.refreshSessionListOnly()
  expect(store.sessions.map(session => session.id)).toEqual(['a', 'b', 'c'])
  const replacements: string[][] = []
  watch(() => store.sessions, sessions => { replacements.push(sessions.map(session => session.id)) }, { flush: 'sync' })
  return { store, replacements }
}

describe('C10 session-list poll skips no-op replacements', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('keeps sessions.value when the polled list is unchanged', async () => {
    const { store, replacements } = await primed()
    const before = store.sessions
    await store.refreshSessionListOnly()
    await store.refreshSessionListOnly()
    expect(replacements).toEqual([])
    expect(store.sessions).toBe(before)
  })

  it('updates changed fields in place without replacing the array', async () => {
    const { store, replacements } = await primed()
    const b = store.sessions[1]
    const seenTitles: string[] = []
    watch(() => b.title, title => { seenTitles.push(title) }, { flush: 'sync' })
    state.list = [summary('a', 300), summary('b', 200, { title: 'renamed' }), summary('c', 100)]
    await store.refreshSessionListOnly()
    expect(replacements).toEqual([])
    expect(store.sessions[1]).toBe(b)
    expect(seenTitles).toEqual(['renamed'])
  })

  it('still replaces the array when sessions are added, removed or reordered', async () => {
    const { store, replacements } = await primed()
    state.list = [summary('d', 400), summary('a', 300), summary('b', 200), summary('c', 100)]
    await store.refreshSessionListOnly()
    state.list = [summary('d', 400), summary('a', 300), summary('c', 100)]
    await store.refreshSessionListOnly()
    state.list = [summary('c', 500), summary('d', 400), summary('a', 300)]
    await store.refreshSessionListOnly()
    expect(replacements).toEqual([['d', 'a', 'b', 'c'], ['d', 'a', 'c'], ['c', 'd', 'a']])
  })
})
