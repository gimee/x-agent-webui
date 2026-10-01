// @vitest-environment jsdom
// review-C-F2 (store side): resumeServerWorkingRun must hand a reconnect
// snapshot to the same reconciliation the send path uses, so a run that
// finished during the outage is settled and one still running keeps streaming.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ResumeSessionPayload } from '@/api/studio/chat'

const api = vi.hoisted(() => ({
  handlers: new Map<string, any>(),
  unregister: vi.fn(),
}))

vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: vi.fn(() => ({ abort: vi.fn() })),
  resumeSession: vi.fn((sid: string, cb: (d: any) => void) => { cb({ session_id: sid, messages: [], isWorking: false, events: [] }); return vi.fn() }),
  registerSessionHandlers: vi.fn((sid: string, handlers: any) => {
    api.handlers.set(sid, handlers)
    return () => api.handlers.delete(sid)
  }),
  unregisterSessionHandlers: api.unregister,
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(), respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()), onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()), onSessionWorkspaceUpdated: vi.fn(() => vi.fn()), onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))
vi.mock('@/api/studio/sessions', () => ({
  fetchSessions: vi.fn(async () => []), fetchSessionMessagesPage: vi.fn(async () => null), fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  archiveSession: vi.fn(), deleteSession: vi.fn(async () => true), setSessionModel: vi.fn(), setSessionPushEnabled: vi.fn(), setSessionReasoningEffort: vi.fn(),
}))
vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'default', hasApiKey: vi.fn(() => false) }))
vi.mock('@/api/studio/download', () => ({ getDownloadUrl: (_p: string, n: string) => `/download/${n}` }))
vi.mock('@/utils/completion-sound', () => ({ primeCompletionSound: vi.fn(), playCompletionSound: vi.fn() }))
vi.mock('@/utils/completion-notification', () => ({ showCompletionNotification: vi.fn() }))

import { useChatStore, type Session } from '@/stores/hermes/chat'

function makeSession(id: string): Session {
  return { id, title: id, messages: [{ id: 'u1', role: 'user', content: 'question', timestamp: 1, clientMessageId: 'cm_u1' }], createdAt: 1, updatedAt: 1, source: 'cli', profile: 'default', messageCount: 1, messageTotal: 1, loadedMessageCount: 1, hasMoreBefore: false }
}

function snapshot(sid: string, overrides: Partial<ResumeSessionPayload> = {}): ResumeSessionPayload {
  return { session_id: sid, messages: [], isWorking: false, events: [], ...overrides } as ResumeSessionPayload
}

describe('resumeServerWorkingRun reconnect snapshot reconciliation', () => {
  beforeEach(() => {
    api.handlers.clear()
    api.unregister.mockClear()
    localStorage.clear()
    setActivePinia(createPinia())
  })

  async function attach() {
    const store = useChatStore()
    const session = makeSession('a')
    store.sessions = [session]
    store.activeSessionId = 'a'
    store.activeSession = session
    // The server reports the run as working; switchSession attaches resume-path listeners.
    ;(await import('@/api/studio/chat')).resumeSession.mockImplementationOnce((sid: string, cb: any) => {
      cb(snapshot(sid, { isWorking: true, messages: [
        { id: 1, session_id: sid, role: 'user', content: 'question', client_message_id: 'cm_u1', timestamp: 1 },
        // In-flight runtime rows carry an explicit finish_reason: null (resume-payload.ts).
        { id: 2, session_id: sid, role: 'assistant', content: 'partial', client_message_id: 'am_1', timestamp: 2, finish_reason: null, run_marker: 'rm-1' },
      ] as any }))
      return vi.fn()
    })
    await store.switchSession('a')
    const handlers = api.handlers.get('a')
    expect(handlers).toBeTruthy()
    expect(store.isSessionLive('a')).toBe(true)
    return { store, session, handlers }
  }

  it('registers reconnect and socket-failure hooks alongside the event handlers', async () => {
    const { handlers } = await attach()
    expect(typeof handlers.onReconnectResume).toBe('function')
    expect(typeof handlers.onSocketError).toBe('function')
    expect(typeof handlers.onMessageDelta).toBe('function')
  })

  it('settles the run when the reconnect snapshot says the server is idle', async () => {
    const { store, handlers } = await attach()
    handlers.onReconnectResume(snapshot('a', {
      isWorking: false,
      messages: [
        { id: 1, session_id: 'a', role: 'user', content: 'question', client_message_id: 'cm_u1', timestamp: 1 },
        { id: 2, session_id: 'a', role: 'assistant', content: 'partial and finished', client_message_id: 'am_1', timestamp: 2, finish_reason: 'stop', run_marker: 'rm-1' },
      ] as any,
    }))
    const session = store.sessions[0]
    expect(session.messages.map(m => `${m.role}:${m.content}`)).toEqual(['user:question', 'assistant:partial and finished'])
    expect(session.messages.some(m => m.isStreaming)).toBe(false)
    expect(store.isSessionLive('a')).toBe(false)
    expect(store.runStartedAt.has('a')).toBe(false)
    expect(api.unregister).toHaveBeenCalledWith('a')
  })

  it('keeps streaming into the reconciled assistant when the server is still working', async () => {
    const { store, handlers } = await attach()
    handlers.onReconnectResume(snapshot('a', {
      isWorking: true,
      runStartedAt: 1234,
      queueLength: 0,
      messages: [
        { id: 1, session_id: 'a', role: 'user', content: 'question', client_message_id: 'cm_u1', timestamp: 1 },
        { id: 2, session_id: 'a', role: 'assistant', content: 'partial plus missed', client_message_id: 'am_1', timestamp: 2, finish_reason: null, run_marker: 'rm-1' },
      ] as any,
    }))
    expect(store.isSessionLive('a')).toBe(true)
    expect(store.runStartedAt.get('a')).toBe(1234)
    handlers.onMessageDelta({ event: 'message.delta', session_id: 'a', client_message_id: 'am_1', delta: ' tail' })
    const assistant = store.sessions[0].messages.find(m => m.role === 'assistant')
    expect(assistant?.content).toBe('partial plus missed tail')
    expect(store.sessions[0].messages.filter(m => m.role === 'assistant')).toHaveLength(1)
  })

  it('fails the run locally when the socket drops for good', async () => {
    const { store, handlers } = await attach()
    expect(typeof handlers.onSocketError).toBe('function')
    handlers.onSocketError(new Error('Socket disconnected: io server disconnect'))
    expect(store.isSessionLive('a')).toBe(false)
    // addAgentErrorMessage renders failures as an assistant row flagged systemType 'error'.
    expect(store.sessions[0].messages.some(m => m.role === 'assistant' && m.systemType === 'error' && /io server disconnect/.test(m.content))).toBe(true)
    expect(store.sessions[0].messages.some(m => m.isStreaming)).toBe(false)
  })
})
