// @vitest-environment jsdom
// hermes-v051:B1/B2/B3 — 压缩状态行：实时与重放（切会话、切回标签页、重连）同一个函数，5 秒后消失；压缩后上下文数字更新；失败照常显示。
// Mock scaffolding copied from v050-u3-compaction-store.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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


const started = { event: 'compression.started', message_count: 1000, token_count: 450_000, summarizer: 'aux' }
const completed = { event: 'compression.completed', compressed: true, totalMessages: 1000, beforeTokens: 450_000, afterTokens: 80_000, contextTokens: 80_000, summarizer: 'aux' }
const failed = {
  event: 'compression.completed', compressed: false, totalMessages: 1000, resultMessages: 1000, beforeTokens: 450_000, afterTokens: 450_000,
  summaryTokens: 0, verbatimCount: 1000, compressedStartIndex: -1, error: 'claude_fork_failed', summarizer: 'claude',
}
const replay = (...events: any[]) => events.map(data => ({ event: data.event, data: { ...data, session_id: 'claude-1' } }))

describe('hermes-v051:B2 compression row clears 5s after completion on every path', () => {
  let handlers: any
  let resumeEvents: any[]

  beforeEach(() => {
    handlers = undefined
    resumeEvents = []
    vi.resetAllMocks()
    vi.useFakeTimers()
    setActivePinia(createPinia())
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({ session_id: sessionId, messages: [], isWorking: true, events: resumeEvents, contextTokens: 450_000 })
      return {} as any
    })
    chatApi.registerSessionHandlers.mockImplementation((_sessionId: string, registeredHandlers: any) => {
      handlers = registeredHandlers
      return vi.fn()
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function openClaudeSession() {
    const store = useChatStore()
    store.sessions = [makeSession('claude-1', { source: 'coding_agent', agent: 'claude' } as any)]
    await store.switchSession('claude-1')
    return store
  }

  it('switching to the session (replay) shows the finished row and clears it after 5s', async () => {
    resumeEvents = replay(started, completed)
    const store = await openClaudeSession()
    expect(store.compressionState).toEqual(expect.objectContaining({ compressing: false, compressed: true, messageCount: 1000, beforeTokens: 450_000, afterTokens: 80_000 }))
    vi.advanceTimersByTime(4_999)
    expect(store.compressionState).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(store.compressionState).toBeNull()
  })

  it('a replayed compression that is still running keeps its row', async () => {
    resumeEvents = replay(started)
    const store = await openClaudeSession()
    vi.advanceTimersByTime(60_000)
    expect(store.compressionState).toEqual(expect.objectContaining({ compressing: true, beforeTokens: 450_000 }))
  })

  it('reconnect resume of a background-watched run (session handlers) clears the replayed row after 5s', async () => {
    const store = await openClaudeSession()
    expect(store.compressionState).toBeNull()
    handlers.onReconnectResume({ session_id: 'claude-1', messages: [], isWorking: true, events: replay(started, completed) })
    expect(store.compressionState).toEqual(expect.objectContaining({ compressed: true, afterTokens: 80_000 }))
    vi.advanceTimersByTime(5_000)
    expect(store.compressionState).toBeNull()
  })

  it('reconnect resume of a run sent from this tab (socket path) clears the replayed row after 5s', async () => {
    const store = useChatStore()
    const session = makeSession('claude-2', { source: 'coding_agent', agent: 'claude' } as any)
    store.sessions = [session]
    store.activeSessionId = 'claude-2'
    store.activeSession = session
    await store.sendMessage('continue')
    const reconnect = chatApi.startRunViaSocket.mock.calls[0][5] as { onReconnectResume: (data: any) => void }
    reconnect.onReconnectResume({ session_id: 'claude-2', messages: [], isWorking: true, events: replay(started, completed).map(e => ({ ...e, data: { ...e.data, session_id: 'claude-2' } })) })
    expect(store.compressionState).toEqual(expect.objectContaining({ compressed: true, afterTokens: 80_000 }))
    vi.advanceTimersByTime(5_000)
    expect(store.compressionState).toBeNull()
  })

  it('live events (session handlers and socket path) still clear after 5s', async () => {
    const store = await openClaudeSession()
    handlers.onCompressionStarted({ ...started, session_id: 'claude-1' })
    handlers.onCompressionCompleted({ ...completed, session_id: 'claude-1' })
    vi.advanceTimersByTime(5_000)
    expect(store.compressionState).toBeNull()

    const other = makeSession('claude-3', { source: 'coding_agent', agent: 'claude' } as any)
    store.sessions = [...store.sessions, other]
    store.activeSessionId = 'claude-3'
    store.activeSession = other
    await store.sendMessage('go')
    const onEvent = chatApi.startRunViaSocket.mock.calls.at(-1)![1] as (event: any) => void
    onEvent({ event: 'run.started', session_id: 'claude-3', run_id: 'run-3' })
    onEvent({ ...started, session_id: 'claude-3' })
    onEvent({ ...completed, session_id: 'claude-3' })
    expect(store.compressionState).toEqual(expect.objectContaining({ compressed: true }))
    vi.advanceTimersByTime(5_000)
    expect(store.compressionState).toBeNull()
  })

  it('an earlier completion timer does not clear a compression that started later', async () => {
    const store = await openClaudeSession()
    handlers.onCompressionCompleted({ ...completed, session_id: 'claude-1' })
    vi.advanceTimersByTime(2_000)
    handlers.onCompressionStarted({ ...started, session_id: 'claude-1' })
    vi.advanceTimersByTime(3_000)
    expect(store.compressionState).toEqual(expect.objectContaining({ compressing: true }))
  })
})

describe('hermes-v051:B1 R2-04 a replay within 5s keeps the real context value', () => {
  // Server replay list of a coding-agent run, in emission order (ChatRunSocket.emitExternalEvent keeps
  // every event of a working session): the estimate is pushed with the compaction, the first API call
  // after it pushes the real size. The resume payload's contextTokens is that real size.
  const claudeReplay = (sessionId: string, withRealCall = true) => [
    { event: 'compression.started', message_count: 1000, token_count: 450_000 },
    { event: 'usage.updated', inputTokens: 0, outputTokens: 0, contextTokens: 80_000 },
    { event: 'compression.completed', compressed: true, totalMessages: 1000, beforeTokens: 450_000, afterTokens: 80_000, contextTokens: 80_000, summarizer: 'aux' },
    ...(withRealCall ? [{ event: 'usage.updated', inputTokens: 0, outputTokens: 0, contextTokens: 81_253 }] : []),
  ].map(data => ({ event: data.event, data: { ...data, session_id: sessionId } }))
  let handlers: any

  beforeEach(() => {
    handlers = undefined
    vi.resetAllMocks()
    vi.useFakeTimers()
    setActivePinia(createPinia())
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
    chatApi.registerSessionHandlers.mockImplementation((_sessionId: string, registeredHandlers: any) => {
      handlers = registeredHandlers
      return vi.fn()
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('switching back (switchSession replay) shows 81,253, not the replayed 79,100 estimate', async () => {
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({ session_id: sessionId, messages: [], isWorking: true, contextTokens: 81_253, events: claudeReplay(sessionId) })
      return {} as any
    })
    const store = useChatStore()
    store.sessions = [makeSession('claude-1', { source: 'coding_agent', agent: 'claude' } as any)]
    await store.switchSession('claude-1')
    expect(store.sessions[0].contextTokens).toBe(81_253)
    // the row itself is still replayed and still clears after 5s
    expect(store.compressionState).toEqual(expect.objectContaining({ compressed: true, afterTokens: 80_000 }))
    vi.advanceTimersByTime(5_000)
    expect(store.compressionState).toBeNull()
    expect(store.sessions[0].contextTokens).toBe(81_253)
  })

  it('before the first API call the replay still shows the estimate', async () => {
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({ session_id: sessionId, messages: [], isWorking: true, contextTokens: 80_000, events: claudeReplay(sessionId, false) })
      return {} as any
    })
    const store = useChatStore()
    store.sessions = [makeSession('claude-1', { source: 'coding_agent', agent: 'claude', contextTokens: 450_000 } as any)]
    await store.switchSession('claude-1')
    expect(store.sessions[0].contextTokens).toBe(80_000)
  })

  it('reconnect resume (session handlers) keeps 81,253', async () => {
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({ session_id: sessionId, messages: [], isWorking: true, contextTokens: 81_253, events: [] })
      return {} as any
    })
    const store = useChatStore()
    store.sessions = [makeSession('claude-1', { source: 'coding_agent', agent: 'claude' } as any)]
    await store.switchSession('claude-1')
    handlers.onReconnectResume({ session_id: 'claude-1', messages: [], isWorking: true, contextTokens: 81_253, events: claudeReplay('claude-1') })
    expect(store.sessions[0].contextTokens).toBe(81_253)
  })

  // A Hermes replay list never carries usage.updated (only pushState/replaceState entries), while the
  // run can move the size after a pre-run compression (bridge.context.ready): the resume value wins.
  const hermesReplay = (sessionId: string) => [
    { event: 'compression.started', message_count: 40, token_count: 190_000 },
    { event: 'compression.completed', compressed: true, totalMessages: 40, beforeTokens: 190_000, afterTokens: 30_000, contextTokens: 30_000 },
  ].map(data => ({ event: data.event, data: { ...data, session_id: sessionId } }))

  it('Hermes: switching back keeps the resume value when the replay has no usage.updated', async () => {
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({ session_id: sessionId, messages: [], isWorking: true, contextTokens: 30_512, events: hermesReplay(sessionId) })
      return {} as any
    })
    const store = useChatStore()
    store.sessions = [makeSession('hermes-1')]
    await store.switchSession('hermes-1')
    expect(store.sessions[0].contextTokens).toBe(30_512)
    expect(store.compressionState).toEqual(expect.objectContaining({ compressed: true, afterTokens: 30_000 }))
  })

  it('Hermes: reconnect resume keeps the resume value when the replay has no usage.updated', async () => {
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({ session_id: sessionId, messages: [], isWorking: true, contextTokens: 30_512, events: [] })
      return {} as any
    })
    const store = useChatStore()
    store.sessions = [makeSession('hermes-1')]
    await store.switchSession('hermes-1')
    handlers.onReconnectResume({ session_id: 'hermes-1', messages: [], isWorking: true, contextTokens: 30_512, events: hermesReplay('hermes-1') })
    expect(store.sessions[0].contextTokens).toBe(30_512)
  })

  it('reconnect resume (socket path of a run sent from this tab) keeps 81,253', async () => {
    const store = useChatStore()
    const session = makeSession('claude-2', { source: 'coding_agent', agent: 'claude' } as any)
    store.sessions = [session]
    store.activeSessionId = 'claude-2'
    store.activeSession = session
    await store.sendMessage('continue')
    const reconnect = chatApi.startRunViaSocket.mock.calls[0][5] as { onReconnectResume: (data: any) => void }
    reconnect.onReconnectResume({ session_id: 'claude-2', messages: [], isWorking: true, contextTokens: 81_253, events: claudeReplay('claude-2') })
    expect(store.sessions[0].contextTokens).toBe(81_253)
  })
})

