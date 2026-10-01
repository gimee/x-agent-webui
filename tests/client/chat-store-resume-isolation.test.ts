// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ResumeSessionPayload, RunEvent } from '@/api/studio/chat'

const api = vi.hoisted(() => ({
  resumes: [] as Array<{ sid: string; callback: (data: ResumeSessionPayload) => void }>,
  events: undefined as undefined | ((event: RunEvent) => void),
  command: undefined as undefined | ((event: RunEvent) => void),
  reconnect: undefined as undefined | ((data: ResumeSessionPayload) => void),
  handlers: new Map<string, any>(),
  fetchPage: vi.fn(),
}))
vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: vi.fn((_body, event, _done, _error, _started, options) => {
    api.events = event
    api.reconnect = options?.onReconnectResume
    return { abort: vi.fn() }
  }),
  resumeSession: vi.fn((sid, callback) => { api.resumes.push({ sid, callback }) }),
  registerSessionHandlers: vi.fn((sid, handlers) => api.handlers.set(sid, handlers)),
  unregisterSessionHandlers: vi.fn((sid) => api.handlers.delete(sid)),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(), respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn((handler) => { api.command = handler; return vi.fn() }),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
  onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))
vi.mock('@/api/studio/sessions', () => ({
  // Hold the independent list refresh at its IO boundary, not the real store.
  fetchSessions: vi.fn(() => new Promise(() => {})),
  fetchSessionMessagesPage: api.fetchPage,
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []),
  fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  archiveSession: vi.fn(), deleteSession: vi.fn(async () => true), setSessionModel: vi.fn(),
  setSessionPushEnabled: vi.fn(), setSessionReasoningEffort: vi.fn(),
}))
vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'default', hasApiKey: () => false }))
vi.mock('@/api/studio/download', () => ({ getDownloadUrl: (_p: string, n: string) => `/download/${n}` }))
vi.mock('@/stores/hermes/app', () => ({ useAppStore: () => ({
  waitForModelsForRun: async () => {}, modelGroups: [], profileModelGroups: [],
}) }))
vi.mock('@/utils/completion-sound', () => ({ primeCompletionSound: vi.fn(), playCompletionSound: vi.fn() }))
vi.mock('@/utils/completion-notification', () => ({ showCompletionNotification: vi.fn() }))
vi.mock('@/utils/session-sync', () => ({ subscribeSessionSync: vi.fn(() => vi.fn()), publishSessionSync: vi.fn() }))

import { useChatStore, type Session } from '@/stores/hermes/chat'
import { useProfilesStore } from '@/stores/hermes/profiles'

function session(id: string): Session {
  return {
    id, title: id, source: 'cli', profile: 'default', createdAt: 1, updatedAt: 1,
    messages: [{ id: `${id}-user`, role: 'user', content: `${id} own question`, timestamp: 1 }],
    messageTotal: 7, messageCount: 7, loadedMessageCount: 7, hasMoreBefore: false,
  }
}
function snapshot(sid: string, overrides: Partial<ResumeSessionPayload> = {}): ResumeSessionPayload {
  return {
    session_id: sid,
    messages: [{ id: 80, session_id: sid, role: 'assistant', content: `${sid} response`, timestamp: 10 }],
    messageTotal: 1, messageLoadedCount: 1, hasMoreBefore: false, isWorking: false, events: [],
    ...overrides,
  }
}
function visible() { document.dispatchEvent(new Event('visibilitychange')) }
function setup() {
  const store = useChatStore()
  store.sessions = [session('a'), session('b')]
  store.activeSessionId = 'a'
  store.activeSession = store.sessions[0]
  return { store, a: store.sessions[0], b: store.sessions[1] }
}

