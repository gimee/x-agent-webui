// @vitest-environment jsdom
// hermes-v050:C12 保存滚动锚点：从视口附近二分定位、命中第一个可见行即停，不再对每一行 getBoundingClientRect。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import VirtualMessageList from '@/components/hermes/chat/VirtualMessageList.vue'

const ROW_HEIGHT = 100
const VIEWPORT = { top: 50, height: 600 }

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, height, left: 0, right: 800, width: 800, x: 0, y: top, toJSON() {} } as DOMRect
}

async function mountList(count: number) {
  const messages = Array.from({ length: count }, (_, index) => ({ id: `m${index}` }))
  const wrapper = mount(VirtualMessageList, {
    props: { messages, virtualized: false },
    slots: { item: '<div class="row-body">row</div>' },
    attachTo: document.body,
  })
  for (let i = 0; i < 4; i += 1) await nextTick()
  const scroller = wrapper.find('.virtual-message-list').element as HTMLElement
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => VIEWPORT.height })
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => count * ROW_HEIGHT })
  scroller.getBoundingClientRect = () => rect(VIEWPORT.top, VIEWPORT.height)
  const reads = { count: 0 }
  const rows = [...scroller.querySelectorAll<HTMLElement>('.virtual-row')]
  const place = (scrollTop: number) => {
    scroller.scrollTop = scrollTop
    rows.forEach((row, index) => {
      row.getBoundingClientRect = () => {
        reads.count += 1
        if (row.hasAttribute('data-virtual-inactive')) return rect(0, 0)
        return rect(VIEWPORT.top + index * ROW_HEIGHT - scrollTop, ROW_HEIGHT)
      }
    })
  }
  return { wrapper, rows, reads, place }
}

describe('VirtualMessageList viewport anchor lookup (C12)', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
  })

  it('finds the first visible row with a handful of layout reads instead of one per row', async () => {
    const { wrapper, reads, place } = await mountList(400)
    place(10_030)
    const snapshot = (wrapper.vm as any).captureViewportPosition()
    // 第 100 行顶部在视口顶上方 30px，是第一条可见行
    expect(snapshot).toMatchObject({ anchorMessageId: 'm100', anchorOffset: -30 })
    expect(reads.count).toBeLessThanOrEqual(16)
    wrapper.unmount()
  })

  it('matches the old full scan at the edges of the list', async () => {
    const { wrapper, place } = await mountList(50)
    place(0)
    expect((wrapper.vm as any).captureViewportPosition()).toMatchObject({ anchorMessageId: 'm0', anchorOffset: 0 })
    place(50 * ROW_HEIGHT - VIEWPORT.height)
    expect((wrapper.vm as any).captureViewportPosition()).toMatchObject({ anchorMessageId: 'm44', anchorOffset: 0 })
    wrapper.unmount()
  })

  it('skips recycled views the virtual scroller has parked (display:none, zero rect)', async () => {
    const { wrapper, rows, place } = await mountList(60)
    for (const row of rows.slice(40)) row.setAttribute('data-virtual-inactive', '')
    place(1_250)
    expect((wrapper.vm as any).captureViewportPosition()).toMatchObject({ anchorMessageId: 'm12', anchorOffset: -50 })
    wrapper.unmount()
  })
})
