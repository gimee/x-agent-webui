// @vitest-environment jsdom
// hermes-v050:E-01 冷打开会话时正文晚一帧才撑开（真浏览器 CLS 0.458 / 0.191）：MessageItem 用
// defineAsyncComponent 加载 MarkdownRenderer，第一批消息行挂载时正文是空的。这里守住：
// 1. MessageList 挂载后渲染块就解析好，之后第一次挂载的 MessageItem 在同一次挂载里就有正文；
// 2. 首批消息到达时渲染块还没到，就先不插消息行（保持原来的加载态），到了再一次插入带正文的行；
// 3. 渲染块加载失败时消息行照常出现，不会一直卡在加载态；
// 4. C5：MarkdownRenderer 仍是独立的异步 chunk（完整 highlight.js 不进首屏静态闭包）。
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import en from '@/i18n/locales/en'
import zh from '@/i18n/locales/zh'
import { mergeMessagesWithFallback } from '@/i18n/messages'

// 渲染块 chunk：factory 等 chunk.ready 才返回，模拟网络上还没到；loads 记录真正发起了几次加载
const chunk = vi.hoisted(() => ({ ready: Promise.resolve() as Promise<void>, loads: 0 }))

vi.mock('naive-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('naive-ui')>()),
  useMessage: () => ({ error: () => {}, success: () => {}, warning: () => {}, info: () => {}, loading: () => ({ destroy() {} }) }),
}))

async function markdownRendererChunk() {
  chunk.loads += 1
  await chunk.ready
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'MarkdownRenderer',
      props: { content: { type: String, default: '' }, headingIdPrefix: { type: String, default: '' } },
      setup: props => () => h('div', { class: 'md-stub' }, props.content),
    }),
  }
}

const i18n = () => createI18n({ legacy: false, locale: 'zh', fallbackLocale: 'en', messages: { en, zh: mergeMessagesWithFallback(en, zh) } })

// 每个用例一套全新的组件模块：模块级的渲染块缓存（以及原来 defineAsyncComponent 的缓存）不跨用例；
// 渲染块用 doMock 重新登记，resetModules 之后的第一次 import 才会真的再走一次 factory
async function freshModules() {
  vi.resetModules()
  vi.doMock('@/components/hermes/chat/MarkdownRenderer.vue', markdownRendererChunk)
  const { default: MessageList } = await import('@/components/hermes/chat/MessageList.vue')
  const { default: MessageItem } = await import('@/components/hermes/chat/MessageItem.vue')
  const { useChatStore } = await import('@/stores/hermes/chat')
  return { MessageList, MessageItem, useChatStore }
}

function session(id: string, messages: any[]) {
  return { id, title: id, source: 'cli', messages, createdAt: 1, updatedAt: 1 }
}

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

const errors: unknown[] = []
const mounted: VueWrapper[] = []
const mountOptions = () => ({ global: { plugins: [i18n()], config: { errorHandler: (error: unknown) => { errors.push(error) } } }, attachTo: document.body })

describe('hermes-v050:E-01 MarkdownRenderer is resolved before message rows mount', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    chunk.ready = Promise.resolve()
    chunk.loads = 0
    errors.length = 0
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  })

  afterEach(() => {
    while (mounted.length) mounted.pop()!.unmount()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('renders the body inside the first MessageItem mount once MessageList has resolved the renderer', async () => {
    const { MessageList, MessageItem, useChatStore } = await freshModules()
    const chatStore = useChatStore()
    chatStore.activeSessionId = 's-empty'
    chatStore.activeSession = session('s-empty', []) as any
    mounted.push(mount(MessageList, mountOptions()))
    await settle()
    expect(chunk.loads).toBe(1)

    // 这是本模块里第一次挂载 MessageItem：不等任何 tick，挂载返回时正文就要在
    const item = mount(MessageItem, {
      ...mountOptions(),
      props: { message: { id: 'a1', role: 'assistant', content: 'Answer body', timestamp: 1 } as any },
    })
    mounted.push(item)
    expect(item.find('.md-stub').exists()).toBe(true)
    expect(item.get('.md-stub').text()).toBe('Answer body')
    expect(errors).toEqual([])
  })

  it('holds message rows back until the renderer chunk arrives, then inserts them with their body', async () => {
    let release!: () => void
    chunk.ready = new Promise<void>(resolve => { release = resolve })
    const { MessageList, useChatStore } = await freshModules()
    const chatStore = useChatStore()
    chatStore.activeSessionId = 's1'
    chatStore.activeSession = session('s1', [
      { id: 'u1', role: 'user', content: 'Question text', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'Answer body', timestamp: 2 },
    ]) as any

    // 任何时刻 DOM 里出现没有正文的消息行都记下来（真浏览器里这一帧就是 CLS 的来源）
    const emptyRowsSeen: string[] = []
    const observer = new MutationObserver(() => {
      for (const row of document.querySelectorAll('.virtual-row[data-message-id]')) {
        if (!row.querySelector('.md-stub')) emptyRowsSeen.push(row.getAttribute('data-message-id') || '?')
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })

    const list = mount(MessageList, mountOptions())
    mounted.push(list)
    await settle()
    expect(chunk.loads).toBeGreaterThanOrEqual(1) // 挂载时已经开始加载
    // 渲染块还没到：保持加载态，不插空行
    expect(list.findAll('.virtual-row[data-message-id]')).toHaveLength(0)

    release()
    await settle()
    observer.disconnect()
    const rows = list.findAll('.virtual-row[data-message-id]')
    expect(rows.map(row => row.attributes('data-message-id'))).toEqual(['u1', 'a1'])
    expect(rows.map(row => row.find('.md-stub').exists() ? row.get('.md-stub').text() : null)).toEqual(['Question text', 'Answer body'])
    expect(emptyRowsSeen).toEqual([])
    expect(errors).toEqual([])
  })

  it('still inserts the rows when the renderer chunk fails to load', async () => {
    chunk.ready = Promise.reject(new Error('chunk 404'))
    chunk.ready.catch(() => undefined)
    const { MessageList, useChatStore } = await freshModules()
    const chatStore = useChatStore()
    chatStore.activeSessionId = 's2'
    chatStore.activeSession = session('s2', [
      { id: 'u1', role: 'user', content: 'Question text', timestamp: 1 },
    ]) as any
    const list = mount(MessageList, mountOptions())
    mounted.push(list)
    await settle()
    expect(list.findAll('.virtual-row[data-message-id]').map(row => row.attributes('data-message-id'))).toEqual(['u1'])
  })
})

describe('hermes-v050:E-01 keeps MarkdownRenderer out of the first-screen static closure (C5)', () => {
  const read = (path: string) => readFileSync(`packages/client/src/components/hermes/chat/${path}`, 'utf8')

  it('only reaches MarkdownRenderer.vue through a dynamic import in a shared loader', () => {
    const loader = read('markdown-renderer-loader.ts')
    expect(loader).toContain('import("./MarkdownRenderer.vue")')
    expect(loader).not.toMatch(/^import .*MarkdownRenderer\.vue/m)
    expect(loader).toContain('shallowRef')
    for (const file of ['MessageItem.vue', 'MessageList.vue']) {
      const source = read(file)
      expect(source, file).not.toMatch(/^import .*MarkdownRenderer\.vue/m)
      expect(source, file).not.toContain('import("./MarkdownRenderer.vue")')
      expect(source, file).toContain('from "./markdown-renderer-loader"')
    }
  })
})