const documentListeners: Array<[string, EventListenerOrEventListenerObject]> = []
beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  api.resumes = []
  api.handlers.clear()
  api.fetchPage.mockResolvedValue(null)
  localStorage.clear()
  setActivePinia(createPinia())
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const add = document.addEventListener.bind(document)
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
    documentListeners.push([type, listener])
    add(type, listener, options)
  })
})
afterEach(() => {
  for (const [type, listener] of documentListeners.splice(0)) document.removeEventListener(type, listener)
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('resume request isolation in the real chat store', () => {
  for (const path of ['visibility', 'switch'] as const) {
    for (const window of ['newest', 'older'] as const) {
      it(`${path} does not revive cleared history from a late ${window} refill`, async () => {
        const { store, a } = setup()
        if (window === 'newest') a.messages = [{id:'live-tool',role:'tool',content:'',timestamp:1,toolCallId:'call-1'}]
        let finishPage!: (page: any) => void
        api.fetchPage.mockReturnValue(new Promise(resolve => { finishPage = resolve }))
        const pending = path === 'switch' ? store.switchSession('a') : (visible(), Promise.resolve())
        api.resumes[0].callback(snapshot('a', { messages: [], messageTotal: 9, messageLoadedCount: 2, hasMoreBefore: true }))
        await Promise.resolve()
        expect(api.fetchPage).toHaveBeenCalledWith('a', window === 'newest' ? 0 : 2, 150, 'default')
        api.command!({ event: 'session.command', session_id: 'a', command: 'clear', action: 'clear' } as any)
        finishPage({ messages: snapshot('a').messages, total: 9, hasMore: false })
        await pending
        await Promise.resolve()
        expect(a.messages).toEqual([])
        expect(a.loadedMessageCount).toBe(2)
      })
    }
  }

  for (const listener of ['sent', 'resumed'] as const) {
    it(`rejects a switch snapshot after a new queued run starts on ${listener} listeners`, async () => {
      const { store, a } = setup()
      if (listener === 'sent') await store.sendMessage('first run')
      else {
        const initial = store.switchSession('a')
        api.resumes.at(-1)!.callback(snapshot('a', { isWorking: true }))
        await initial
      }
      const pending = store.switchSession('a')
      const old = api.resumes.at(-1)!
      const started = { event: 'run.started', session_id: 'a', run_id: 'next-run' }
      if (listener === 'sent') api.events!(started)
      else api.handlers.get('a').onRunStarted(started)
      const before = JSON.parse(JSON.stringify(a))
      old.callback(snapshot('a', { isWorking: false, messageTotal: 0, messages: [] }))
      await pending
      expect(a).toEqual(before)
      expect(store.isStreaming).toBe(true)
    })
  }

  it('rejects a switch callback that arrives after its timeout', async () => {
    const { store, a } = setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const pending = store.switchSession('a')
    const old = api.resumes[0]
    await vi.advanceTimersByTimeAsync(15_001)
    await pending
    const before = JSON.parse(JSON.stringify(a))
    old.callback(snapshot('a', { isWorking: true }))
    expect(a).toEqual(before)
    expect(api.handlers.has('a')).toBe(false)
  })

  for (const path of ['visibility', 'switch'] as const) {
    for (const invalidate of ['new resume', 'profile change', 'clear selection', 'clear history', 'new stream', 'completed new run'] as const) {
      it(`${path} rejects a snapshot invalidated by ${invalidate}`, async () => {
        const { store, a } = setup()
        const pending = path === 'switch' ? store.switchSession('a') : (visible(), Promise.resolve())
        const old = api.resumes[0]
        if (invalidate === 'new resume') {
          visible()
          api.resumes[1].callback(snapshot('a', { messageTotal: 20, workspace: '/new' }))
        } else if (invalidate === 'profile change') {
          useProfilesStore().activeProfileName = 'other'
        } else if (invalidate === 'clear selection') {
          const sessions = store.sessions
          store.setRuntimeMode('global_agent')
          store.setRuntimeMode('default')
          store.sessions = sessions
          // Reselect the same object: a sid-only guard cannot see the clear.
          store.activeSessionId = 'a'
          store.activeSession = a
        } else if (invalidate === 'clear history') {
          api.command!({ event: 'session.command', session_id: 'a', command: 'clear', action: 'clear' } as any)
        } else if (invalidate === 'new stream') {
          await store.sendMessage('new run')
          expect(store.isStreaming).toBe(true)
        } else {
          await store.sendMessage('new run')
          api.events!({ event: 'run.started', session_id: 'a', run_id: 'new-run' })
          api.events!({ event: 'run.completed', session_id: 'a', run_id: 'new-run', output: 'new answer' })
        }
        const before = JSON.parse(JSON.stringify(a))
        old.callback(snapshot('a', { workspace: '/stale', isWorking: true, runStartedAt: 99 }))
        await pending
        expect(a).toEqual(before)
        expect(store.runStartedAt.get('a')).not.toBe(99)
      })
    }
  }

  it('applies authoritative empty visibility snapshot metadata, including zero counts', () => {
    const { a } = setup()
    visible()
    api.resumes[0].callback(snapshot('a', {
      messages: [], messageTotal: 0, messageLoadedCount: 0, workspace: '/empty',
    }))
    expect(a.messages).toEqual([])
    expect(a).toMatchObject({
      loadedMessageCount: 0, messageTotal: 0, messageCount: 0, hasMoreBefore: false,
      workspace: '/empty',
    })
  })

  it('ignores an older visibility response after a newer resume has completed', () => {
    const { a } = setup()
    visible()
    visible()
    api.resumes[1].callback(snapshot('a', { messageTotal: 12, workspace: '/new' }))
    const latest = JSON.parse(JSON.stringify(a))

    api.resumes[0].callback(snapshot('a', { messageTotal: 1, workspace: '/old' }))

    expect(a).toEqual(latest)
  })

  it('never applies a late visibility snapshot for A to the newly selected B', () => {
    const { store, b } = setup()
    const before = JSON.parse(JSON.stringify(b))
    visible()
    const pendingA = api.resumes[0]
    expect(pendingA.sid).toBe('a')
    store.activeSessionId = b.id
    store.activeSession = b

    pendingA.callback(snapshot('a', { workspace: '/old-a' }))

    expect(b).toEqual(before)
    expect(store.activeSessionId).toBe('b')
    expect(store.activeSession).toBe(b)
  })
})
