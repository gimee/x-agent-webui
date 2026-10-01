// @vitest-environment jsdom
// Coding-agent (Claude Code / Codex / Pi) runs stream through
// response-stream.ts, not the Hermes bridge. Their wire must never present the
// user's cm_ client_message_id as the identity of an assistant segment, and a
// second text segment after a tool call must still render live.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const state = vi.hoisted(() => ({ event: undefined as any, resume: undefined as any, handlers: undefined as any, body: undefined as any }))
vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: vi.fn((body: any, event: any) => { state.body = body; state.event = event; return { abort: vi.fn() } }),
  resumeSession: vi.fn((_sid: string, cb: (data: any) => void) => { state.resume = cb }),
  registerSessionHandlers: vi.fn((_sid: string, handlers: any) => { state.handlers = handlers }),
  unregisterSessionHandlers: vi.fn(),
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

const RUN = 'coding_agent_fixture_000001'
const session = (): Session => ({
  id: 's1', title: '', messages: [], createdAt: 1, updatedAt: 1, source: 'coding_agent', agent: 'claude',
  codingAgentId: 'claude-code', codingAgentMode: 'global', profile: 'default',
  messageCount: 3, messageTotal: 3, loadedMessageCount: 3, hasMoreBefore: false,
} as unknown as Session)
const handlerNames: Record<string, string> = {
  'run.started': 'onRunStarted', 'message.delta': 'onMessageDelta', 'reasoning.delta': 'onReasoningDelta',
  'tool.started': 'onToolStarted', 'tool.completed': 'onToolCompleted', 'run.completed': 'onRunCompleted', 'run.failed': 'onRunFailed',
}

async function setup(resumed: boolean) {
  const store = useChatStore(); const s = session()
  store.sessions = [s]; store.activeSessionId = s.id; store.activeSession = s
  let userClientId: string
  if (resumed) {
    userClientId = 'cm_user_from_other_tab'
    const pending = store.switchSession(s.id)
    state.resume({ session_id: 's1', messages: [{ id: 1002, session_id: 's1', role: 'user', content: 'probe', timestamp: 10, client_message_id: userClientId, run_marker: null, finish_reason: null }], messageTotal: 1, messageLoadedCount: 1, hasMoreBefore: false, isWorking: true, events: [] })
    await pending
  } else {
    await store.sendMessage('probe')
    userClientId = String(state.body.client_message_id)
    expect(userClientId).toMatch(/^cm_/)
  }
  const event = resumed
    ? (e: any) => state.handlers[handlerNames[e.event]](e)
    : state.event
  return { store, s, event, userClientId }
}

const base = (event: string, extra: Record<string, unknown>, identity: string | undefined) => ({
  event, session_id: 's1', run_id: 'resp-1', response_id: 'resp-1', run_marker: RUN,
  ...(identity !== undefined ? { client_message_id: identity } : {}), ...extra,
})
const textSegments = (s: Session) => s.messages.filter(m => m.role === 'assistant' && !(m as any).toolCalls?.length && String(m.content || '').trim())

describe('coding-agent wire identity in the real Pinia store', () => {
  beforeEach(() => { vi.clearAllMocks(); state.event = undefined; state.resume = undefined; state.handlers = undefined; state.body = undefined; localStorage.clear(); setActivePinia(createPinia()) })

  for (const resumed of [false, true]) {
    it(`legacy wire tagged with the user's cm_ id still renders text → tool → text, resumed=${resumed}`, async () => {
      const { s, event, userClientId } = await setup(resumed)
      const tagged = (e: string, extra: Record<string, unknown> = {}) => base(e, extra, userClientId)
      event(tagged('run.started', { status: 'in_progress', queue_length: 0 }))
      event(tagged('message.delta', { delta: 'First segment.' }))
      event(tagged('tool.started', { tool_call_id: 'toolu_1', tool: 'Bash', name: 'Bash', arguments: '{}', preview: 'ls' }))
      event(tagged('tool.completed', { tool_call_id: 'toolu_1', tool: 'Bash', name: 'Bash', output: 'ok', duration: 0.1 }))
      event(tagged('message.delta', { delta: 'Final answer.' }))
      event(tagged('run.completed', { output: 'First segment.Final answer.', message_id: 1003, workspace_run_change: null }))

      expect(textSegments(s).map(m => m.content)).toEqual(['First segment.', 'Final answer.'])
      expect(s.messages.filter(m => m.role === 'assistant' && m.isStreaming)).toHaveLength(0)
      // The user's identity must never be adopted by an assistant row.
      expect(s.messages.filter(m => m.role === 'assistant' && m.clientMessageId === userClientId)).toHaveLength(0)
      expect(s.messages.filter(m => m.role === 'user')).toHaveLength(1)
    })

    it(`per-segment am_ wire binds the terminal content to the final segment only, resumed=${resumed}`, async () => {
      const { s, event } = await setup(resumed)
      event(base('run.started', { status: 'in_progress', queue_length: 0 }, undefined))
      event(base('message.delta', { delta: 'First segment.' }, 'am_1'))
      event(base('tool.started', { tool_call_id: 'toolu_1', tool: 'Bash', name: 'Bash', arguments: '{}', preview: 'ls', assistant_client_message_id: 'am_tool' }, undefined))
      event(base('tool.completed', { tool_call_id: 'toolu_1', tool: 'Bash', name: 'Bash', output: 'ok', duration: 0.1 }, undefined))
      event(base('message.delta', { delta: 'Final answer.' }, 'am_2'))
      event(base('run.completed', { output: 'First segment.Final answer.', assistant_content: 'Final answer.', message_id: 1003, workspace_run_change: null }, 'am_2'))

      const segments = textSegments(s)
      expect(segments.map(m => m.content)).toEqual(['First segment.', 'Final answer.'])
      expect(segments.map(m => m.clientMessageId)).toEqual(['am_1', 'am_2'])
      expect(segments[1].id).toBe('1003')
      expect(segments[0].id).not.toBe('1003')
    })
  }
})
