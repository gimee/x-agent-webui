// @vitest-environment jsdom
// hermes-v050:C1 侧栏会话列表虚拟滚动 + 弹层按需挂载的行为测试。
// hermes-v050:F-07 列表不再用 RecycleScroller（按会话 id 作 key 的切片），选择器随之改为本组件的类名。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'

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
      setup(props, { slots, emit, expose }) {
        onMounted(() => { popoverMounts.popconfirm += 1 })
        const shown = { value: props.defaultShow }
        expose({ setShow: (value: boolean) => { shown.value = value } })
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

import VirtualSessionList from '@/components/hermes/chat/VirtualSessionList.vue'
import SessionListItem from '@/components/hermes/chat/SessionListItem.vue'

const ROW = 62
const VIEWPORT = 600

function makeSessions(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `s${index}`,
    title: `Session ${index}`,
    createdAt: Date.UTC(2026, 8, 1, 12, 0) + index,
    updatedAt: Date.UTC(2026, 8, 1, 12, 0) - index,
    profile: 'default',
    source: 'cli',
    messages: [],
  }))
}

function mountList(count = 778, handlers: Record<string, (...args: any[]) => void> = {}) {
  const sessions = ref(makeSessions(count))
  const activeId = ref('s0')
  const starred = ref(new Set<string>())
  const Host = defineComponent({
    setup() {
      return () => h(VirtualSessionList, { class: 'session-items', items: sessions.value }, {
        empty: () => h('div', { class: 'session-empty' }, 'empty'),
        default: ({ item: s }: { item: any }) => h(SessionListItem, {
          key: s.id,
          session: s,
          active: s.id === activeId.value,
          starred: starred.value.has(s.id),
          canDelete: true,
          to: `#/hermes/session/${s.id}`,
          onSelect: () => handlers.select?.(s.id),
          onDelete: () => handlers.delete?.(s.id),
          onToggleStar: () => handlers.star?.(s.id),
          onContextmenu: (event: MouseEvent) => handlers.contextmenu?.(s.id, event),
        }),
      })
    },
  })
  const wrapper = mount(Host, { attachTo: document.body })
  return { wrapper, sessions, activeId, starred }
}

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

function renderedIds(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('.session-item-title').map(node => node.text().replace('Session ', 's'))
}

