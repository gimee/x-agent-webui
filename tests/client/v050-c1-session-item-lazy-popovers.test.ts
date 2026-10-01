// @vitest-environment jsdom
// hermes-v050:C1 SessionListItem 弹层按需挂载：未悬停/聚焦的行不创建 NTooltip / NPopconfirm。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { h, nextTick } from 'vue'

const popoverMounts = vi.hoisted(() => ({ tooltip: 0, popconfirm: 0 }))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => ({ profileModelGroups: [] }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', async () => {
  const { defineComponent: define, onMounted } = await import('vue')
  return {
    NTooltip: define({
      name: 'NTooltip',
      setup(_props, { slots }) {
        onMounted(() => { popoverMounts.tooltip += 1 })
        return () => [slots.trigger?.(), slots.default?.()]
      },
    }),
    NPopconfirm: define({
      name: 'NPopconfirm',
      props: { defaultShow: Boolean },
      emits: ['positive-click'],
      setup(props, { slots, emit }) {
        onMounted(() => { popoverMounts.popconfirm += 1 })
        return () => [
          slots.trigger?.(),
          props.defaultShow
            ? h('div', { class: 'popconfirm-panel-stub' }, [
                slots.default?.(),
                h('button', { class: 'popconfirm-positive-stub', onClick: () => emit('positive-click') }, 'ok'),
              ])
            : null,
        ]
      },
    }),
  }
})

import SessionListItem from '@/components/hermes/chat/SessionListItem.vue'

const session = {
  id: 's1',
  title: 'Session One',
  createdAt: Date.now(),
  profile: 'default',
}

async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

describe('SessionListItem lazy popovers (C1)', () => {
  beforeEach(() => {
    popoverMounts.tooltip = 0
    popoverMounts.popconfirm = 0
    document.body.innerHTML = ''
  })

  it('renders the star and delete triggers without mounting naive popovers', async () => {
    const wrapper = mount(SessionListItem, {
      props: { session, active: false, canDelete: true, to: '/s1' },
      attachTo: document.body,
    })
    await settle()
    expect(wrapper.find('.session-item-star').exists()).toBe(true)
    expect(wrapper.find('.session-item-delete').exists()).toBe(true)
    expect(popoverMounts.tooltip).toBe(0)
    expect(popoverMounts.popconfirm).toBe(0)
    // 未挂载时提示文案不进 DOM
    expect(wrapper.text()).not.toContain('chat.deleteSession')
    wrapper.unmount()
  })

  it('mounts the original tooltip and popconfirm once a mouse pointer enters the row', async () => {
    const wrapper = mount(SessionListItem, {
      props: { session, active: false, canDelete: true, to: '/s1' },
      attachTo: document.body,
    })
    await wrapper.get('a.session-item').trigger('pointerenter')
    await settle()
    expect(popoverMounts.tooltip).toBe(1)
    expect(popoverMounts.popconfirm).toBe(1)
    expect(wrapper.text()).toContain('chat.starSession')
    // 悬停预挂载时不自动打开删除确认
    expect(wrapper.find('.popconfirm-panel-stub').exists()).toBe(false)
    wrapper.unmount()
  })

  it('opens the same NPopconfirm directly when delete is clicked on an unarmed row', async () => {
    const wrapper = mount(SessionListItem, {
      props: { session, active: false, canDelete: true, to: '/s1' },
      attachTo: document.body,
    })
    await wrapper.get('.session-item-delete').trigger('click')
    await settle()
    expect(wrapper.emitted('select')).toBeUndefined()
    expect(wrapper.emitted('delete')).toBeUndefined()
    expect(wrapper.get('.popconfirm-panel-stub').text()).toContain('chat.deleteSession')
    await wrapper.get('.popconfirm-positive-stub').trigger('click')
    expect(wrapper.emitted('delete')).toHaveLength(1)
    wrapper.unmount()
  })

  it('does not pre-mount on touch pointers so a tap never swaps the trigger mid-gesture', async () => {
    const wrapper = mount(SessionListItem, {
      props: { session, active: false, canDelete: true, to: '/s1' },
      attachTo: document.body,
    })
    const row = wrapper.get('a.session-item').element
    const touchDown = new Event('pointerdown', { bubbles: true })
    Object.defineProperty(touchDown, 'pointerType', { value: 'touch' })
    const touchEnter = new Event('pointerenter')
    Object.defineProperty(touchEnter, 'pointerType', { value: 'touch' })
    row.dispatchEvent(touchDown)
    row.dispatchEvent(touchEnter)
    ;(row as HTMLElement).focus()
    await settle()
    expect(popoverMounts.tooltip).toBe(0)
    expect(popoverMounts.popconfirm).toBe(0)
    wrapper.unmount()
  })

  it('does not mount the delete confirmation when the row cannot be deleted', async () => {
    const wrapper = mount(SessionListItem, {
      props: { session, active: true, canDelete: false, to: '/s1' },
      attachTo: document.body,
    })
    await wrapper.get('a.session-item').trigger('pointerenter')
    await settle()
    expect(wrapper.find('.session-item-delete').exists()).toBe(false)
    expect(popoverMounts.popconfirm).toBe(0)
    expect(popoverMounts.tooltip).toBe(1)
    wrapper.unmount()
  })
})
