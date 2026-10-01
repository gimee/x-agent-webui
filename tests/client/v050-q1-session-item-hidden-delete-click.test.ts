// @vitest-environment jsdom
// hermes-v050:Q-1 真 Chrome 复现：侧栏刚滚到光标下的行还没刷新悬停状态时按下，删除按钮仍是
// pointer-events:none（只在 :hover 下开放），按下落在行本身，点击打开了会话而不是删除确认。
// 这里验证：点击坐标落在删除按钮框内、但事件目标是行本身时，按删除处理（打开确认，不选中会话）；
// 键盘回车、带修饰键、落在按钮框外的点击仍照常打开会话。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { h, nextTick } from 'vue'

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => ({ profileModelGroups: [] }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', async () => {
  const { defineComponent: define, ref } = await import('vue')
  return {
    NTooltip: define({
      name: 'NTooltip',
      setup(_props, { slots }) {
        return () => [slots.trigger?.(), slots.default?.()]
      },
    }),
    NPopconfirm: define({
      name: 'NPopconfirm',
      props: { defaultShow: Boolean },
      emits: ['positive-click'],
      setup(props, { slots, expose }) {
        const shown = ref(props.defaultShow)
        expose({ setShow: (value: boolean) => { shown.value = value } })
        return () => [
          slots.trigger?.(),
          shown.value ? h('div', { class: 'popconfirm-panel-stub' }, slots.default?.()) : null,
        ]
      },
    }),
  }
})

import SessionListItem from '@/components/hermes/chat/SessionListItem.vue'

const session = { id: 's1', title: 'Session One', createdAt: Date.now(), profile: 'default' }
const DELETE_BOX = { left: 200, top: 100, width: 16, height: 16 }

async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

function mountRow() {
  const wrapper = mount(SessionListItem, {
    props: { session: session as any, active: false, canDelete: true, to: '#/hermes/session/s1' },
    attachTo: document.body,
  })
  return wrapper
}

function stubDeleteBox(wrapper: ReturnType<typeof mountRow>) {
  const button = wrapper.get('.session-item-delete').element as HTMLElement
  button.getBoundingClientRect = () => ({
    ...DELETE_BOX,
    x: DELETE_BOX.left,
    y: DELETE_BOX.top,
    right: DELETE_BOX.left + DELETE_BOX.width,
    bottom: DELETE_BOX.top + DELETE_BOX.height,
    toJSON: () => ({}),
  }) as DOMRect
}

// 与 Chrome 里复现到的一样：目标是行 <a> 本身，坐标在删除按钮框内，detail=1（真实鼠标点击）
function clickRowAt(wrapper: ReturnType<typeof mountRow>, x: number, y: number, init: MouseEventInit = {}) {
  const row = wrapper.get('a.session-item').element
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y, detail: 1, button: 0, ...init })
  row.dispatchEvent(event)
  return event
}

describe('clicks that land on the hidden delete button of a freshly mounted row (Q-1)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('opens the delete confirmation instead of selecting the session (unarmed row)', async () => {
    const wrapper = mountRow()
    await settle()
    stubDeleteBox(wrapper)
    const event = clickRowAt(wrapper, 208, 108)
    await settle()
    expect(wrapper.emitted('select')).toBeUndefined()
    expect(event.defaultPrevented).toBe(true)
    expect(wrapper.find('.popconfirm-panel-stub').exists()).toBe(true)
    expect(wrapper.emitted('delete')).toBeUndefined()
    wrapper.unmount()
  })

  it('also opens the confirmation when the row was already armed by hover', async () => {
    const wrapper = mountRow()
    await wrapper.get('a.session-item').trigger('pointerenter')
    await settle()
    stubDeleteBox(wrapper)
    clickRowAt(wrapper, 201, 115)
    await settle()
    expect(wrapper.emitted('select')).toBeUndefined()
    expect(wrapper.find('.popconfirm-panel-stub').exists()).toBe(true)
    wrapper.unmount()
  })

  it('still opens the session for clicks outside the button, keyboard activation and modified clicks', async () => {
    const wrapper = mountRow()
    await settle()
    stubDeleteBox(wrapper)
    clickRowAt(wrapper, 120, 108)
    clickRowAt(wrapper, 208, 108, { detail: 0 })
    await settle()
    expect(wrapper.emitted('select')).toHaveLength(2)
    expect(wrapper.find('.popconfirm-panel-stub').exists()).toBe(false)
    const modified = clickRowAt(wrapper, 208, 108, { ctrlKey: true })
    await settle()
    expect(wrapper.find('.popconfirm-panel-stub').exists()).toBe(false)
    expect(modified.defaultPrevented).toBe(false)
    wrapper.unmount()
  })
})
