// @vitest-environment jsdom
// hermes-v050:F-12 / F-13 / F-14 mermaid 与 C3 按块修补的交互（行为测试，真实 vue-i18n）：
// F-12 流式期间每条消息最多 4 张图（与一次性渲染、v0.4.6 流式一致）；
// F-13 渲染超时退回的代码块不是永久的：流继续时重试；
// F-14 退回的代码块在切换语言后复制按钮跟着换文案。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createI18n } from 'vue-i18n'

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (id: string, source: string) => ({
    svg: `<svg id="${id}" data-testid="mermaid-svg"><text>${source}</text></svg>`,
  })),
}))

vi.mock('mermaid', () => ({ default: mermaidMock }))

vi.mock('naive-ui', () => ({
  useMessage: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

import MarkdownRenderer from '@/components/hermes/chat/MarkdownRenderer.vue'

const makeI18n = () => createI18n({
  legacy: false, locale: 'en', fallbackLocale: 'en',
  messages: {
    en: { common: { copy: 'Copy' }, chat: { unchangedLines: '{count} unchanged lines' } },
    zh: { common: { copy: '复制' }, chat: { unchangedLines: '{count} 行未改动' } },
  },
})

const fence = (index: number) => ['```mermaid', `flowchart TD`, `A${index} --> B${index}`, '```'].join('\n')

async function flushMermaid(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await nextTick()
    await Promise.resolve()
  }
}

function counts(root: Element) {
  return {
    svg: root.querySelectorAll('[data-testid="mermaid-svg"]').length,
    fallback: Array.from(root.querySelectorAll('.hljs-code-block .code-lang')).filter(node => node.textContent === 'mermaid').length,
  }
}

describe('mermaid inside block-patched streaming markdown', () => {
  beforeEach(() => {
    mermaidMock.initialize.mockClear()
    mermaidMock.render.mockReset()
    mermaidMock.render.mockImplementation(async (id: string, source: string) => ({
      svg: `<svg id="${id}" data-testid="mermaid-svg"><text>${source}</text></svg>`,
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('F-12: keeps the 4-diagrams-per-message cap while streaming (same as a one-shot render)', async () => {
    const i18n = makeI18n()
    const parts: string[] = []
    const wrapper = mount(MarkdownRenderer, { props: { content: 'intro' }, global: { plugins: [i18n] } })
    await flushMermaid()
    for (let index = 1; index <= 6; index += 1) {
      parts.push(`step ${index}`, fence(index))
      await wrapper.setProps({ content: ['intro', ...parts].join('\n\n') })
      await flushMermaid()
    }
    await wrapper.setProps({ content: ['intro', ...parts, 'done'].join('\n\n') })
    await flushMermaid()
    expect(counts(wrapper.element)).toEqual({ svg: 4, fallback: 2 })

    const oneShot = mount(MarkdownRenderer, { props: { content: ['intro', ...parts, 'done'].join('\n\n') }, global: { plugins: [i18n] } })
    await flushMermaid()
    expect(counts(oneShot.element)).toEqual({ svg: 4, fallback: 2 })
    // 被上限挡下的是文档顺序里的第 5、6 张
    const fallbacks = Array.from(wrapper.element.querySelectorAll('.hljs-code-block code')).map(node => node.textContent)
    expect(fallbacks.join('|')).toContain('A5 --> B5')
    expect(fallbacks.join('|')).toContain('A6 --> B6')
    wrapper.unmount()
    oneShot.unmount()
  })

  it('F-13: a render timeout is retried once the stream moves on, instead of staying a code block', async () => {
    vi.useFakeTimers()
    const i18n = makeI18n()
    let calls = 0
    mermaidMock.render.mockImplementation((id: string, source: string) => {
      calls += 1
      // 第一次渲染卡住（例如首次加载时 CPU 被占满），之后恢复正常
      if (calls === 1) return new Promise(() => {})
      return Promise.resolve({ svg: `<svg id="${id}" data-testid="mermaid-svg"><text>${source}</text></svg>` })
    })
    const wrapper = mount(MarkdownRenderer, { props: { content: `${fence(1)}\n\nstreaming` }, global: { plugins: [i18n] } })
    await flushMermaid()
    await vi.advanceTimersByTimeAsync(5_001)
    await flushMermaid()
    expect(counts(wrapper.element)).toEqual({ svg: 0, fallback: 1 })

    // 流继续：mermaid 块本身的 html 没变，也要重试
    await wrapper.setProps({ content: `${fence(1)}\n\nstreaming more` })
    await flushMermaid()
    await vi.advanceTimersByTimeAsync(0)
    await flushMermaid()
    expect(counts(wrapper.element)).toEqual({ svg: 1, fallback: 0 })
    wrapper.unmount()
  })

  it('F-13: a genuine render error stays a code block (no retry loop on every delta)', async () => {
    const i18n = makeI18n()
    mermaidMock.render.mockImplementation(async () => { throw new Error('Parse error on line 2') })
    const wrapper = mount(MarkdownRenderer, { props: { content: `${fence(1)}\n\na` }, global: { plugins: [i18n] } })
    await flushMermaid()
    expect(counts(wrapper.element)).toEqual({ svg: 0, fallback: 1 })
    await wrapper.setProps({ content: `${fence(1)}\n\nab` })
    await flushMermaid()
    await wrapper.setProps({ content: `${fence(1)}\n\nabc` })
    await flushMermaid()
    expect(mermaidMock.render).toHaveBeenCalledTimes(1)
    expect(counts(wrapper.element)).toEqual({ svg: 0, fallback: 1 })
    wrapper.unmount()
  })

  it('F-14: fallback code blocks follow a locale switch (copy button text)', async () => {
    const i18n = makeI18n()
    mermaidMock.render.mockImplementation(async () => { throw new Error('Parse error') })
    // 一张渲染失败退回的 + 超过上限直接退回的（第 5 张）+ 普通代码块
    const content = [fence(1), fence(2), fence(3), fence(4), fence(5), '```ts\nconst x = 1\n```'].join('\n\n')
    const wrapper = mount(MarkdownRenderer, { props: { content }, global: { plugins: [i18n] } })
    await flushMermaid()
    const labels = () => Array.from(wrapper.element.querySelectorAll('.copy-btn')).map(node => node.textContent)
    expect(labels()).toEqual(['Copy', 'Copy', 'Copy', 'Copy', 'Copy', 'Copy'])

    i18n.global.locale.value = 'zh'
    await flushMermaid()
    expect(labels()).toEqual(['复制', '复制', '复制', '复制', '复制', '复制'])
    wrapper.unmount()
  })
})
