// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import SessionListTabs from '@/components/hermes/chat/SessionListTabs.vue'
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

describe('session list tabs', () => {
  it('defaults to all, emits a filter change and reflects the controlled value', async () => {
    const wrapper = mount(SessionListTabs)
    const tabs = wrapper.findAll('[role="tab"]')
    expect(tabs).toHaveLength(2)
    expect(tabs[0].attributes('aria-selected')).toBe('true')
    expect(tabs[1].attributes('aria-selected')).toBe('false')
    await tabs[1].trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['starred'])
    await wrapper.setProps({ modelValue: 'starred' })
    expect(tabs[1].attributes('aria-selected')).toBe('true')
    wrapper.unmount()
  })
})