describe('hermes-v051:B1 context meter follows the compaction', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    setActivePinia(createPinia())
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({ session_id: sessionId, messages: [], isWorking: true, events: [], contextTokens: 450_000 })
      return {} as any
    })
  })

  it('450.0K -> 80.0K (estimate) -> real value of the next API call', async () => {
    let handlers: any
    chatApi.registerSessionHandlers.mockImplementation((_sessionId: string, registeredHandlers: any) => {
      handlers = registeredHandlers
      return vi.fn()
    })
    const store = useChatStore()
    store.sessions = [makeSession('claude-1', { source: 'coding_agent', agent: 'claude' } as any)]
    await store.switchSession('claude-1')
    expect(store.activeSession?.contextTokens).toBe(450_000)
    handlers.onUsageUpdated({ event: 'usage.updated', session_id: 'claude-1', inputTokens: 0, outputTokens: 0, contextTokens: 80_000 })
    handlers.onCompressionCompleted({ ...completed, session_id: 'claude-1' })
    expect(store.activeSession?.contextTokens).toBe(80_000)
    handlers.onUsageUpdated({ event: 'usage.updated', session_id: 'claude-1', inputTokens: 0, outputTokens: 0, contextTokens: 81_253 })
    expect(store.activeSession?.contextTokens).toBe(81_253)
  })
})

describe('hermes-v051:B3 failed compaction shows the existing failure row', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers()
    setActivePinia(createPinia())
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({ session_id: sessionId, messages: [], isWorking: true, events: [], contextTokens: 450_000 })
      return {} as any
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows compressed:false with the error, keeps the meter, and clears after 5s', async () => {
    let handlers: any
    chatApi.registerSessionHandlers.mockImplementation((_sessionId: string, registeredHandlers: any) => {
      handlers = registeredHandlers
      return vi.fn()
    })
    const store = useChatStore()
    store.sessions = [makeSession('claude-1', { source: 'coding_agent', agent: 'claude' } as any)]
    await store.switchSession('claude-1')
    handlers.onCompressionStarted({ ...started, session_id: 'claude-1' })
    handlers.onCompressionCompleted({ ...failed, session_id: 'claude-1' })
    expect(store.compressionState).toEqual(expect.objectContaining({ compressing: false, compressed: false, error: 'claude_fork_failed', beforeTokens: 450_000 }))
    expect(store.activeSession?.contextTokens).toBe(450_000)
    vi.advanceTimersByTime(5_000)
    expect(store.compressionState).toBeNull()
  })
})
