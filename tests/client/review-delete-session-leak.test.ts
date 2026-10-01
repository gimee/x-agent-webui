// @vitest-environment jsdom
// 审查复现：deleteSession 只清 messageReference/abortState，其余按 sessionId 键的状态全部残留
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatApi = vi.hoisted(() => ({
  starts: [] as Array<{ body: any; onEvent: (event: any) => void }>,
  unregister: vi.fn(),
}))

vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: vi.fn((body: any, onEvent: (event: any) => void) => { chatApi.starts.push({ body, onEvent }); return { abort: vi.fn() } }),
  resumeSession: vi.fn((sessionId: string, cb: (d: any) => void) => cb({ session_id: sessionId, messages: [], isWorking: false, events: [] })),
  registerSessionHandlers: vi.fn(), unregisterSessionHandlers: chatApi.unregister,
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(), respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()), onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()), onSessionWorkspaceUpdated: vi.fn(() => vi.fn()), onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))
vi.mock('@/api/studio/sessions', () => ({
  fetchSessions: vi.fn(async () => []), fetchSessionMessagesPage: vi.fn(), fetchWorkspaceRunChangeFile: vi.fn(async () => null),
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

describe('deleteSession state cleanup', () => {
  beforeEach(() => { chatApi.starts.length = 0; chatApi.unregister.mockClear(); localStorage.clear(); setActivePinia(createPinia()) })

  it('leaves per-session maps populated after the session is deleted mid-run', async () => {
    const store = useChatStore()
    const a = makeSession('a'), b = makeSession('b')
    store.sessions = [a, b]
    store.activeSessionId = a.id
    store.activeSession = a

    await store.sendMessage('go')
    const { onEvent } = chatApi.starts[0]
    onEvent({ event: 'run.started', session_id: 'a', run_id: 'r1', run_marker: 'rm', queue_length: 0 })
    onEvent({ event: 'reasoning.delta', session_id: 'a', run_marker: 'rm', client_message_id: 'am_1', text: 'hmm' })
    onEvent({ event: 'run.queued', session_id: 'a', queue_length: 1, message: { id: 'q1', role: 'user', content: 'queued one', client_message_id: 'cm_q1' } })
    onEvent({ event: 'subagent.start', session_id: 'a', run_marker: 'rm', subagent_id: 'sub1', task_index: 0, task_count: 1, goal: 'g' })
    onEvent({ event: 'approval.requested', session_id: 'a', approval_id: 'ap1', command: 'rm -rf', description: 'danger' })
    onEvent({ event: 'compression.started', session_id: 'a', message_count: 3, token_count: 10 })

    expect(store.isSessionLive('a')).toBe(true)
    const ok = await store.deleteSession('a')
    expect(ok).toBe(true)
    expect(store.sessions.map(s => s.id)).toEqual(['b'])

    const leftovers = {
      serverWorking_or_streamStates: store.isSessionLive('a'),
      runStartedAt: store.runStartedAt.has('a'),
      queueLengths: store.queueLengths.has('a'),
      queuedUserMessages: store.queuedUserMessages.has('a'),
      subagentStreams: [...store.subagentStreams.keys()].filter(k => k.startsWith('a:')),
      pendingApprovals: store.pendingApprovals.has('a'),
      unregisterSessionHandlersCalled: chatApi.unregister.mock.calls.length,
    }
    console.log('leftovers after deleteSession:', JSON.stringify(leftovers))
    expect(leftovers.serverWorking_or_streamStates).toBe(false)
    expect(leftovers.runStartedAt).toBe(false)
    expect(leftovers.queuedUserMessages).toBe(false)
    expect(leftovers.subagentStreams).toEqual([])
    expect(leftovers.pendingApprovals).toBe(false)
  })
})
