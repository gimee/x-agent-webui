// @vitest-environment jsdom
// hermes-v050:E-03 侧栏虚拟列表的行距要按小数量：Chrome 里行高 63.797px + 2px 下边距 = 65.797px，
// offsetTop 取整后相邻两行差成 66px，781 行的占位多出约 159px，越往下行越偏（真浏览器最大漂移 2.44px）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import VirtualSessionList from '@/components/hermes/chat/VirtualSessionList.vue'

// Chrome 的 LayoutUnit 是 1/64px：63.796875 + 2 = 65.796875
const PITCH = 65.796875
const COUNT = 781
const VIEWPORT = 536

function mountList() {
  const items = ref(Array.from({ length: COUNT }, (_, index) => ({ id: `s${index}` })))
  const Host = defineComponent({
    setup() {
      return () => h(VirtualSessionList, { class: 'session-items', items: items.value }, {
        default: ({ item }: { item: { id: string } }) => h('a', { class: 'session-item' }, item.id),
      })
    },
  })
  return mount(Host, { attachTo: document.body })
}

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

function spacerHeights(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('.virtual-session-list__spacer').map(node => Number.parseFloat((node.element as HTMLElement).style.height) || 0)
}

describe('hermes-v050:E-03 VirtualSessionList measures a fractional row pitch', () => {
  const saved: Array<[object, string, PropertyDescriptor | undefined]> = []
  const override = (target: object, key: string, descriptor: PropertyDescriptor) => {
    saved.push([target, key, Object.getOwnPropertyDescriptor(target, key)])
    Object.defineProperty(target, key, { configurable: true, ...descriptor })
  }

  beforeEach(() => {
    override(HTMLElement.prototype, 'clientHeight', {
      get() { return (this as HTMLElement).classList?.contains('virtual-session-list') ? VIEWPORT : 0 },
    })
    // jsdom 不做布局：行按它代表的会话序号排在 index × 65.796875 处（内容坐标，常数偏移不影响行距），
    // offsetTop 与 Chrome 一样取整
    const rowTop = (el: HTMLElement) => Number(el.dataset.index) * PITCH
    override(HTMLElement.prototype, 'offsetTop', {
      get() {
        const el = this as HTMLElement
        return el.classList?.contains('virtual-session-list__row') ? Math.round(rowTop(el)) : 0
      },
    })
    const original = HTMLElement.prototype.getBoundingClientRect
    override(HTMLElement.prototype, 'getBoundingClientRect', {
      value: function (this: HTMLElement) {
        if (!this.classList?.contains('virtual-session-list__row')) return original.call(this)
        const top = rowTop(this)
        return { x: 0, y: top, top, left: 0, right: 236, bottom: top + PITCH - 2, width: 236, height: PITCH - 2, toJSON() {} } as DOMRect
      },
    })
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  })

  afterEach(() => {
    while (saved.length) {
      const [target, key, descriptor] = saved.pop()!
      if (descriptor) Object.defineProperty(target, key, descriptor)
      else delete (target as any)[key]
    }
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('keeps the total scroll height equal to 781 real rows', async () => {
    const wrapper = mountList()
    await settle()
    const rendered = wrapper.findAll('.virtual-session-list__row').length
    const total = spacerHeights(wrapper).reduce((sum, value) => sum + value, 0) + rendered * PITCH
    expect(Math.abs(total - COUNT * PITCH)).toBeLessThan(1)
    wrapper.unmount()
  })

  it('places the rendered window where those rows sit in the full list, deep into the list', async () => {
    const wrapper = mountList()
    await settle()
    const scroller = wrapper.find('.virtual-session-list').element as HTMLElement
    for (const scrollTop of [8000, 30000, 49000]) {
      scroller.scrollTop = scrollTop
      scroller.dispatchEvent(new Event('scroll'))
      await settle()
      const first = wrapper.find('.virtual-session-list__row').element as HTMLElement
      const [before, after] = spacerHeights(wrapper)
      const start = Number(first.dataset.index)
      const end = start + wrapper.findAll('.virtual-session-list__row').length
      // 上占位 = 前面 start 行的真实高度；下占位 = 后面剩下行的真实高度（漂移 <0.5px）
      expect(Math.abs(before - start * PITCH), `before @${scrollTop}`).toBeLessThan(0.5)
      expect(Math.abs(after - (COUNT - end) * PITCH), `after @${scrollTop}`).toBeLessThan(0.5)
    }
    wrapper.unmount()
  })
})
