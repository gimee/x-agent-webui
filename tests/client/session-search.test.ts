// @vitest-environment jsdom
import { nextTick, defineComponent, h } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const apiMocks = vi.hoisted(() => ({
  fetchSessionsMock: vi.fn(),
  searchSessionsMock: vi.fn(),
  fetchSessionContextMock: vi.fn(),
  routerPushMock: vi.fn(),
}))

vi.mock('@/api/studio/sessions', () => ({
  fetchSessions: apiMocks.fetchSessionsMock,
  searchSessions: apiMocks.searchSessionsMock,
  fetchSessionContext: apiMocks.fetchSessionContextMock,
}))

const chatStoreMock = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, any>>,
  loadSessions: vi.fn(),
  switchSession: vi.fn(),
  newChat: vi.fn(),
}))

vi.mock('@/stores/hermes/chat', () => ({
  useChatStore: () => chatStoreMock,
}))

const routerCurrentRoute = { value: { name: 'hermes.logs' } }

vi.mock('vue-router', () => ({
  useRouter: () => ({
    currentRoute: routerCurrentRoute,
    push: apiMocks.routerPushMock,
  }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<any>('naive-ui')
  return {
    ...actual,
    useMessage: () => ({
      error: vi.fn(),
    }),
    NModal: {
      props: ['show'],
      emits: ['update:show'],
      template: '<div v-if="show" class="n-modal-stub"><slot /></div>',
    },
    NInput: {
      props: ['value', 'size'],
      emits: ['update:value', 'keydown'],
      template: '<input class="n-input-stub" :value="value" @input="$emit(\'update:value\', $event.target.value)" @keydown="$emit(\'keydown\', $event)" />',
    },
    NSpin: {
      template: '<div class="n-spin-stub"><slot /></div>',
    },
    NButton: {
      template: '<button class="n-button-stub"><slot /></button>',
    },
  }
})

vi.mock('@/components/hermes/chat/MessageItem.vue', () => ({
  default: {
    props: ['message'],
    template: '<div class="message-item-stub">{{ message.content }}</div>',
  },
}))

import SessionSearchModal from '@/components/hermes/chat/SessionSearchModal.vue'
import { useSessionSearch } from '@/composables/useSessionSearch'
import { useKeyboard } from '@/composables/useKeyboard'

function flushPromises() {
  return Promise.resolve().then(() => Promise.resolve())
}

describe('session search modal', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    chatStoreMock.sessions = []
    chatStoreMock.loadSessions.mockResolvedValue(undefined)
    chatStoreMock.switchSession.mockResolvedValue(undefined)
    apiMocks.fetchSessionsMock.mockResolvedValue([
      {
        id: 'recent-1',
        source: 'cli',
        model: 'openai/gpt-5.4',
        title: 'Recent Docker fix',
        preview: 'recent preview',
        started_at: 1710000000,
        ended_at: 1710000001,
        last_active: 1710000002,
        message_count: 2,
        tool_call_count: 0,
        input_tokens: 1,
        output_tokens: 2,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openrouter',
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
        cost_status: 'estimated',
      },
    ])
    apiMocks.searchSessionsMock.mockResolvedValue([
      {
        id: 'match-1',
        source: 'telegram',
        model: 'openai/gpt-5.4',
        title: 'Debugging session',
        preview: 'search preview',
        started_at: 1710001000,
        ended_at: null,
        last_active: 1710001005,
        message_count: 4,
        tool_call_count: 1,
        input_tokens: 3,
        output_tokens: 4,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openrouter',
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
        cost_status: 'estimated',
        matched_message_id: 17,
        snippet: 'docker compose up',
        rank: 0.1,
      },
    ])
    apiMocks.fetchSessionContextMock.mockResolvedValue({
      session_id: 'match-1',
      messages: [
        { id: 16, role: 'user', content: '先确认 docker 环境', timestamp: 1710000990 },
        { id: 17, role: 'assistant', content: 'docker compose up', timestamp: 1710001000 },
      ],
      message_count: 2,
    })
    routerCurrentRoute.value = { name: 'hermes.logs' }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens from Cmd/Ctrl+K and loads recent sessions', async () => {
    const { openSessionSearch, sessionSearchOpen } = useSessionSearch()
    const wrapper = mount(SessionSearchModal, {
      global: {
        stubs: {
          NModal: false,
          NInput: false,
          NSpin: false,
          NButton: false,
        },
      },
    })

    openSessionSearch()
    await flushPromises()
    await nextTick()

    expect(sessionSearchOpen.value).toBe(true)
    expect(apiMocks.fetchSessionsMock).toHaveBeenCalledWith(undefined, 8)
    expect(wrapper.text()).toContain('Recent Docker fix')
  })

  it('searches by content and opens the matched session', async () => {
    const { openSessionSearch } = useSessionSearch()
    const wrapper = mount(SessionSearchModal, {
      global: {
        stubs: {
          MessageItem: {
            props: ['message'],
            template: '<div class="message-item-stub">{{ message.content }}</div>',
          },
        },
      },
    })

    openSessionSearch()
    await flushPromises()
    await nextTick()

    const input = wrapper.find('input.n-input-stub')
    await input.setValue('docker')
    await vi.advanceTimersByTimeAsync(200)
    await flushPromises()
    await nextTick()

    // hermes-v050:E-02 no result cap (v0.4.6 behaviour, replaces the S3 limit of 50);
    // hermes-v050:S9: each search carries an abort signal.
    expect(apiMocks.searchSessionsMock).toHaveBeenCalledWith('docker', undefined, undefined, undefined, { signal: expect.any(AbortSignal) })
    expect(wrapper.text()).toContain('Debugging session')

    await wrapper.find('button.result-item').trigger('click')
    await flushPromises()
    await nextTick()

    expect(apiMocks.fetchSessionContextMock).toHaveBeenCalledWith('match-1', undefined)
    expect(useSessionSearch().sessionSearchOpen.value).toBe(true)
    expect(wrapper.find('.preview-content').exists()).toBe(true)
    expect(wrapper.find('.preview-close').exists()).toBe(true)
    expect(wrapper.find('.preview-enter').exists()).toBe(true)
    expect(wrapper.findAll('.message-item-stub')).toHaveLength(2)
    expect(wrapper.text()).toContain('先确认 docker 环境')
    expect(wrapper.text()).toContain('docker compose up')
    expect(chatStoreMock.loadSessions).not.toHaveBeenCalled()

    await wrapper.find('.preview-close').trigger('click')
    await nextTick()
    expect(wrapper.text()).toContain('Debugging session')
    expect(wrapper.find('.preview-enter').exists()).toBe(false)

    await wrapper.find('button.result-item').trigger('click')
    await wrapper.find('.preview-enter').trigger('click')
    await flushPromises()

    expect(useSessionSearch().sessionSearchOpen.value).toBe(false)
    expect(chatStoreMock.loadSessions).toHaveBeenCalled()
    expect(chatStoreMock.switchSession).toHaveBeenCalledWith('match-1', '17')
    expect(apiMocks.routerPushMock).toHaveBeenCalledWith({ name: 'hermes.session', params: { sessionId: 'match-1' } })
  })

  it('hermes-v050:E-02 requests every match (no limit) and lists all of them, profile filter included', async () => {
    const many = Array.from({ length: 120 }, (_, index) => ({
      id: `match-${index}`,
      source: index % 2 ? 'coding_agent' : 'cli',
      model: '',
      title: `Result ${index}`,
      preview: '',
      started_at: 1710000000,
      ended_at: null,
      last_active: 1710001000 - index,
      message_count: 1,
      matched_message_id: null,
      snippet: '',
      rank: 1,
    }))
    apiMocks.searchSessionsMock.mockResolvedValue(many)
    ;(chatStoreMock as any).sessionProfileFilter = 'work'
    try {
      const { openSessionSearch } = useSessionSearch()
      const wrapper = mount(SessionSearchModal)
      openSessionSearch()
      await flushPromises()
      await nextTick()

      await wrapper.find('input.n-input-stub').setValue('nova')
      await vi.advanceTimersByTimeAsync(200)
      await flushPromises()
      await nextTick()

      expect(apiMocks.searchSessionsMock).toHaveBeenCalledWith('nova', undefined, undefined, 'work', { signal: expect.any(AbortSignal) })
      expect(wrapper.findAll('button.result-item')).toHaveLength(120)
      expect(wrapper.text()).toContain('Result 119')
      wrapper.unmount()
    } finally {
      delete (chatStoreMock as any).sessionProfileFilter
      useSessionSearch().closeSessionSearch()
    }
  })
})

