// @vitest-environment jsdom
// hermes-v050:F-07 侧栏会话重排时行不重挂：同一会话的行元素原样保留（按会话 id 复用 DOM），
// 键盘焦点和已打开的删除确认（真实 naive NPopconfirm）都还在。v0.4.6 的带 key v-for 就是这样，
// C1 的 RecycleScroller 在顺序变化时把可见行全部回收重挂（F-07）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => ({ profileModelGroups: [] }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

import VirtualSessionList from '@/components/hermes/chat/VirtualSessionList.vue'
import SessionListItem from '@/components/hermes/chat/SessionListItem.vue'

const ROW = 62
const VIEWPORT = 600

type Row = { id: string; title: string; createdAt: number; updatedAt: number; profile: string; source: string; messages: never[] }

function makeSessions(count: number): Row[] {
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

function mountList(count = 300) {
  const sessions = ref(makeSessions(count))
  const remove = vi.fn()
  const Host = defineComponent({
    setup() {
      return () => h(VirtualSessionList, { class: 'session-items', items: sessions.value }, {
        default: ({ item: s }: { item: Row }) => h(SessionListItem, {
          key: s.id,
          session: s as any,
          active: false,
          canDelete: true,
          to: `#/hermes/session/${s.id}`,
          onDelete: () => remove(s.id),
        }),
      })
    },
  })
  const wrapper = mount(Host, { attachTo: document.body })
  return { wrapper, sessions, remove }
}

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

// 回收池里停放的行（display:none）不算
function shownRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('a.session-item'))
    .filter(row => (row.parentElement as HTMLElement | null)?.style.display !== 'none')
}

function rowFor(id: string): HTMLElement | null {
  return shownRows().find(row => row.querySelector('.session-item-title')?.textContent?.trim() === `Session ${id.slice(1)}`) ?? null
}

function visibleOrder(): string[] {
  return shownRows().map(row => `s${row.querySelector('.session-item-title')?.textContent?.trim().replace('Session ', '')}`)
}

function moveToFront(sessions: { value: Row[] }, id: string) {
  const moved = sessions.value.find(session => session.id === id)!
  sessions.value = [moved, ...sessions.value.filter(session => session.id !== id)]
}

describe('session list reorder keeps rows mounted (F-07)', () => {
  let clientHeight: PropertyDescriptor | undefined
  let offsetTop: PropertyDescriptor | undefined
  let boundingRect: PropertyDescriptor | undefined

  beforeEach(() => {
    clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    offsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop')
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return (this as HTMLElement).classList?.contains('session-items') ? VIEWPORT : 0
      },
    })
    // jsdom 不做布局：包着会话行的那一层按它在兄弟中的位置返回 offsetTop（行高实测走真实分支）
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get() {
        const el = this as HTMLElement
        const holdsRow = (node: Element) => node.firstElementChild?.classList?.contains('session-item') && (node as HTMLElement).style.display !== 'none'
        if (!holdsRow(el)) return 0
        const rows = Array.from(el.parentElement?.children || []).filter(holdsRow)
        return rows.indexOf(el) * ROW
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

  async function focusRowAndOpenConfirm() {
    const focused = rowFor('s3')!
    focused.focus()
    await settle()
    expect(document.activeElement).toBe(focused)

    const confirmRow = rowFor('s5')!
    ;(confirmRow.querySelector('.session-item-delete') as HTMLElement).click()
    await settle()
    expect(document.querySelectorAll('.n-popconfirm')).toHaveLength(1)
    expect(document.activeElement).toBe(focused)
    return { focused, confirmRow }
  }

  it('moving a visible session to the top reuses the other rows, focus and the open confirm', async () => {
    const { wrapper, sessions, remove } = mountList()
    await settle()
    const { focused, confirmRow } = await focusRowAndOpenConfirm()
    const before = new Map(['s0', 's1', 's2', 's4', 's6'].map(id => [id, rowFor(id)]))

    moveToFront(sessions, 's10')
    await settle()

    expect(visibleOrder().slice(0, 4)).toEqual(['s10', 's0', 's1', 's2'])
    expect(rowFor('s3')).toBe(focused)
    expect(rowFor('s5')).toBe(confirmRow)
    for (const [id, element] of before) expect(rowFor(id), id).toBe(element)
    expect(document.activeElement).toBe(focused)
    const confirm = document.querySelectorAll('.n-popconfirm')
    expect(confirm).toHaveLength(1)
    expect(confirm[0].textContent).toContain('chat.deleteSession')

    // 确认仍然删的是原来那个会话
    const positive = Array.from(document.querySelectorAll<HTMLButtonElement>('.n-popconfirm__action button')).at(-1)!
    positive.click()
    await settle()
    expect(remove).toHaveBeenCalledWith('s5')
    wrapper.unmount()
  })

  it('a session from far below (or a new one) jumping to the top keeps the visible rows mounted', async () => {
    const { wrapper, sessions } = mountList()
    await settle()
    const { focused, confirmRow } = await focusRowAndOpenConfirm()

    moveToFront(sessions, 's200')
    await settle()
    sessions.value = [{ ...makeSessions(1)[0], id: 'new-1', title: 'Session new' }, ...sessions.value]
    await settle()

    expect(visibleOrder().slice(0, 3)).toEqual(['snew', 's200', 's0'])
    expect(rowFor('s3')).toBe(focused)
    expect(rowFor('s5')).toBe(confirmRow)
    expect(document.activeElement).toBe(focused)
    expect(document.querySelectorAll('.n-popconfirm')).toHaveLength(1)
    wrapper.unmount()
  })
})
