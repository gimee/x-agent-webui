// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import { nextTick } from 'vue'
import { useChatStore } from '@/stores/hermes/chat'
import { useSettingsStore } from '@/stores/hermes/settings'
import ChatInput from '@/components/hermes/chat/ChatInput.vue'
import { createI18n } from 'vue-i18n'
import en from '@/i18n/locales/en'
import zh from '@/i18n/locales/zh'
import { mergeMessagesWithFallback } from '@/i18n/messages'

const fetchSkillsMock = vi.hoisted(() => vi.fn())
const fetchSkillBundlesMock = vi.hoisted(() => vi.fn())
const deleteSkillBundleApiMock = vi.hoisted(() => vi.fn())
const dialogWarningMock = vi.hoisted(() => vi.fn())
const extractRepresentativeVideoFramesMock = vi.hoisted(() => vi.fn())


vi.mock('naive-ui', () => ({
  NButton: { template: '<button type="button" v-bind="$attrs"><slot /><slot name="icon" /></button>' },
  NTooltip: { props: ['disabled', 'trigger'], template: '<div class="n-tooltip-stub" :data-disabled="String(!!disabled)"><slot name="trigger" /><div class="n-tooltip-content"><slot /></div></div>' },
  NSwitch: { template: '<button type="button"></button>' },
  NDropdown: { template: '<div><slot /></div>' },
  NModal: { template: '<div><slot /><slot name="footer" /></div>' },
  NInputNumber: { template: '<input />' },
  NPopover: {
    name: 'NPopover',
    emits: ['update:show'],
    template: '<div class="n-popover-stub"><slot name="trigger" /><slot /></div>',
  },
  NSlider: {
    props: ['value', 'min', 'max', 'step'],
    emits: ['update:value'],
    template: `
      <input
        class="n-slider-stub"
        type="range"
        :value="value"
        :min="min"
        :max="max"
        :step="step"
        @input="$emit('update:value', Number($event.target.value))"
      />
    `,
  },
  useMessage: () => ({ error: vi.fn(), success: vi.fn() }),
  useDialog: () => ({ warning: dialogWarningMock }),
}))

vi.mock('@/api/studio/sessions', () => ({
  fetchContextLength: vi.fn().mockResolvedValue(256000),
  setSessionReasoningEffort: vi.fn().mockResolvedValue(true),
}))

const fetchCcEffortMock = vi.hoisted(() => vi.fn(async () => ({ level: 'xhigh', levels: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] })))
vi.mock('@/api/hermes/cc-api', () => ({
  fetchCcEffort: fetchCcEffortMock,
}))

vi.mock('@/api/hermes/model-context', () => ({
  setModelContext: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/api/hermes/skills', () => ({
  fetchSkills: fetchSkillsMock,
}))

vi.mock('@/api/hermes/skill-bundles', () => ({
  fetchSkillBundles: fetchSkillBundlesMock,
  deleteSkillBundleApi: deleteSkillBundleApiMock,
}))

vi.mock('@/components/hermes/chat/BundleCreateModal.vue', () => ({
  default: {
    name: 'BundleCreateModal',
    props: ['profile'],
    emits: ['close', 'created'],
    template: '<div class="bundle-create-modal">{{ profile }}</div>',
  },
}))

vi.mock('@/composables/useToolTraceVisibility', () => ({
  useToolTraceVisibility: () => ({ toolTraceVisible: { value: true }, toggleToolTraceVisible: vi.fn() }),
}))

vi.mock('@/utils/video-frame-extraction', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/utils/video-frame-extraction')>()
  return {
    ...original,
    extractRepresentativeVideoFrames: extractRepresentativeVideoFramesMock,
  }
})

function mountZh(sessionOverrides: Record<string, any> = {}) {
  const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
  const chatStore = useChatStore()
  const settingsStore = useSettingsStore()
  chatStore.sessions = [
    { id: 's1', title: 's1', source: 'cli', messages: [], createdAt: Date.now(), updatedAt: Date.now(), ...sessionOverrides } as any,
  ]
  chatStore.activeSessionId = 's1'
  chatStore.activeSession = chatStore.sessions[0]
  settingsStore.display = {} as any
  const i18n = createI18n({ legacy: false, locale: 'zh', fallbackLocale: 'en', messages: { en, zh: mergeMessagesWithFallback(en, zh) } })
  return { wrapper: mount(ChatInput, { global: { plugins: [pinia, i18n] } }), chatStore }
}

function effortTooltip(wrapper: any) {
  return wrapper.findAll('.n-tooltip-stub').find((node: any) => node.find('.reasoning-effort-button').exists())
}

describe('hermes-v050:U5/T15/T17 ChatInput reasoning-effort tooltip and send button labels', () => {
  beforeEach(() => {
    localStorage.clear()
    window.innerWidth = 1024
    fetchSkillsMock.mockReset()
    fetchSkillsMock.mockResolvedValue({ categories: [], archived: [] })
    fetchSkillBundlesMock.mockReset()
    fetchSkillBundlesMock.mockResolvedValue([])
  })

  it('disables the hover tooltip while the effort popover is open and re-enables it after closing (U5)', async () => {
    const { wrapper } = mountZh()
    await flushPromises()
    const tooltip = effortTooltip(wrapper)
    expect(tooltip).toBeTruthy()
    expect(tooltip.attributes('data-disabled')).toBe('false')

    const popover = wrapper.findAllComponents({ name: 'NPopover' }).find((node: any) => node.find('.reasoning-effort-button').exists())
    popover!.vm.$emit('update:show', true)
    await nextTick()
    expect(effortTooltip(wrapper).attributes('data-disabled')).toBe('true')

    popover!.vm.$emit('update:show', false)
    await nextTick()
    expect(effortTooltip(wrapper).attributes('data-disabled')).toBe('false')
  })

  it('uses a full-width colon in the Chinese tooltip (T15)', async () => {
    const { wrapper } = mountZh()
    await flushPromises()
    const text = effortTooltip(wrapper).find('.n-tooltip-content').text()
    expect(text.startsWith('推理强度：')).toBe(true)
    expect(text).not.toContain('推理强度:')
  })

  it('hermes-v050:E-06 gives the effort button the same accessible name as its tooltip (full-width colon)', async () => {
    const { wrapper } = mountZh()
    await flushPromises()
    const tooltip = effortTooltip(wrapper)
    const label = tooltip.find('.reasoning-effort-button').attributes('aria-label')
    expect(label).toBe(tooltip.find('.n-tooltip-content').text())
    expect(label!.startsWith('推理强度：')).toBe(true)
    expect(label).not.toContain('推理强度:')
  })

  it('labels the send button in the UI language for screen readers (T17)', async () => {
    const { wrapper } = mountZh()
    await flushPromises()
    expect(wrapper.get('.send-button').attributes('aria-label')).toBe('发送')
  })
})