describe('hermes-v050:S9 stale session searches', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    chatStoreMock.sessions = []
    apiMocks.fetchSessionsMock.mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
    useSessionSearch().closeSessionSearch()
  })

  it('aborts the in-flight search request when a newer query starts and when the modal closes', async () => {
    const signals: AbortSignal[] = []
    apiMocks.searchSessionsMock.mockImplementation((_q: string, _s: unknown, _l: unknown, _p: unknown, options?: { signal?: AbortSignal }) => {
      if (options?.signal) signals.push(options.signal)
      return new Promise(() => {})
    })
    const { openSessionSearch, closeSessionSearch } = useSessionSearch()
    const wrapper = mount(SessionSearchModal)
    openSessionSearch()
    await flushPromises()
    await nextTick()

    const input = wrapper.find('input.n-input-stub')
    await input.setValue('doc')
    await vi.advanceTimersByTimeAsync(200)
    await input.setValue('docker')
    await vi.advanceTimersByTimeAsync(200)

    expect(apiMocks.searchSessionsMock).toHaveBeenCalledTimes(2)
    expect(signals).toHaveLength(2)
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)

    closeSessionSearch()
    await nextTick()
    expect(signals[1].aborted).toBe(true)
  })
})

describe('keyboard shortcut', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const { closeSessionSearch } = useSessionSearch()
    closeSessionSearch()
    chatStoreMock.newChat.mockReset()
  })

  it('opens session search on Cmd/Ctrl+K', async () => {
    const Dummy = defineComponent({
      setup() {
        useKeyboard()
        return () => h('div')
      },
    })

    mount(Dummy)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    await nextTick()

    expect(useSessionSearch().sessionSearchOpen.value).toBe(true)
  })

  it.each([
    ['Cmd', { metaKey: true }],
    ['Ctrl', { ctrlKey: true }],
  ])('opens settings on %s+Comma', async (_label, modifiers) => {
    const Dummy = defineComponent({
      setup() {
        useKeyboard()
        return () => h('div')
      },
    })

    const wrapper = mount(Dummy)

    const event = new KeyboardEvent('keydown', {
      key: ',',
      ...modifiers,
      bubbles: true,
      cancelable: true,
    })
    window.dispatchEvent(event)
    await nextTick()

    expect(apiMocks.routerPushMock).toHaveBeenCalledWith({ name: 'hermes.settings' })
    expect(event.defaultPrevented).toBe(true)

    wrapper.unmount()
  })

  it('does not open settings from the login page', async () => {
    routerCurrentRoute.value = { name: 'login' }
    const Dummy = defineComponent({
      setup() {
        useKeyboard()
        return () => h('div')
      },
    })

    const wrapper = mount(Dummy)

    const event = new KeyboardEvent('keydown', {
      key: ',',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    window.dispatchEvent(event)
    await nextTick()

    expect(apiMocks.routerPushMock).not.toHaveBeenCalledWith({ name: 'hermes.settings' })
    expect(event.defaultPrevented).toBe(false)

    wrapper.unmount()
  })
})
