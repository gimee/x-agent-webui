// @vitest-environment jsdom
// hermes-v050:F-13 首次加载 mermaid 超过 5s 时这张图先退回代码块；加载完成后自动重新渲染，
// 不需要等内容再变化（流已经结束 / 历史消息也能恢复）。v0.5.0 合并版里它会永久停在代码块上。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

const gate = vi.hoisted(() => {
  let release: () => void = () => undefined
  const ready = new Promise<void>((resolve) => { release = resolve })
  return { ready, release: () => release() }
})

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (id: string, source: string) => ({
    svg: `<svg id="${id}" data-testid="mermaid-svg"><text>${source}</text></svg>`,
  })),
}))

vi.mock('mermaid', async () => {
  await gate.ready
  return { default: mermaidMock }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  useMessage: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

import MarkdownRenderer from '@/components/hermes/chat/MarkdownRenderer.vue'

async function flushMermaid(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await nextTick()
    await Promise.resolve()
  }
}

describe('mermaid import timeout is not permanent (F-13)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-renders the diagram once the slow mermaid import finally lands', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MarkdownRenderer, {
      props: { content: '```mermaid\nflowchart TD\nA --> B\n```\n\nfinished answer' },
    })
    await flushMermaid()
    await vi.advanceTimersByTimeAsync(5_001)
    await flushMermaid()
    // 超时期间仍可复制原文
    expect(wrapper.find('.hljs-code-block .code-lang').text()).toBe('mermaid')
    expect(wrapper.find('[data-testid="mermaid-svg"]').exists()).toBe(false)

    gate.release()
    await flushMermaid()
    await vi.advanceTimersByTimeAsync(0)
    await flushMermaid()
    expect(wrapper.find('[data-testid="mermaid-svg"]').exists()).toBe(true)
    expect(wrapper.find('.hljs-code-block').exists()).toBe(false)
    wrapper.unmount()
  })
})
