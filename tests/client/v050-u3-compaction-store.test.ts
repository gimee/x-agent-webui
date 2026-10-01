// @vitest-environment jsdom
// hermes-v050:U3 — store 行为：原生压缩走压缩状态条、只压缩的回合不误报「无输出」、回执保留 code。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

const chatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(),
  resumeSession: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  socketEmit: vi.fn(),
}))

vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: chatApi.startRunViaSocket,
  resumeSession: chatApi.resumeSession,
  registerSessionHandlers: chatApi.registerSessionHandlers,
  unregisterSessionHandlers: chatApi.unregisterSessionHandlers,
  getChatRunSocket: vi.fn(() => ({ emit: chatApi.socketEmit })),
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
  onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default',
  hasApiKey: () => false,
}))

vi.mock('@/api/studio/sessions', () => ({
  archiveSession: vi.fn(),
  deleteSession: vi.fn(),
  fetchSession: vi.fn(),
  fetchSessions: vi.fn(),
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []),
  fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  setSessionModel: vi.fn(),
}))

vi.mock('@/api/studio/download', () => ({
  getDownloadUrl: (_path: string, name: string) => `/download/${name}`,
}))

vi.mock('@/api/hermes/system', () => ({
  checkHealth: vi.fn(),
  fetchAvailableModels: vi.fn(),
  addCustomModel: vi.fn(),
  removeCustomModel: vi.fn(),
  updateDefaultModel: vi.fn(),
  updateModelVisibility: vi.fn(),
  triggerUpdate: vi.fn(),
  updateModelAlias: vi.fn(),
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

import { useChatStore, type Message, type Session } from '@/stores/hermes/chat'

function makeSession(id: string, extra: Partial<Session> = {}): Session {
  return { id, title: id, messages: [], createdAt: Date.now(), updatedAt: Date.now(), ...extra }
}

const noOutput = (store: ReturnType<typeof useChatStore>) => store.activeSession?.messages.some(
  (message: Message) => message.role === 'system' && message.content.includes('Agent returned no output'),
)

describe('hermes-v050:U3 Claude native compaction in the chat store', () => {
  let handlers: any

  beforeEach(() => {
    handlers = undefined
    vi.resetAllMocks()
    setActivePinia(createPinia())
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({ session_id: sessionId, messages: [], isWorking: true, events: [] })
      return {} as any
    })
    chatApi.registerSessionHandlers.mockImplementation((_sessionId: string, registeredHandlers: any) => {
      handlers = registeredHandlers
      return vi.fn()
    })
  })

  it('shows the native compaction row and no assistant text for a compact_boundary payload', async () => {
    const store = useChatStore()
    store.sessions = [makeSession('claude-1', { source: 'coding_agent', agent: 'claude' } as any)]
    await store.switchSession('claude-1')
    // exact payload of run-manager compact_boundary (tests/server/v050-u3-claude-compact-boundary.test.ts)
    handlers.onCompressionCompleted({ event: 'compression.completed', session_id: 'claude-1', compressed: true, totalMessages: 42, beforeTokens: 170_560, afterTokens: 7_163 })
    expect(store.compressionState).toEqual(expect.objectContaining({ compressing: false, compressed: true, messageCount: 42, beforeTokens: 170_560, afterTokens: 7_163 }))
    expect(store.activeSession?.messages.filter((m: Message) => m.role === 'assistant')).toEqual([])
  })

  it('does not report "Agent returned no output" for a Claude turn that only compacted (session handler path)', async () => {
    const store = useChatStore()
    store.sessions = [makeSession('claude-1', { source: 'coding_agent', agent: 'claude' } as any)]
    await store.switchSession('claude-1')
    handlers.onCompressionCompleted({ event: 'compression.completed', session_id: 'claude-1', compressed: true, totalMessages: 42, beforeTokens: 9_000, afterTokens: 0 })
    handlers.onRunCompleted({ event: 'run.completed', session_id: 'claude-1', output: '', run_id: 'run-compact' })
    await nextTick()
    expect(noOutput(store)).toBe(false)
  })

  it('does not report "Agent returned no output" for a Claude /compact sent through the composer (socket path)', async () => {
    const store = useChatStore()
    const session = makeSession('claude-2', { source: 'coding_agent', agent: 'claude' } as any)
    store.sessions = [session]
    store.activeSessionId = 'claude-2'
    store.activeSession = session
    await store.sendMessage('/compact')
    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: any) => void
    onEvent({ event: 'run.started', session_id: 'claude-2', run_id: 'run-compact-2' })
    onEvent({ event: 'compression.completed', session_id: 'claude-2', compressed: true, totalMessages: 3, beforeTokens: 9_000, afterTokens: 900 })
    onEvent({ event: 'run.completed', session_id: 'claude-2', output: '', run_id: 'run-compact-2' })
    await nextTick()
    expect(noOutput(store)).toBe(false)
  })

  it('still reports a silently empty Hermes run even if context compression ran first', async () => {
    const store = useChatStore()
    store.sessions = [makeSession('hermes-1')]
    await store.switchSession('hermes-1')
    handlers.onCompressionCompleted({ event: 'compression.completed', session_id: 'hermes-1', compressed: true, totalMessages: 6, beforeTokens: 9_000, afterTokens: 900 })
    handlers.onRunCompleted({ event: 'run.completed', session_id: 'hermes-1', output: '', run_id: 'run-empty' })
    await nextTick()
    expect(noOutput(store)).toBe(true)
  })

  it('keeps the receipt code and numbers on the command message so the client can render it in the UI language', async () => {
    const store = useChatStore()
    store.sessions = [makeSession('claude-1', { source: 'coding_agent', agent: 'claude' } as any)]
    await store.switchSession('claude-1')
    handlers.onSessionCommand?.({ event: 'session.command', session_id: 'claude-1', command: 'compact', action: 'compact', ok: true, terminal: false, started: true, messageCode: 'compact_sent', agentId: 'claude', message: 'Native /compact sent to Claude Code.' })
    const receipt = store.activeSession?.messages.find((m: Message) => m.role === 'command')
    expect(receipt?.content).toBe('Native /compact sent to Claude Code.')
    expect(receipt?.commandData).toEqual(expect.objectContaining({ messageCode: 'compact_sent', agentId: 'claude' }))
  })
})
