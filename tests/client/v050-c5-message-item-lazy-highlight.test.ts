// @vitest-environment jsdom
// hermes-v050:C5 MessageItem 只在展开工具详情时才加载高亮器，加载后自动换成着色版本。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const highlighterLoads = vi.hoisted(() => ({ count: 0 }))

vi.mock('@/components/hermes/chat/highlight-hljs', async (importOriginal) => {
  highlighterLoads.count += 1
  return importOriginal()
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NButton: { template: '<button><slot /></button>' },
  NDrawer: { template: '<div><slot /></div>' },
  NDrawerContent: { template: '<div><slot /></div>' },
  NSpin: { template: '<div />' },
  useMessage: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

import MessageItem from '@/components/hermes/chat/MessageItem.vue'
import type { Message } from '@/stores/hermes/chat'

describe('MessageItem loads the code highlighter on demand (C5)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        getVoices: vi.fn(() => []),
        speak: vi.fn(),
        cancel: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
      },
    })
  })

  it('does not load highlight.js for collapsed tool rows and highlights once expanded', async () => {
    const wrapper = mount(MessageItem, {
      props: {
        message: {
          id: 'tool-lazy-highlight',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: 'read_file',
          toolArgs: JSON.stringify({ path: '/tmp/a.ts', limit: 20 }),
          toolResult: JSON.stringify({ ok: true, lines: 20 }),
          toolStatus: 'done',
        } satisfies Message,
      },
      global: { stubs: { MarkdownRenderer: true } },
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(highlighterLoads.count).toBe(0)

    await wrapper.find('.tool-line').trigger('click')
    // 首帧先出纯文本外壳（结构与着色版一致），高亮器到位后自动重渲染
    expect(wrapper.findAll('.tool-details .hljs-code-block')).toHaveLength(2)
    await vi.waitFor(() => {
      expect(highlighterLoads.count).toBe(1)
      expect(wrapper.find('.tool-details code.hljs').findAll('span').length).toBeGreaterThan(0)
    })
    expect(wrapper.findAll('.tool-details .code-lang').map(node => node.text())).toEqual(['json', 'json'])
    wrapper.unmount()
  })
})
