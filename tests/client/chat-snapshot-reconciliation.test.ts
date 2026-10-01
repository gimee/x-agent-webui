// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const state = vi.hoisted(() => ({ resume: undefined as undefined | ((data: any) => void) }))
vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: vi.fn(),
  resumeSession: vi.fn((_sid: string, cb: (data: any) => void) => { state.resume = cb }),
  registerSessionHandlers: vi.fn(), unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(), respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()), onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()), onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))
vi.mock('@/api/studio/sessions', () => ({
  fetchSessions: vi.fn(async () => []), fetchSessionMessagesPage: vi.fn(),
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []), fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  archiveSession: vi.fn(), deleteSession: vi.fn(), setSessionModel: vi.fn(),
  setSessionPushEnabled: vi.fn(), setSessionReasoningEffort: vi.fn(),
}))
vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'default', hasApiKey: vi.fn(() => false) }))
vi.mock('@/api/studio/download', () => ({ getDownloadUrl: (_p: string, n: string) => `/download/${n}` }))
vi.mock('@/utils/completion-sound', () => ({ primeCompletionSound: vi.fn(), playCompletionSound: vi.fn() }))
vi.mock('@/utils/completion-notification', () => ({ showCompletionNotification: vi.fn() }))
vi.mock('@/utils/session-sync', () => ({ subscribeSessionSync: vi.fn(() => vi.fn()), publishSessionSync: vi.fn() }))

import { useChatStore, type Session } from '@/stores/hermes/chat'

const session = (): Session => ({ id: 's1', title: '', messages: [], createdAt: 1, updatedAt: 1, source: 'cli', profile: 'default', messageCount: 3, messageTotal: 3, loadedMessageCount: 3, hasMoreBefore: false })
const raw = (id: number, role: any, content: string, extra: any = {}) => ({ id, session_id: 's1', role, content, timestamp: 10, tool_call_id: null, tool_calls: null, tool_name: null, run_marker: extra.run_marker ?? null, finish_reason: role === 'assistant' ? 'stop' : null, reasoning: null, ...extra })

describe('real Pinia resume snapshot reconciliation', () => {
  beforeEach(() => { vi.clearAllMocks(); state.resume = undefined; localStorage.clear(); setActivePinia(createPinia()) })

  it('keeps the displayed user and assistant when resume contains only a tool tail, and is idempotent', async () => {
    const store = useChatStore(); const s = session()
    s.messages = [
      { id: 'local-user', clientMessageId: 'cm-u', role: 'user', content: 'question', timestamp: 1 },
      { id: 'local-assistant', role: 'assistant', content: 'answer', timestamp: 2, runMarker: 'run-1', finishReason: 'stop' },
      { id: 'local-tool', role: 'tool', content: '', timestamp: 3, toolCallId: 'call-1', runMarker: 'run-1', toolStatus: 'running' },
    ]
    store.sessions = [s]; store.activeSessionId = s.id; store.activeSession = s
    const switching = store.switchSession(s.id)
    expect(state.resume).toBeTypeOf('function')
    const payload = { session_id: 's1', messages: [raw(91, 'tool', '{"ok":true}', { tool_call_id: 'call-1', tool_name: 'shell', run_marker: 'run-1' })], messageTotal: 3, messageLoadedCount: 1, hasMoreBefore: true, isWorking: false, events: [] }
    state.resume!(payload); await switching
    state.resume!(payload)
    expect(s.messages.filter(m => m.role === 'user')).toHaveLength(1)
    expect(s.messages.filter(m => m.role === 'assistant')).toHaveLength(1)
    expect(s.messages.filter(m => m.role === 'tool')).toHaveLength(1)
    expect(s.messages.find(m => m.role === 'tool')?.toolResult).toBe('{"ok":true}')
  })

  it('does not revive messages when the authoritative empty snapshot clears the session', async () => {
    const store = useChatStore(); const s = session()
    s.messages = [{ id: 'old', role: 'user', content: 'old', timestamp: 1 }]
    store.sessions = [s]; store.activeSessionId = s.id; store.activeSession = s
    const switching = store.switchSession(s.id)
    state.resume!({ session_id: 's1', messages: [], messageTotal: 0, messageLoadedCount: 0, hasMoreBefore: false, isWorking: false, events: [] })
    await switching
    expect(s.messages).toEqual([])
  })
})
