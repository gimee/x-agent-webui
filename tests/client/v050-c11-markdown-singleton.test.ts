// @vitest-environment jsdom
// hermes-v050:C11 MarkdownIt + katex 只构造一次；复制等文案按当前语言渲染。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createI18n } from 'vue-i18n'

const markdownItConstructions = vi.hoisted(() => ({ count: 0 }))

vi.mock('markdown-it', async (importOriginal) => {
  const actual = await importOriginal<typeof import('markdown-it')>()
  const Original = actual.default as unknown as new (...args: any[]) => any
  function CountingMarkdownIt(this: unknown, ...args: any[]) {
    markdownItConstructions.count += 1
    return new Original(...args)
  }
  Object.assign(CountingMarkdownIt, Original)
  return { ...actual, default: CountingMarkdownIt }
})

vi.mock('naive-ui', () => ({
  useMessage: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

import MarkdownRenderer from '@/components/hermes/chat/MarkdownRenderer.vue'

function makeI18n() {
  return createI18n({
    legacy: false,
    locale: 'en',
    fallbackLocale: 'en',
    messages: {
      en: { common: { copy: 'Copy' }, chat: { unchangedLines: '{count} unchanged lines' } },
      zh: { common: { copy: '复制' }, chat: { unchangedLines: '{count} 行未改动' } },
    },
  })
}

describe('MarkdownRenderer shared MarkdownIt instance (C11)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('constructs MarkdownIt (and installs katex) once for any number of renderers', async () => {
    const i18n = makeI18n()
    const before = markdownItConstructions.count
    const wrappers = Array.from({ length: 5 }, (_, index) => mount(MarkdownRenderer, {
      props: { content: `# Title ${index}\n\n$x^${index}$ and \`code\`` },
      global: { plugins: [i18n] },
    }))
    await nextTick()
    expect(markdownItConstructions.count - before).toBe(0)
    expect(markdownItConstructions.count).toBeLessThanOrEqual(1)
    for (const wrapper of wrappers) {
      expect(wrapper.find('.katex').exists()).toBe(true)
      wrapper.unmount()
    }
  })

  it('renders code block labels in the current locale and follows a locale switch', async () => {
    const i18n = makeI18n()
    const wrapper = mount(MarkdownRenderer, {
      props: { content: '```ts\nconst a = 1\n```' },
      global: { plugins: [i18n] },
    })
    const other = mount(MarkdownRenderer, {
      props: { content: '```json\n{"a": 1}\n```' },
      global: { plugins: [i18n] },
    })
    await nextTick()
    expect(wrapper.find('[data-copy-code="true"]').text()).toBe('Copy')
    expect(other.find('[data-copy-code="true"]').text()).toBe('Copy')

    i18n.global.locale.value = 'zh'
    await nextTick()
    await nextTick()
    expect(wrapper.find('[data-copy-code="true"]').text()).toBe('复制')
    expect(other.find('[data-copy-code="true"]').text()).toBe('复制')
    wrapper.unmount()
    other.unmount()
  })

  it('injects the diff fold label through the render env', async () => {
    const i18n = makeI18n()
    const context = Array.from({ length: 12 }, (_, index) => ` line ${index}`).join('\n')
    const wrapper = mount(MarkdownRenderer, {
      props: { content: `\`\`\`diff\n--- a/x\n+++ b/x\n@@ -1,13 +1,13 @@\n-old\n+new\n${context}\n\`\`\`` },
      global: { plugins: [i18n] },
    })
    await nextTick()
    expect(wrapper.find('.diff-line-context-fold').text()).toContain('6 unchanged lines')
    wrapper.unmount()
  })
})
