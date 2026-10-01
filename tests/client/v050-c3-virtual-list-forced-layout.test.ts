// @vitest-environment jsdom
// hermes-v050:C3 流式时消息数组每帧都换新引用但 id 不变：不能每次都在 DOM 更新后立刻读 scrollTop/clientHeight（强制布局）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import VirtualMessageList from '@/components/hermes/chat/VirtualMessageList.vue'

function instrumentLayoutReads(el: HTMLElement) {
  const reads = { count: 0 }
  for (const key of ['clientHeight', 'scrollHeight'] as const) {
    Object.defineProperty(el, key, {
      configurable: true,
      get() {
        reads.count += 1
        return key === 'clientHeight' ? 400 : 1000
      },
    })
  }
  return reads
}

async function flush() {
  for (let i = 0; i < 4; i += 1) await nextTick()
}

describe('VirtualMessageList avoids per-delta forced layout (C3)', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
  })

  it('does not read layout when only message contents change', async () => {
    const wrapper = mount(VirtualMessageList, {
      props: { messages: [{ id: 'm1', content: 'a' }, { id: 'm2', content: 'b' }], virtualized: false },
      slots: { item: '<div>row</div>' },
    })
    await flush()
    const reads = instrumentLayoutReads(wrapper.find('.virtual-message-list').element as HTMLElement)

    for (let i = 0; i < 5; i += 1) {
      await wrapper.setProps({ messages: [{ id: 'm1', content: 'a' }, { id: 'm2', content: `b${'x'.repeat(i)}` }] })
      await flush()
    }
    expect(reads.count).toBe(0)
    wrapper.unmount()
  })

  it('still resyncs the viewport when the set of messages changes', async () => {
    const wrapper = mount(VirtualMessageList, {
      props: { messages: [{ id: 'm1' }], virtualized: false },
      slots: { item: '<div>row</div>' },
    })
    await flush()
    const reads = instrumentLayoutReads(wrapper.find('.virtual-message-list').element as HTMLElement)
    await wrapper.setProps({ messages: [{ id: 'm1' }, { id: 'm2' }] })
    await flush()
    expect(reads.count).toBeGreaterThan(0)
    wrapper.unmount()
  })
})
