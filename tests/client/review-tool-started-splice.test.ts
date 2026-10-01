// @vitest-environment jsdom
// 审查复现：tool.started 删除空正文助手段时，因 updateMessage 已替换对象，indexOf 返回 -1，splice(-1,1) 删错消息
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatApi = vi.hoisted(() => ({
  starts: [] as Array<{ body: any; onEvent: (event: any) => void }>,
}))

vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: vi.fn((body: any, onEvent: (event: any) => void) => {
    chatApi.starts.push({ body, onEvent })
    return { abort: vi.fn() }
  }),
  resumeSession: vi.fn((sessionId: string, callback: (data: any) => void) => callback({ session_id: sessionId, messages: [], isWorking: false, events: [] })),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
  onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))
vi.mock('@/api/studio/sessions', () => ({
  fetchSessions: vi.fn(async () => []),
  fetchSessionMessagesPage: vi.fn(),
  fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  archiveSession: vi.fn(), deleteSession: vi.fn(), setSessionModel: vi.fn(),
  setSessionPushEnabled: vi.fn(), setSessionReasoningEffort: vi.fn(),
}))
vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'default', hasApiKey: vi.fn(() => false) }))
vi.mock('@/api/studio/download', () => ({ getDownloadUrl: (_p: string, n: string) => `/download/${n}` }))
vi.mock('@/utils/completion-sound', () => ({ primeCompletionSound: vi.fn(), playCompletionSound: vi.fn() }))
vi.mock('@/utils/completion-notification', () => ({ showCompletionNotification: vi.fn() }))

import { useChatStore, type Session } from '@/stores/hermes/chat'

function makeSession(id = 'session-1'): Session {
  return { id, title: '', messages: [], createdAt: Date.now(), updatedAt: Date.now(), source: 'cli', profile: 'default', messageCount: 0, messageTotal: 0, loadedMessageCount: 0, hasMoreBefore: false }
}

describe('tool.started removal of empty reasoning-only assistant segment', () => {
  beforeEach(() => {
    chatApi.starts.length = 0
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('removes the empty assistant segment, not whatever happens to be last (agent.event after it)', async () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = session.id
    store.activeSession = session

    await store.sendMessage('hello')
    const { onEvent } = chatApi.starts[0]
    onEvent({ event: 'run.started', session_id: session.id, run_id: 'run-1', run_marker: 'rm-1' })
    // 助手段 am_1 只有推理、无正文，仍在流式
    onEvent({ event: 'reasoning.delta', session_id: session.id, run_marker: 'rm-1', client_message_id: 'am_1', text: 'thinking...' })
    // 桥接 status 事件 → agent.event 系统消息追加在助手段之后
    onEvent({ event: 'agent.event', session_id: session.id, run_marker: 'rm-1', text: 'Retrying model call' })
    expect(session.messages.map(m => m.role)).toEqual(['user', 'assistant', 'system'])

    onEvent({
      event: 'tool.started', session_id: session.id, run_marker: 'rm-1',
      tool: 'read_file', tool_call_id: 'call_1', assistant_client_message_id: 'am_1',
    })

    const detailed = session.messages.map(m => `${m.role}${m.commandAction ? ':' + m.commandAction : ''}${m.clientMessageId ? ':' + m.clientMessageId : ''}${m.reasoning ? ':reasoning=' + m.reasoning : ''}`)
    console.log('actual after tool.started:', JSON.stringify(detailed))
    // 期望：空正文助手段被删、agent.event 保留、工具行追加
    expect(session.messages.some(m => m.role === 'assistant' && m.clientMessageId === 'am_1')).toBe(false)
    // 审查原稿在此处对比的是带 clientMessageId/reasoning 后缀的字串，与期望值形状不一致（user 行永远带 cm_ 后缀），
    // 这里只比较 role(+commandAction)；工具行继承的 reasoning 属于既有正确行为，单独断言。
    const roles = session.messages.map(m => `${m.role}${m.commandAction ? ':' + m.commandAction : ''}`)
    expect(roles).toEqual(['user', 'system:agent.event', 'tool'])
    expect(session.messages[2].reasoning).toBe('thinking...')
  })
})
