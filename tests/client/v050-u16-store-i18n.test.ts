// @vitest-environment jsdom
// hermes-v050:U16 — store 里写死的英文改走 i18n；没有 app i18n 时（单测 / 旧路径）保持英文原文。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createApp, nextTick } from 'vue'

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

const mockKanbanApi = vi.hoisted(() => ({
  listBoards: vi.fn(),
  getCapabilities: vi.fn(),
  openKanbanEventStream: vi.fn(),
}))
vi.mock('@/api/hermes/kanban', () => mockKanbanApi)

import { createI18n } from 'vue-i18n'
import en from '@/i18n/locales/en'
import zh from '@/i18n/locales/zh'
import { mergeMessagesWithFallback } from '@/i18n/messages'
import { useChatStore, type Message, type Session } from '@/stores/hermes/chat'
import { useModelsStore } from '@/stores/hermes/models'
import { useKanbanStore } from '@/stores/hermes/kanban'

function installZhApp() {
  const app = createApp({})
  const pinia = createPinia()
  app.use(createI18n({ legacy: false, locale: 'zh', fallbackLocale: 'en', messages: { en, zh: mergeMessagesWithFallback(en, zh) } }))
  app.use(pinia)
  setActivePinia(pinia)
  return app
}

function makeSession(id: string): Session {
  return { id, title: id, messages: [], createdAt: Date.now(), updatedAt: Date.now() }
}

describe('hermes-v050:U16 store copy follows the UI language (T8/T9/T18/T20/T25/T26)', () => {
  let handlers: any

  beforeEach(() => {
    handlers = undefined
    vi.resetAllMocks()
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({ session_id: sessionId, messages: [], isWorking: true, events: [] })
      return {} as any
    })
    chatApi.registerSessionHandlers.mockImplementation((_sid: string, registered: any) => {
      handlers = registered
      return vi.fn()
    })
    mockKanbanApi.listBoards.mockResolvedValue([{ slug: 'project-a', name: 'Project A', archived: false, counts: {}, total: 0 }])
    mockKanbanApi.getCapabilities.mockResolvedValue({ source: 'hermes-cli', supports: { boardsList: true }, missing: [] })
    mockKanbanApi.openKanbanEventStream.mockReturnValue({ close: vi.fn() })
  })

  it('keeps English store copy when no app i18n is installed (existing behaviour and tests)', async () => {
    setActivePinia(createPinia())
    const store = useChatStore()
    store.sessions = [makeSession('s1')]
    await store.switchSession('s1')
    handlers.onRunFailed({ event: 'run.failed', session_id: 's1', error: 'boom', run_id: 'r1' })
    await nextTick()
    expect(store.activeSession?.messages.at(-1)?.content).toBe('Error: boom')
  })

  it('localizes the error bubble prefix (T8)', async () => {
    installZhApp()
    const store = useChatStore()
    store.sessions = [makeSession('s1')]
    await store.switchSession('s1')
    handlers.onRunFailed({ event: 'run.failed', session_id: 's1', error: 'boom', run_id: 'r1' })
    await nextTick()
    expect(store.activeSession?.messages.at(-1)).toEqual(expect.objectContaining({ role: 'assistant', systemType: 'error', content: '错误：boom' }))
  })

  it('localizes the empty "Run failed" bubble (T8)', async () => {
    installZhApp()
    const store = useChatStore()
    store.sessions = [makeSession('s2')]
    await store.switchSession('s2')
    handlers.onRunFailed({ event: 'run.failed', session_id: 's2', run_id: 'r2' })
    await nextTick()
    expect(store.activeSession?.messages.at(-1)).toEqual(expect.objectContaining({ role: 'assistant', systemType: 'error', content: '运行失败' }))
  })

  it('localizes the "Agent returned no output" system message (T9)', async () => {
    installZhApp()
    const store = useChatStore()
    store.sessions = [makeSession('s1')]
    await store.switchSession('s1')
    handlers.onRunCompleted({ event: 'run.completed', session_id: 's1', output: '', run_id: 'r1' })
    await nextTick()
    const system = store.activeSession?.messages.filter((m: Message) => m.role === 'system') ?? []
    expect(system.at(-1)?.content).toBe(zh.chat.agentNoOutput)
  })

  it('names an untitled /branch session in the UI language (T18)', async () => {
    installZhApp()
    const store = useChatStore()
    store.sessions = [makeSession('s1')]
    await store.switchSession('s1')
    handlers.onSessionCommand({ event: 'session.command', session_id: 's1', command: 'branch', action: 'branch', ok: true, newSessionId: 'branch-1' })
    await nextTick()
    expect(store.sessions.find(s => s.id === 'branch-1')?.title).toBe('分支')
  })

  it('localizes the models store "no available models" error (T25)', async () => {
    installZhApp()
    const models = useModelsStore()
    await expect(models.setDefaultProvider('nope')).rejects.toThrow('Provider 没有可用模型')
  })

  it('localizes the kanban default board name and the fallback warning (T26)', async () => {
    installZhApp()
    const kanban = useKanbanStore()
    await kanban.fetchBoards()
    expect(kanban.activeBoards[0]).toEqual(expect.objectContaining({ slug: 'default', name: '默认' }))
    kanban.recoverSelectedBoard('missing-board')
    expect(kanban.boardWarning).toBe('看板「missing-board」不可用，已回退到「default」。')
  })
})