describe('VirtualSessionList (C1)', () => {
  let clientHeight: PropertyDescriptor | undefined
  let offsetTop: PropertyDescriptor | undefined
  let boundingRect: PropertyDescriptor | undefined

  beforeEach(() => {
    popoverMounts.tooltip = 0
    popoverMounts.popconfirm = 0
    clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    offsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop')
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return (this as HTMLElement).classList?.contains('virtual-session-list') ? VIEWPORT : 0
      },
    })
    // jsdom 不做布局：按行在列表中的真实位置返回 offsetTop，让行高实测走真实分支。
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get() {
        const el = this as HTMLElement
        if (!el.classList?.contains('virtual-session-list__row')) return 0
        const views = Array.from(el.parentElement?.querySelectorAll(':scope > .virtual-session-list__row') || [])
        return views.indexOf(el) * ROW
      },
    })
    // hermes-v050:E-03 行距改按 getBoundingClientRect 量（小数），这里同样按行的位置返回
    boundingRect = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect')
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: function (this: HTMLElement) {
        if (!this.classList?.contains('virtual-session-list__row')) return originalRect.call(this)
        const top = this.offsetTop
        return { x: 0, y: top, top, left: 0, right: 0, bottom: top + ROW, width: 0, height: ROW, toJSON() {} } as DOMRect
      },
    })
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0) as unknown as number)
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  })

  afterEach(() => {
    if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight)
    if (offsetTop) Object.defineProperty(HTMLElement.prototype, 'offsetTop', offsetTop)
    if (boundingRect) Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', boundingRect)
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('renders only a window of rows for 778 sessions, in list order', async () => {
    const { wrapper } = mountList()
    await settle()

    const ids = renderedIds(wrapper)
    expect(ids.length).toBeGreaterThan(5)
    expect(ids.length).toBeLessThan(40)
    expect(ids.slice(0, 3)).toEqual(['s0', 's1', 's2'])
    // flowMode 下 DOM 顺序就是列表顺序，键盘 Tab 顺序与视觉一致
    const numeric = ids.map(id => Number(id.slice(1)))
    expect([...numeric].sort((a, b) => a - b)).toEqual(numeric)
    // 列表总高度仍代表全部 778 行，滚动条比例不变
    const spacers = wrapper.findAll('.virtual-session-list__spacer').map(node => Number.parseFloat((node.element as HTMLElement).style.height) || 0)
    expect(spacers.reduce((sum, height) => sum + height, 0) + ids.length * ROW).toBeGreaterThanOrEqual(778 * 50)
    wrapper.unmount()
  })

  it('renders the rows around the scroll position after scrolling', async () => {
    const { wrapper } = mountList()
    await settle()
    const scroller = wrapper.find('.virtual-session-list').element as HTMLElement
    scroller.scrollTop = ROW * 400
    scroller.dispatchEvent(new Event('scroll'))
    await settle()

    const numeric = renderedIds(wrapper).map(id => Number(id.slice(1)))
    expect(numeric.length).toBeLessThan(40)
    expect(numeric).toContain(400)
    expect(numeric.every(index => index > 380 && index < 430)).toBe(true)
    expect([...numeric].sort((a, b) => a - b)).toEqual(numeric)
    wrapper.unmount()
  })

  it('keeps row click, star, context menu and delete confirmation working on rendered rows', async () => {
    const select = vi.fn()
    const star = vi.fn()
    const remove = vi.fn()
    const contextmenu = vi.fn()
    const { wrapper } = mountList(778, { select, star, delete: remove, contextmenu })
    await settle()

    const row = wrapper.findAll('a.session-item')[2]
    await row.trigger('click')
    expect(select).toHaveBeenCalledWith('s2')

    await row.find('.session-item-star').trigger('click')
    expect(star).toHaveBeenCalledWith('s2')
    expect(select).toHaveBeenCalledTimes(1)

    await row.trigger('contextmenu')
    expect(contextmenu).toHaveBeenCalledWith('s2', expect.any(MouseEvent))

    // 未预挂载时直接点删除：挂载原 NPopconfirm 并直接打开，确认后才删除
    await row.find('.session-item-delete').trigger('click')
    await settle()
    expect(select).toHaveBeenCalledTimes(1)
    expect(remove).not.toHaveBeenCalled()
    const rowAfter = wrapper.findAll('a.session-item')[2]
    expect(rowAfter.find('.popconfirm-panel-stub').text()).toContain('chat.deleteSession')
    await rowAfter.find('.popconfirm-positive-stub').trigger('click')
    expect(remove).toHaveBeenCalledWith('s2')
    wrapper.unmount()
  })

  it('keeps keyboard focus on the star button when focusing arms the row popovers', async () => {
    const { wrapper } = mountList()
    await settle()
    const row = wrapper.findAll('a.session-item')[4]
    const starButton = row.find('.session-item-star').element as HTMLButtonElement
    starButton.focus()
    await settle()
    const active = document.activeElement as HTMLElement | null
    expect(active?.classList.contains('session-item-star')).toBe(true)
    expect(active?.closest('.session-item')?.querySelector('.session-item-title')?.textContent?.trim()).toBe('Session 4')
    expect(popoverMounts.tooltip).toBe(1)
    wrapper.unmount()
  })

  it('updates rows in place for active state, stars and streaming ring', async () => {
    const { wrapper, activeId, starred } = mountList()
    await settle()
    expect(wrapper.findAll('a.session-item')[0].classes()).toContain('active')
    activeId.value = 's3'
    starred.value = new Set(['s3'])
    await settle()
    const row = wrapper.findAll('a.session-item')[3]
    expect(row.classes()).toContain('active')
    expect(row.attributes('aria-current')).toBe('page')
    expect(row.find('.session-item-star').classes()).toContain('starred')
    expect(wrapper.findAll('a.session-item')[0].classes()).not.toContain('active')
    wrapper.unmount()
  })

  it('renders the empty slot when there are no sessions', async () => {
    const { wrapper } = mountList(0)
    await settle()
    expect(wrapper.find('.session-empty').exists()).toBe(true)
    expect(wrapper.findAll('a.session-item')).toHaveLength(0)
    wrapper.unmount()
  })
})
