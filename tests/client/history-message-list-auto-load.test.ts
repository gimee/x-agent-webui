// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, reactive } from 'vue'

const nearBottom = vi.hoisted(() => ({ value: false }))
const lists = vi.hoisted(() => [] as Array<{ arm: ReturnType<typeof vi.fn>; disarm: ReturnType<typeof vi.fn>; bottom: ReturnType<typeof vi.fn> }>)
vi.mock('@/stores/hermes/chat', () => ({ useChatStore: () => ({ focusMessageId: null }) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/components/hermes/chat/VirtualMessageList.vue', () => ({
  default: defineComponent({
    name: 'VirtualMessageList',
    props: ['messages'],
    emits: ['scroll', 'top-reach'],
    setup(_props, { expose }) {
      const list = { arm: vi.fn(), disarm: vi.fn(), bottom: vi.fn() }
      lists.push(list)
      expose({ armPrependAnchor: list.arm, disarmPrependAnchor: list.disarm,
        scrollToBottom: list.bottom, isNearBottom: () => nearBottom.value,
        captureViewportPosition: () => null, scrollToMessage: vi.fn() })
    },
    template: '<div><slot name="before" /></div>',
  }),
}))
vi.mock('@/components/hermes/chat/MessageItem.vue', () => ({ default: defineComponent({ template: '<div />' }) }))
vi.mock('@/components/hermes/chat/ToolRunCard.vue', () => ({ default: defineComponent({ template: '<div />' }) }))

import HistoryMessageList from '@/components/hermes/chat/HistoryMessageList.vue'
import type { Session } from '@/stores/hermes/chat'

function session(profile = 'default'): Session {
  return reactive({ id: 'history-auto', profile, title: 'Synthetic history', createdAt: 1, updatedAt: 1,
    messages: [{ id: '3', role: 'user', content: 'Newest', timestamp: 3 }],
    loadedMessageCount: 1, hasMoreBefore: true })
}
const wrappers: ReturnType<typeof mount>[] = []
function render(target: Session, loadOlder: (id: string) => Promise<boolean>) {
  const wrapper = mount(HistoryMessageList, { props: { session: target, loadOlder } })
  wrappers.push(wrapper)
  return wrapper
}
async function advance(ms = 1000) {
  await vi.advanceTimersByTimeAsync(ms)
  await flushPromises()
}

describe('history background pagination', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.useFakeTimers(); lists.length = 0; nearBottom.value = false })
  afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.useRealTimers() })

  it('loads all older pages serially without any scroll event', async () => {
    const target = session()
    const offsets: number[] = []
    const loadOlder = vi.fn(async () => {
      offsets.push(target.loadedMessageCount!)
      const id = String(3 - target.loadedMessageCount!)
      target.messages = [{ id, role: 'user', content: `Older ${id}`, timestamp: Number(id) }, ...target.messages]
      target.loadedMessageCount! += 1
      target.hasMoreBefore = target.loadedMessageCount! < 3
      return true
    })
    render(target, loadOlder)
    await flushPromises()
    expect(loadOlder).not.toHaveBeenCalled() // first paint is not blocked by older pages
    await advance(4000)
    expect(offsets).toEqual([1, 2])
    expect(target.messages.map(message => message.id)).toEqual(['1', '2', '3'])
    expect(lists[0].arm).toHaveBeenCalledTimes(2)
    expect(lists[0].disarm).toHaveBeenCalledTimes(2)
    await advance(4000)
    expect(loadOlder).toHaveBeenCalledTimes(2)
  })

  it('does not replace the prepend anchor with a near-bottom jump', async () => {
    const target = session()
    nearBottom.value = true
    const loadOlder = vi.fn(async () => {
      target.messages = [{ id: '2', role: 'user', content: 'Older', timestamp: 2 }, ...target.messages]
      target.loadedMessageCount = 2
      target.hasMoreBefore = false
      return true
    })
    render(target, loadOlder)
    await flushPromises()
    lists[0].bottom.mockClear()
    await advance(4000)
    expect(lists[0].arm).toHaveBeenCalledTimes(1)
    expect(lists[0].bottom).not.toHaveBeenCalled()
  })

  it('cancels a scheduled page when unmounted', async () => {
    const loadOlder = vi.fn(async () => false)
    const wrapper = render(session(), loadOlder)
    await flushPromises()
    wrapper.unmount()
    await advance(4000)
    expect(loadOlder).not.toHaveBeenCalled()
  })

  it('stops on failure and resumes only on explicit retry', async () => {
    const target = session()
    const loadOlder = vi.fn().mockResolvedValueOnce(false).mockImplementationOnce(async () => {
      target.hasMoreBefore = false
      return false
    })
    const wrapper = render(target, loadOlder)
    await advance(4000)
    expect(loadOlder).toHaveBeenCalledTimes(1)
    expect(target.hasMoreBefore).toBe(true)
    wrapper.getComponent({ name: 'VirtualMessageList' }).vm.$emit('top-reach')
    await advance(4000)
    expect(loadOlder).toHaveBeenCalledTimes(1)
    await wrapper.get('button.history-retry').trigger('click')
    await advance(4000)
    expect(loadOlder).toHaveBeenCalledTimes(2)
    expect(wrapper.find('button.history-retry').exists()).toBe(false)
  })

  it('does not overlap requests, loop on no progress, or leak an armed anchor on rejection', async () => {
    let reject!: (reason: Error) => void
    const loadOlder = vi.fn(() => new Promise<boolean>((_resolve, fail) => { reject = fail }))
    const wrapper = render(session(), loadOlder)
    await advance(1000)
    wrapper.getComponent({ name: 'VirtualMessageList' }).vm.$emit('top-reach')
    await advance(4000)
    expect(loadOlder).toHaveBeenCalledTimes(1)
    reject(new Error('synthetic failure'))
    await flushPromises()
    expect(lists[0].disarm).toHaveBeenCalledTimes(1)
    loadOlder.mockResolvedValue(true) // malformed success with no cursor progress
    await wrapper.get('button.history-retry').trigger('click')
    await advance(4000)
    expect(loadOlder).toHaveBeenCalledTimes(2)
  })

  it('isolates same-id profile switches and a late request cannot disarm the new list', async () => {
    let resolveOld!: (value: boolean) => void
    const old = session('default')
    const next = session('research')
    const loadOlder = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>(resolve => { resolveOld = resolve }))
      .mockImplementationOnce(() => new Promise<boolean>(() => {}))
    const wrapper = render(old, loadOlder)
    await advance(1000)
    await wrapper.setProps({ session: next })
    await advance(1000)
    expect(loadOlder).toHaveBeenCalledTimes(2)
    resolveOld(true)
    await advance(4000)
    expect(lists[0].disarm).toHaveBeenCalledTimes(1)
    expect(lists[1].disarm).not.toHaveBeenCalled()
    expect(loadOlder).toHaveBeenCalledTimes(2)
  })
})
