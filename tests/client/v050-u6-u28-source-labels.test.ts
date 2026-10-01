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
import { createI18n } from 'vue-i18n'
import en from '@/i18n/locales/en'
import zh from '@/i18n/locales/zh'
import zhTW from '@/i18n/locales/zh-TW'
import { mergeMessagesWithFallback } from '@/i18n/messages'
import { getSourceLabel } from '@/shared/session-display'
import { useSessionSearch } from '@/composables/useSessionSearch'


function i18nFor(locale: 'zh' | 'zh-TW' | 'en') {
  return createI18n({ legacy: false, locale, fallbackLocale: 'en', messages: { en, zh: mergeMessagesWithFallback(en, zh), 'zh-TW': mergeMessagesWithFallback(en, zhTW) } })
}

const summary = (id: string, source: string) => ({
  id, source, model: 'm', title: id, preview: '', started_at: 1, ended_at: 1, last_active: 1, message_count: 1, tool_call_count: 0,
  input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, billing_provider: '', estimated_cost_usd: 0, actual_cost_usd: 0, cost_status: 'estimated',
})

describe('hermes-v050:U28 session source names go through i18n', () => {
  it('keeps the English labels when no translator is passed (backward compatible)', () => {
    expect(getSourceLabel('coding_agent')).toBe('Coding Agent')
    expect(getSourceLabel('global_agent')).toBe('Global Agent')
    expect(getSourceLabel('weixin')).toBe('WeChat')
    expect(getSourceLabel('')).toBe('')
    expect(getSourceLabel('unknown_source')).toBe('unknown_source')
  })

  it('uses the sidebar wording in Chinese and keeps brand / protocol names', () => {
    const t = i18nFor('zh').global.t as any
    const zhLabels = Object.fromEntries(['coding_agent', 'global_agent', 'api_server', 'feishu', 'weixin', 'dingtalk', 'wecom', 'email', 'sms', 'cron', 'cli', 'telegram', 'discord', 'slack', 'matrix', 'whatsapp', 'signal', 'bluebubbles', 'mattermost']
      .map(source => [source, getSourceLabel(source, t)]))
    expect(zhLabels).toEqual({
      coding_agent: '编程工具',
      global_agent: '全局',
      api_server: 'API 服务器',
      feishu: '飞书',
      weixin: '微信',
      dingtalk: '钉钉',
      wecom: '企业微信',
      email: '邮箱',
      sms: '短信',
      cron: '定时任务',
      cli: 'CLI',
      telegram: 'Telegram',
      discord: 'Discord',
      slack: 'Slack',
      matrix: 'Matrix',
      whatsapp: 'WhatsApp',
      signal: 'Signal',
      bluebubbles: 'iMessage',
      mattermost: 'Mattermost',
    })
    expect(getSourceLabel('coding_agent', i18nFor('zh-TW').global.t as any)).toBe('編程工具')
    expect(getSourceLabel('coding_agent', i18nFor('en').global.t as any)).toBe('Coding Agent')
    expect(getSourceLabel('weixin', i18nFor('en').global.t as any)).toBe('WeChat')
  })
})

describe('hermes-v050:U6 session search modal uses the shared source labels', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    chatStoreMock.sessions = []
    chatStoreMock.loadSessions.mockResolvedValue(undefined)
    apiMocks.fetchSessionsMock.mockResolvedValue([summary('a', 'coding_agent'), summary('b', 'cli'), summary('c', 'global_agent'), summary('d', 'weixin')])
    apiMocks.searchSessionsMock.mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows 编程工具 instead of the raw coding_agent id', async () => {
    const { openSessionSearch, closeSessionSearch } = useSessionSearch() as any
    const wrapper = mount(SessionSearchModal, { global: { plugins: [i18nFor('zh')] } })
    openSessionSearch()
    await nextTick()
    await vi.runAllTimersAsync()
    await nextTick()
    const labels = wrapper.findAll('.result-source').map(node => node.text())
    expect(labels).toEqual(['编程工具', 'CLI', '全局', '微信'])
    expect(labels).not.toContain('coding_agent')
    closeSessionSearch?.()
    wrapper.unmount()
  })
})
