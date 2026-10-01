// @vitest-environment jsdom
// review-C-F7 (store side): when switchSession gives up after 15s it must
// dispose the resume listener it opened.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const api = vi.hoisted(() => ({
  disposers: [] as Array<ReturnType<typeof vi.fn>>,
}))

vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: vi.fn(() => ({ abort: vi.fn() })),
  // Never answers: simulates a server that is too slow to resume.
  resumeSession: vi.fn(() => { const dispose = vi.fn(); api.disposers.push(dispose); return dispose }),
  registerSessionHandlers: vi.fn(() => vi.fn()), unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(), respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()), onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()), onSessionWorkspaceUpdated: vi.fn(() => vi.fn()), onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))
vi.mock('@/api/studio/sessions', () => ({
  fetchSessions: vi.fn(() => new Promise(() => {})), fetchSessionMessagesPage: vi.fn(async () => null), fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  archiveSession: vi.fn(), deleteSession: vi.fn(async () => true), setSessionModel: vi.fn(), setSessionPushEnabled: vi.fn(), setSessionReasoningEffort: vi.fn(),
}))
vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'default', hasApiKey: vi.fn(() => false) }))
vi.mock('@/api/studio/download', () => ({ getDownloadUrl: (_p: string, n: string) => `/download/${n}` }))
vi.mock('@/utils/completion-sound', () => ({ primeCompletionSound: vi.fn(), playCompletionSound: vi.fn() }))
vi.mock('@/utils/completion-notification', () => ({ showCompletionNotification: vi.fn() }))

import { useChatStore, type Session } from '@/stores/hermes/chat'

function makeSession(id: string): Session {
  return { id, title: id, messages: [], createdAt: 1, updatedAt: 1, source: 'cli', profile: 'default', messageCount: 0, messageTotal: 0, loadedMessageCount: 0, hasMoreBefore: false }
}

describe('switchSession resume timeout', () => {
  beforeEach(() => { api.disposers.length = 0; vi.useFakeTimers(); localStorage.clear(); setActivePinia(createPinia()) })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

  it('disposes the abandoned resume listener after the 15s timeout', async () => {
    const store = useChatStore()
    store.sessions = [makeSession('a'), makeSession('b')]
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const first = store.switchSession('a')
    await vi.advanceTimersByTimeAsync(15_000)
    await first
    expect(api.disposers).toHaveLength(1)
    expect(api.disposers[0]).toHaveBeenCalledTimes(1)

    // Repeated slow switches never leave listeners behind.
    for (let i = 0; i < 3; i++) {
      const pending = store.switchSession(i % 2 === 0 ? 'b' : 'a')
      await vi.advanceTimersByTimeAsync(15_000)
      await pending
    }
    expect(api.disposers).toHaveLength(4)
    for (const dispose of api.disposers) expect(dispose).toHaveBeenCalledTimes(1)
    expect(store.isLoadingMessages).toBe(false)
    errorSpy.mockRestore()
  })

  it('does not dispose twice when the snapshot arrives before the timeout', async () => {
    const chatApi = await import('@/api/studio/chat')
    ;(chatApi.resumeSession as any).mockImplementationOnce((sid: string, cb: any) => {
      const dispose = vi.fn(); api.disposers.push(dispose)
      cb({ session_id: sid, messages: [], isWorking: false, events: [] })
      return dispose
    })
    const store = useChatStore()
    store.sessions = [makeSession('a')]
    await store.switchSession('a')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(api.disposers).toHaveLength(1)
    expect(api.disposers[0]).not.toHaveBeenCalled()
  })
})
