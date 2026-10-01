// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatApi = vi.hoisted(() => {
  const socket = {
    emit: vi.fn((event: string, payload: any) => {
      if (event === 'run') chatApi.socketRuns.push(payload)
    }),
  }
  return {
    starts: [] as Array<{ body: any; onEvent: (event: any) => void }>,
    socketRuns: [] as any[],
    socket,
    peerHandler: undefined as undefined | ((event: any) => void),
  }
})

vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: vi.fn((body: any, onEvent: (event: any) => void) => {
    // Mirror startRunViaSocket's real two-run behavior: once a session handler
    // exists, it emits directly through getChatRunSocket instead of installing
    // another callback. Keep both paths observable in this Pinia regression.
    if (chatApi.starts.length === 0) chatApi.starts.push({ body, onEvent })
    else chatApi.socket.emit('run', body)
    return { abort: vi.fn() }
  }),
  resumeSession: vi.fn((sessionId: string, callback: (data: any) => void) => callback({ session_id: sessionId, messages: [], isWorking: false, events: [] })),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => chatApi.socket),
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn((handler: (event: any) => void) => { chatApi.peerHandler = handler; return vi.fn() }),
  onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
  onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))

vi.mock('@/api/studio/sessions', () => ({
  fetchSessions: vi.fn(async () => []),
  fetchSessionMessagesPage: vi.fn(),
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []),
  fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  archiveSession: vi.fn(), deleteSession: vi.fn(), setSessionModel: vi.fn(),
  setSessionPushEnabled: vi.fn(), setSessionReasoningEffort: vi.fn(),
}))
vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'default', hasApiKey: vi.fn(() => false) }))
vi.mock('@/api/studio/download', () => ({ getDownloadUrl: (_path: string, name: string) => `/download/${name}` }))
vi.mock('@/utils/completion-sound', () => ({ primeCompletionSound: vi.fn(), playCompletionSound: vi.fn() }))
vi.mock('@/utils/completion-notification', () => ({ showCompletionNotification: vi.fn() }))
vi.mock('@/utils/session-sync', () => ({ subscribeSessionSync: vi.fn(() => vi.fn()), publishSessionSync: vi.fn() }))

import { useChatStore, type Session } from '@/stores/hermes/chat'

function makeSession(id = 'session-1'): Session {
  return { id, title: '', messages: [], createdAt: Date.now(), updatedAt: Date.now(), source: 'cli', profile: 'default', messageCount: 0, messageTotal: 0, loadedMessageCount: 0, hasMoreBefore: false }
}

describe('live Pinia message identity reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    chatApi.starts.length = 0
    chatApi.socketRuns.length = 0
    chatApi.socket.emit.mockClear()
    chatApi.peerHandler = undefined
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('sends a stable client id and reconciles peer duplicates after a long queue delay', async () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = session.id
    store.activeSession = session

    await store.sendMessage('same text')
    const first = chatApi.starts[0]
    expect(first.body.client_message_id).toEqual(expect.any(String))
    expect(session.messages[0]).toMatchObject({ clientMessageId: first.body.client_message_id })

    first.onEvent({ event: 'run.started', session_id: session.id, run_id: 'run-1' })
    await store.sendMessage('same text')
    const second = chatApi.socketRuns[0]
    expect(second.client_message_id).toEqual(expect.any(String))
    expect(second.client_message_id).not.toBe(first.body.client_message_id)
    expect(second.queue_id).toEqual(expect.any(String))
    expect(second.queue_id).not.toBe(second.client_message_id)

    chatApi.peerHandler?.({
      event: 'run.peer_user_message', session_id: session.id,
      message: { id: 9001, role: 'user', content: 'same text', queued: false, timestamp: 900, client_message_id: second.client_message_id },
    })
    chatApi.peerHandler?.({
      event: 'run.peer_user_message', session_id: session.id,
      message: { id: 9001, role: 'user', content: 'same text', queued: false, timestamp: 900, client_message_id: second.client_message_id },
    })

    expect(session.messages.filter(message => message.role === 'user')).toHaveLength(2)
    expect(session.messages.filter(message => message.role === 'user').map(message => message.id)).toEqual([session.messages[0].id, '9001'])
  })

  it('keeps two identical user messages when their client ids differ', async () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = session.id
    store.activeSession = session

    await store.sendMessage('repeat')
    await store.sendMessage('repeat')
    const queued = store.queuedUserMessages.get(session.id) || []
    expect(session.messages.filter(message => message.role === 'user').length + queued.length).toBe(2)
    expect(queued).toHaveLength(1)
    expect(new Set([...session.messages, ...queued].filter(message => message.role === 'user').map(message => message.clientMessageId)).size).toBe(2)

    const firstRun = chatApi.starts[0]
    firstRun.onEvent({
      event: 'run.queued',
      session_id: session.id,
      queue_length: 0,
      dequeued_queue_id: queued[0].optimisticQueueId || queued[0].id,
    })
    expect(session.messages.filter(message => message.role === 'user')).toHaveLength(2)
    expect(store.queuedUserMessages.get(session.id) || []).toHaveLength(0)
  })
})
