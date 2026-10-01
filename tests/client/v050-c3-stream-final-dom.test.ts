// @vitest-environment jsdom
// hermes-v050:C3 流式按帧合并 + 代码块高亮缓存后，流结束时的 DOM 必须与一次性渲染逐字一致
// （含代码块、未闭合 fence 过渡、diff、katex、表格）。
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createI18n } from 'vue-i18n'

vi.mock('naive-ui', () => ({
  useMessage: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

import MarkdownRenderer from '@/components/hermes/chat/MarkdownRenderer.vue'

const i18n = () => createI18n({
  legacy: false, locale: 'en', fallbackLocale: 'en',
  messages: { en: { common: { copy: 'Copy' }, chat: { unchangedLines: '{count} unchanged lines' } } },
})

const FINAL = [
  '# 标题',
  '',
  '一段带 `inline` 与 $E=mc^2$ 的正文。',
  '',
  '```ts',
  ...Array.from({ length: 30 }, (_, i) => `export const v${i} = (x: number) => x * ${i}`),
  '```',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '```python',
  'def f(x):',
  '    return x + 1',
  '```',
  '',
  '```diff',
  '+added',
  '-removed',
  ' kept',
  '```',
  '',
  '- 列表 1',
  '- 列表 2',
].join('\n')

describe('streamed markdown ends in the same DOM as a one-shot render (C3)', () => {
  it('matches after growing through partial fences', async () => {
    const plugin = i18n()
    const streamed = mount(MarkdownRenderer, { props: { content: '' }, global: { plugins: [plugin] } })
    // 按 7 字一个 delta 喂进去（中间状态包含未闭合的代码块）
    for (let end = 7; end < FINAL.length; end += 7) {
      await streamed.setProps({ content: FINAL.slice(0, end) })
    }
    await streamed.setProps({ content: FINAL })
    await nextTick()

    const oneShot = mount(MarkdownRenderer, { props: { content: FINAL }, global: { plugins: [plugin] } })
    await nextTick()
    expect(streamed.html()).toBe(oneShot.html())
    expect(streamed.findAll('pre code .hljs-keyword').length).toBeGreaterThan(0)
    streamed.unmount()
    oneShot.unmount()
  })
})
