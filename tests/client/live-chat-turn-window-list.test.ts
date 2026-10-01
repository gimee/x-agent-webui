// @vitest-environment jsdom
// Guard test for the live chat turn window. The source tree is frozen, edit here.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, nextTick } from 'vue'

const mockScrollToBottom = vi.hoisted(() => vi.fn())
const mockScrollToMessage = vi.hoisted(() => vi.fn())
const mockScrollToAnchor = vi.hoisted(() => vi.fn())
const mockCaptureViewportPosition = vi.hoisted(() => vi.fn())
const mockRestoreViewportPosition = vi.hoisted(() => vi.fn())
const mockCaptureScrollPosition = vi.hoisted(() => vi.fn())
const mockRestoreScrollPosition = vi.hoisted(() => vi.fn())
const mockIsNearBottom = vi.hoisted(() => vi.fn(() => true))
const mockShouldAutoFollowBottom = vi.hoisted(() => vi.fn(() => true))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({ isDark: false }),
}))

vi.mock('@/components/hermes/chat/VirtualMessageList.vue', () => ({
  default: defineComponent({
    name: 'VirtualMessageList',
    props: {
      messages: { type: Array, default: () => [] },
      virtualized: { type: Boolean, default: true },
    },
    emits: ['top-reach'],
    setup(_props, { expose }) {
      expose({
        isNearBottom: mockIsNearBottom,
        scrollToBottom: mockScrollToBottom,
        scrollToMessage: mockScrollToMessage,
        scrollToAnchor: mockScrollToAnchor,
        captureScrollPosition: mockCaptureScrollPosition,
        restoreScrollPosition: mockRestoreScrollPosition,
        captureViewportPosition: mockCaptureViewportPosition,
        restoreViewportPosition: mockRestoreViewportPosition,
        shouldAutoFollowBottom: mockShouldAutoFollowBottom,
      })
    },
    template: `
      <div class="virtual-message-list-stub">
        <slot v-if="messages.length === 0" name="empty" />
        <slot name="before" />
        <slot name="item" v-for="message in messages" :key="message.id" :message="message" />
      </div>
    `,
  }),
}))

vi.mock('@/components/hermes/chat/MessageItem.vue', () => ({
  default: defineComponent({
    name: 'MessageItem',
    props: {
      message: { type: Object, required: true },
      assistantAgent: { type: Object, default: null },
    },
    template: '<div class="stub-message" :data-id="message.id">{{ message.content }}</div>',
  }),
}))

import MessageList from '@/components/hermes/chat/MessageList.vue'
import { useChatStore, type Message, type Session } from '@/stores/hermes/chat'

function makeMessage(id: string, role: Message['role'] = 'user'): Message {
  return { id, role, content: id, timestamp: Date.now() }
}

function makeTurnMessages(turns: number, toolsPerTurn = 0): Message[] {
  const messages: Message[] = []
  for (let i = 0; i < turns; i++) {
    messages.push(makeMessage(`user-${i}`, 'user'))
    for (let t = 0; t < toolsPerTurn; t++) {
      messages.push(makeMessage(`tool-${i}-${t}`, 'tool'))
    }
    messages.push(makeMessage(`asst-${i}`, 'assistant'))
  }
  return messages
}

function makeSession(id: string, messages: Message[]): Session {
  return {
    id,
    title: id,
    profile: 'default',
    messages,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hasMoreBefore: true,
    loadedMessageCount: 300,
    messageTotal: 561,
  }
}

async function flushSessionScroll() {
  await nextTick()
  await nextTick()
}

describe('live chat turn-window archive link', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mockIsNearBottom.mockReturnValue(true)
    mockShouldAutoFollowBottom.mockReturnValue(true)
  })

  it('does not archive one user turn even when 300 raw messages are already loaded', async () => {
    const chatStore = useChatStore()
    const session = makeSession('one-turn-tools', makeTurnMessages(1, 280))
    chatStore.activeSessionId = session.id
    chatStore.activeSession = session
    const loadOlderSpy = vi.spyOn(chatStore, 'loadOlderMessages')

    const wrapper = mount(MessageList, {
      global: { stubs: { Transition: false } },
    })
    await flushSessionScroll()

    expect(wrapper.find('.history-archive-link').exists()).toBe(false)
    wrapper.getComponent({ name: 'VirtualMessageList' }).vm.$emit('top-reach')
    await nextTick()
    expect(loadOlderSpy).toHaveBeenCalledTimes(1)
  })

  it('does not archive nine user turns', async () => {
    const chatStore = useChatStore()
    const session = makeSession('nine-turns', makeTurnMessages(9))
    chatStore.activeSessionId = session.id
    chatStore.activeSession = session
    const loadOlderSpy = vi.spyOn(chatStore, 'loadOlderMessages')

    const wrapper = mount(MessageList, {
      global: { stubs: { Transition: false } },
    })
    await flushSessionScroll()

    expect(wrapper.find('.history-archive-link').exists()).toBe(false)
    wrapper.getComponent({ name: 'VirtualMessageList' }).vm.$emit('top-reach')
    await nextTick()
    expect(loadOlderSpy).toHaveBeenCalledTimes(1)
  })

  it('archives at ten user turns and stops loading older live-chat pages', async () => {
    const chatStore = useChatStore()
    const session = makeSession('ten-turns', makeTurnMessages(10))
    chatStore.activeSessionId = session.id
    chatStore.activeSession = session
    const loadOlderSpy = vi.spyOn(chatStore, 'loadOlderMessages')

    const wrapper = mount(MessageList, {
      global: { stubs: { Transition: false } },
    })
    await flushSessionScroll()

    const link = wrapper.get('.history-archive-link')
    expect(link.text()).toBe('chat.viewOlderInHistory')
    expect(link.attributes('href')).toBe('#/hermes/history/session/ten-turns?profile=default')
    wrapper.getComponent({ name: 'VirtualMessageList' }).vm.$emit('top-reach')
    await nextTick()
    expect(loadOlderSpy).not.toHaveBeenCalled()
  })
})
