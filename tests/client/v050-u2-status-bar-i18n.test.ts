// @vitest-environment jsdom
// hermes-v050:U2 — 聊天流里的压缩 / 暂停状态条走 i18n（行为测试，真实 zh 语言包）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'
import { createI18n } from 'vue-i18n'
import en from '@/i18n/locales/en'
import zh from '@/i18n/locales/zh'
import { mergeMessagesWithFallback } from '@/i18n/messages'

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

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

vi.mock('@/components/hermes/chat/VirtualMessageList.vue', () => ({
  default: defineComponent({
    name: 'VirtualMessageList',
    props: { messages: { type: Array, default: () => [] } },
    setup(_props, { expose }) {
      expose({
        isNearBottom: () => true,
        shouldAutoFollowBottom: () => true,
        scrollToBottom: vi.fn(),
        scrollToMessage: vi.fn(),
        scrollToAnchor: vi.fn(),
        captureScrollPosition: () => null,
        restoreScrollPosition: vi.fn(),
        captureViewportPosition: () => null,
        restoreViewportPosition: vi.fn(),
      })
    },
    template: '<div><slot name="item" v-for="message in messages" :key="message.id" :message="message" /><slot name="after" /></div>',
  }),
}))

vi.mock('@/components/hermes/chat/MessageItem.vue', async () => {
  const { defineComponent } = await import('vue')
  return { default: defineComponent({ name: 'MessageItem', props: { message: { type: Object, required: true } }, template: '<div class="message-item-stub" />' }) }
})

vi.mock('@/components/hermes/chat/MarkdownRenderer.vue', async () => {
  const { defineComponent } = await import('vue')
  return { default: defineComponent({ name: 'MarkdownRenderer', props: { content: { type: String, default: '' } }, template: '<div>{{ content }}</div>' }) }
})

import MessageList from '@/components/hermes/chat/MessageList.vue'
import { useChatStore, type Session } from '@/stores/hermes/chat'

function zhI18n() {
  return createI18n({ legacy: false, locale: 'zh', fallbackLocale: 'en', messages: { en, zh: mergeMessagesWithFallback(en, zh) } })
}

function makeSession(id: string): Session {
  return { id, title: id, messages: [{ id: 'u1', role: 'user', content: 'hi', timestamp: 1 }], createdAt: Date.now(), updatedAt: Date.now() }
}

describe('hermes-v050:U2 compression / pause status rows use i18n', () => {
  let handlers: any

  beforeEach(() => {
    vi.resetAllMocks()
    handlers = undefined
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({ session_id: sessionId, messages: [], isWorking: true, events: [] })
      return {} as any
    })
    chatApi.registerSessionHandlers.mockImplementation((_sid: string, registered: any) => {
      handlers = registered
      return vi.fn()
    })
  })

  async function mountRunning() {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useChatStore()
    store.sessions = [makeSession('session-1')]
    await store.switchSession('session-1')
    const wrapper = mount(MessageList, { global: { plugins: [pinia, zhI18n()] } })
    await flushPromises()
    return { store, wrapper }
  }

  const rowText = (wrapper: any) => wrapper.findAll('.compression-item .tool-call-name').map((node: any) => node.text())

  it('renders the three compression states in Chinese, aligned with 上下文压缩', async () => {
    const { wrapper } = await mountRunning()
    handlers.onCompressionStarted({ event: 'compression.started', session_id: 'session-1', message_count: 6, token_count: 31_200 })
    await flushPromises()
    expect(rowText(wrapper)).toEqual(['正在压缩上下文…（6 条消息，约 31.2K tokens）'])

    handlers.onCompressionCompleted({ event: 'compression.completed', session_id: 'session-1', compressed: true, totalMessages: 6, beforeTokens: 168_400, afterTokens: 7_420 })
    await flushPromises()
    expect(rowText(wrapper)).toEqual(['已压缩 6 条消息：约 168.4K → 7.4K tokens'])

    handlers.onCompressionCompleted({ event: 'compression.completed', session_id: 'session-1', compressed: false, totalMessages: 6, beforeTokens: 100, afterTokens: 100 })
    await flushPromises()
    expect(rowText(wrapper)).toEqual(['已跳过压缩'])
  })

  it('does not print a fake "→ 0 tokens" when a native compaction reports no post-compaction size', async () => {
    const { wrapper } = await mountRunning()
    handlers.onCompressionCompleted({ event: 'compression.completed', session_id: 'session-1', compressed: true, totalMessages: 12, beforeTokens: 118_640, afterTokens: 0 })
    await flushPromises()
    expect(rowText(wrapper)).toEqual(['已压缩 12 条消息：压缩前约 118.6K tokens'])
  })

  it('renders the four pause states in Chinese and reuses jobs.status.paused for Paused', async () => {
    const { store, wrapper } = await mountRunning()
    store.abortState = { aborting: true, synced: null }
    await flushPromises()
    expect(rowText(wrapper)).toEqual(['正在暂停，等待运行停止并同步…'])

    store.abortState = { aborting: true, synced: false, timedOut: true }
    await flushPromises()
    expect(rowText(wrapper)).toEqual(['仍在停止，新消息将排队'])

    store.abortState = { aborting: false, synced: true }
    await flushPromises()
    expect(rowText(wrapper)).toEqual(['已暂停并同步'])

    store.abortState = { aborting: false, synced: false }
    await flushPromises()
    expect(rowText(wrapper)).toEqual([zh.jobs.status.paused])
  })

  it('keeps a server-provided timeout message verbatim', async () => {
    const { store, wrapper } = await mountRunning()
    store.abortState = { aborting: true, synced: false, timedOut: true, message: 'custom server note' }
    await flushPromises()
    expect(rowText(wrapper)).toEqual(['custom server note'])
  })
})
