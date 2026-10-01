// @vitest-environment jsdom
// hermes-v050:E-09 历史页上翻补页时锚点跳几百像素。原来 HistoryMessageList 在请求发出时记下 scrollTop /
// scrollHeight，补页后按 scrollHeight 差值写回一次：
// - 虚拟列表里新补进来的行先按估计高度（180px）排，量出真实高度后内容整体又挪一次；
// - 请求期间用户继续滚动的距离被那次写回覆盖。
// 这里守住：补页后，补页前视口里的第一条行回到它补页前一刻的视口位置（含请求期间的滚动），
// 新行量出真实高度后仍在原位；之后用户自己的滚动不被抵消。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, nextTick } from 'vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

// 与 virtual-message-list-scroll.test.ts 相同的 DynamicScroller 桩：按文档流排出全部行
vi.mock('vue-virtual-scroller', () => ({
  DynamicScroller: defineComponent({
    name: 'DynamicScroller',
    props: { items: { type: Array, default: () => [] } },
    emits: ['scroll', 'resize', 'visible'],
    setup(_props, { expose }) {
      expose({ scrollToBottom: () => {}, scrollToPosition: () => {}, scrollToItem: () => {} })
    },
    template: `
      <div class="virtual-message-list" @scroll="$emit('scroll')">
        <slot name="before" />
        <slot v-for="(item, index) in items" :item="item" :index="index" :active="true" />
        <slot name="after" />
      </div>
    `,
  }),
  DynamicScrollerItem: defineComponent({
    name: 'DynamicScrollerItem',
    props: { item: { type: Object, required: true }, index: { type: Number, required: true }, active: { type: Boolean, default: true } },
    template: '<div class="virtual-row"><slot /></div>',
  }),
}))

vi.mock('@/components/hermes/chat/ToolRunCard.vue', () => ({
  default: defineComponent({
    name: 'ToolRunCard',
    props: { runId: { type: String, required: true }, tools: { type: Array, default: () => [] } },
    template: '<div class="tool-run-card-stub">{{ runId }}:{{ tools.length }}</div>',
  }),
}))

vi.mock('@/components/hermes/chat/MessageItem.vue', () => ({
  default: defineComponent({
    name: 'MessageItem',
    props: { message: { type: Object, required: true } },
    template: '<div class="message-item-stub">{{ message.content }}</div>',
  }),
}))

import HistoryMessageList from '@/components/hermes/chat/HistoryMessageList.vue'
import VirtualMessageList from '@/components/hermes/chat/VirtualMessageList.vue'
import type { Message, Session } from '@/stores/hermes/chat'

const message = (n: number): Message => ({ id: `m${n}`, role: 'user', content: `m${n}`, timestamp: n })
const VIEWPORT = 600
// 行高：已量过的行 100px；新补进来的行在“量出真实高度”之前按虚拟列表的估计高度 180px 排
const heights = new Map<string, number>()
const rowHeight = (id: string) => heights.get(id) ?? 100

let raf: Array<FrameRequestCallback | null> = []
function frames(count: number) {
  for (let i = 0; i < count; i += 1) {
    const queue = raf
    raf = []
    for (const callback of queue) callback?.(performance.now())
  }
}

async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await flushPromises()
    await nextTick()
  }
}

// jsdom 不做布局：行按文档顺序依次排，视口坐标 = 内容坐标 - scrollTop
function installGeometry() {
  const original = HTMLElement.prototype.getBoundingClientRect
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: function (this: HTMLElement) {
      const rect = (top: number, height: number) => ({ x: 0, y: top, top, left: 0, right: 400, width: 400, height, bottom: top + height, toJSON() {} }) as DOMRect
      if (this.classList.contains('virtual-message-list')) return rect(0, VIEWPORT)
      if (this.classList.contains('virtual-row')) {
        const scroller = this.closest('.virtual-message-list') as HTMLElement
        let top = 0
        for (const row of scroller.querySelectorAll<HTMLElement>('.virtual-row')) {
          if (row === this) break
          top += rowHeight(row.dataset.messageId || '')
        }
        return rect(top - scroller.scrollTop, rowHeight(this.dataset.messageId || ''))
      }
      return original.call(this)
    },
  })
  return () => Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: original })
}

function scrollerMetrics(el: HTMLElement) {
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => VIEWPORT })
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => [...el.querySelectorAll<HTMLElement>('.virtual-row')].reduce((sum, row) => sum + rowHeight(row.dataset.messageId || ''), 0),
  })
}

function viewportTop(wrapper: ReturnType<typeof mount>, id: string) {
  const row = wrapper.find(`.virtual-row[data-message-id="${id}"]`).element as HTMLElement
  return Math.round(row.getBoundingClientRect().top)
}

