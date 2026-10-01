// @vitest-environment jsdom
// Guard test for the provider:model composer label. The source tree is frozen, edit here.
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import ChatInput from '@/components/hermes/chat/ChatInput.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NButton: { template: '<button type="button" v-bind="$attrs"><slot /><slot name="icon" /></button>' },
  NTooltip: { template: '<div><slot name="trigger" /><slot /></div>' },
  NDropdown: { template: '<div><slot /></div>' },
  NModal: { template: '<div><slot /><slot name="footer" /></div>' },
  NInputNumber: { template: '<input />' },
  NPopover: { template: '<div><slot name="trigger" /><slot /></div>' },
  NSlider: { template: '<input type="range" />' },
  useMessage: () => ({ error: vi.fn(), success: vi.fn() }),
  useDialog: () => ({ warning: vi.fn() }),
}))

vi.mock('@/api/hermes/sessions', () => ({
  fetchContextLength: vi.fn().mockResolvedValue(256000),
}))
vi.mock('@/api/hermes/model-context', () => ({
  setModelContext: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/api/hermes/skills', () => ({
  fetchSkills: vi.fn().mockResolvedValue({ categories: [], archived: [] }),
}))
vi.mock('@/api/hermes/skill-bundles', () => ({
  fetchSkillBundles: vi.fn().mockResolvedValue([]),
  deleteSkillBundleApi: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/components/hermes/chat/BundleCreateModal.vue', () => ({
  default: { template: '<div />' },
}))
vi.mock('@/composables/useToolTraceVisibility', () => ({
  useToolTraceVisibility: () => ({ toolTraceVisible: { value: true }, toggleToolTraceVisible: vi.fn() }),
}))

describe('chat composer provider:model label', () => {
  function mountComposer(modelLabel: string) {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    return mount(ChatInput, { props: { modelLabel }, global: { plugins: [pinia] } })
  }

  it('keeps the complete raw provider:model value, including model ids with slashes', () => {
    const wrapper = mountComposer('fixture-proxy:openai/fixture-model')

    expect(wrapper.get('.input-model-label').text()).toBe('fixture-proxy:openai/fixture-model')
    expect(wrapper.get('.input-model-button').attributes('aria-label')).toBe('fixture-proxy:openai/fixture-model')
  })

  it('renders the label verbatim so the prefix is never stripped twice', () => {
    // Stripping lives in ChatPanel.  If it ever leaks in here too, a provider
    // genuinely named custom:custom:x would lose both halves.
    const wrapper = mountComposer('custom:kept-as-is:fixture-model')

    expect(wrapper.get('.input-model-label').text()).toBe('custom:kept-as-is:fixture-model')
  })
})