describe('hermes-v050:E-09 history prepend keeps the viewport anchor', () => {
  let restoreGeometry: () => void

  beforeEach(() => {
    setActivePinia(createPinia())
    heights.clear()
    raf = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => raf.push(callback))
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { raf[id - 1] = null })
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    restoreGeometry = installGeometry()
  })

  afterEach(() => {
    restoreGeometry()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('puts the first visible row back where it was right before the prepend, also after the new rows are measured', async () => {
    const newest = Array.from({ length: 10 }, (_, index) => message(20 + index))
    const older = [message(17), message(18), message(19)]
    let el!: HTMLElement
    let wrapper!: ReturnType<typeof mount>
    const session: Session = { id: 'history-1', title: 'h', createdAt: 1, updatedAt: 1, messages: newest, hasMoreBefore: true }
    const loadOlder = vi.fn(async () => {
      // 请求期间：用户又往上滚了 30px，上面一行也量出了新高度（100 → 120），m21 的位置跟着变了
      el.scrollTop = 130
      heights.set('m20', 120)
      for (const row of older) heights.set(String(row.id), 180)
      await wrapper.setProps({ session: { ...session, messages: [...older, ...newest] } })
      return true
    })
    wrapper = mount(HistoryMessageList, { props: { session, loadOlder }, attachTo: document.body })
    el = wrapper.find('.virtual-message-list').element as HTMLElement
    scrollerMetrics(el)
    await settle()
    frames(12) // 首次打开时的贴底滚动跑完

    // 用户滚到接近顶部：视口里第一条是 m21（露出上半截之外的部分），触发补页
    el.scrollTop = 160
    expect(viewportTop(wrapper, 'm21')).toBe(-60)
    wrapper.getComponent(VirtualMessageList).vm.$emit('topReach')
    await settle()
    frames(1)

    expect(loadOlder).toHaveBeenCalledWith('history-1')
    expect(wrapper.findAll('.message-item-stub').map(node => node.text())).toEqual(['m17', 'm18', 'm19', ...newest.map(row => row.content)])
    // 补页前一刻 m21 在 -10：请求期间的滚动和布局变化都算数，不回到请求发出时的 -60 / -30
    expect(viewportTop(wrapper, 'm21')).toBe(-10)

    // 新行量出真实高度（180 → 100），内容整体上移 240px；锚点仍在原位
    for (const row of older) heights.set(String(row.id), 100)
    frames(2)
    expect(viewportTop(wrapper, 'm21')).toBe(-10)
    expect(el.scrollTop).toBe(430)

    // 之后用户用滚轮往上滚 50px：不被抵消
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -50 }))
    el.scrollTop -= 50
    frames(12)
    expect(viewportTop(wrapper, 'm21')).toBe(40)
    wrapper.unmount()
  })

  it('does not anchor on a tool-run card that absorbs older tools of the same run (the view would stick at the top)', async () => {
    // 同一轮工具跨两页：卡片挪到这一轮最早那个工具的位置，老页里的其它内容排在卡片之后、m20 之前
    const tool = (n: number): Message => ({ id: `t${n}`, role: 'tool', content: '', toolName: 'bash', toolStatus: 'done', runMarker: 'r1', timestamp: n })
    const newest = [tool(15), ...Array.from({ length: 10 }, (_, index) => message(20 + index))]
    const older = [tool(9), message(10), message(11)]
    heights.set('tool-run:r1', 46)
    let el!: HTMLElement
    let wrapper!: ReturnType<typeof mount>
    const session: Session = { id: 'history-2', title: 'h', createdAt: 1, updatedAt: 1, messages: newest, hasMoreBefore: true }
    const loadOlder = vi.fn(async () => {
      await wrapper.setProps({ session: { ...session, messages: [...older, ...newest] } })
      return true
    })
    wrapper = mount(HistoryMessageList, { props: { session, loadOlder }, attachTo: document.body })
    el = wrapper.find('.virtual-message-list').element as HTMLElement
    scrollerMetrics(el)
    await settle()
    frames(12)

    // 用户在最顶上：卡片在 0，m20 在 46
    el.scrollTop = 0
    expect(viewportTop(wrapper, 'tool-run:r1')).toBe(0)
    expect(viewportTop(wrapper, 'm20')).toBe(46)
    wrapper.getComponent(VirtualMessageList).vm.$emit('topReach')
    await settle()
    frames(3)

    expect(wrapper.findAll('.virtual-row').map(row => (row.element as HTMLElement).dataset.messageId)).toEqual(['tool-run:r1', 'm10', 'm11', ...newest.slice(1).map(row => String(row.id))])
    expect(wrapper.find('.tool-run-card-stub').text()).toBe('r1:2')
    // 用户看的那条消息留在原位，上面多出的两条可以继续往上滚到（scrollTop 不再停在 0）
    expect(viewportTop(wrapper, 'm20')).toBe(46)
    expect(el.scrollTop).toBe(200)
    wrapper.unmount()
  })
})
