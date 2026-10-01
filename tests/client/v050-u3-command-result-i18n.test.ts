// @vitest-environment jsdom
// hermes-v050:U3/U16-T5/T7 — 命令回执按 code 用 i18n 渲染；没有 code 或未知 code 退回服务端英文原文。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import en from '@/i18n/locales/en'
import zh from '@/i18n/locales/zh'
import { mergeMessagesWithFallback } from '@/i18n/messages'

vi.mock('naive-ui', () => ({
  NButton: { template: '<button><slot /></button>' },
  NDrawer: { template: '<div><slot /></div>' },
  NDrawerContent: { template: '<div><slot /></div>' },
  NSpin: { template: '<div />' },
  useMessage: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

vi.mock('@/components/hermes/chat/MarkdownRenderer.vue', async () => {
  const { defineComponent } = await import('vue')
  return { default: defineComponent({ name: 'MarkdownRenderer', props: { content: { type: String, default: '' } }, template: '<div class="md-stub">{{ content }}</div>' }) }
})

import { formatCommandResultText } from '@/utils/hermes/command-result-text'
import MessageItem from '@/components/hermes/chat/MessageItem.vue'
import type { Message } from '@/stores/hermes/chat'

function i18nFor(locale: 'zh' | 'en') {
  return createI18n({ legacy: false, locale, fallbackLocale: 'en', messages: { en, zh: mergeMessagesWithFallback(en, zh) } })
}

const zhT = i18nFor('zh').global.t as any
const enT = i18nFor('en').global.t as any

describe('hermes-v050:U3 formatCommandResultText', () => {
  it('renders the /compact receipts in Chinese and names the agent without the Claude Code brand', () => {
    expect(formatCommandResultText({ messageCode: 'compact_sent', agentId: 'claude' }, zhT)).toBe('已向 Claude 发送原生 /compact。')
    expect(formatCommandResultText({ messageCode: 'compact_sent', agentId: 'claude-code' }, zhT)).toBe('已向 Claude 发送原生 /compact。')
    expect(formatCommandResultText({ messageCode: 'compact_sent', agentId: 'codex' }, zhT)).toBe('已向 Codex 发送原生 /compact。')
    expect(formatCommandResultText({ messageCode: 'compact_sent', agentId: 'pi' }, zhT)).toBe('已向 Pi 发送原生 /compact。')
    expect(formatCommandResultText({ messageCode: 'compact_done', beforeTokens: 500, afterTokens: 200 }, zhT)).toBe('压缩完成。压缩前：500 tokens，压缩后：200 tokens。')
    expect(formatCommandResultText({ messageCode: 'compact_done', beforeTokens: 500, afterTokens: null }, zhT)).toBe('压缩完成。压缩前：500 tokens。')
    expect(formatCommandResultText({ messageCode: 'compact_done' }, zhT)).toBe('压缩完成。')
    expect(formatCommandResultText({ messageCode: 'compact_no_change' }, zhT)).toBe('压缩完成，没有变化。')
    expect(formatCommandResultText({ messageCode: 'compact_failed', error: 'native compact unsupported' }, zhT)).toBe('压缩失败：native compact unsupported')
  })

  it('reproduces the server English text in English', () => {
    expect(formatCommandResultText({ messageCode: 'compact_sent', agentId: 'codex' }, enT)).toBe('Native /compact sent to Codex.')
    expect(formatCommandResultText({ messageCode: 'compact_done', beforeTokens: 500, afterTokens: 200 }, enT)).toBe('Compaction completed. Before: 500 tokens. After: 200 tokens.')
    expect(formatCommandResultText({ messageCode: 'context', inputTokens: 10, outputTokens: 20, totalTokens: 30, contextWindow: 256000, contextPercent: 0 }, enT))
      .toBe('Context: input 10, output 20, total 30 / 256000 tokens (0%).')
  })

  it('renders context / usage receipts (T5) in Chinese', () => {
    expect(formatCommandResultText({ messageCode: 'context', inputTokens: 10, outputTokens: 20, totalTokens: 30, contextWindow: 256000, contextPercent: 0 }, zhT))
      .toBe('上下文：输入 10，输出 20，合计 30 / 256000 tokens（0%）。')
    expect(formatCommandResultText({ messageCode: 'usage', inputTokens: 10, outputTokens: 20, totalTokens: 30 }, zhT)).toBe('用量：输入 10，输出 20，合计 30 tokens。')
    expect(formatCommandResultText({ messageCode: 'context_pi', contextTokens: 40000, contextWindow: 200000, contextPercent: 20 }, zhT)).toBe('上下文：40000 / 200000 tokens（20%）。')
    expect(formatCommandResultText({ messageCode: 'usage_pi', inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 5, totalTokens: 155 }, zhT))
      .toBe('用量：输入 100，输出 20，缓存读取 30，缓存写入 5，合计 155 tokens。')
    expect(formatCommandResultText({ messageCode: 'context_failed', error: 'db locked' }, zhT)).toBe('上下文查询失败：db locked')
    expect(formatCommandResultText({ messageCode: 'usage_failed', error: 'db locked' }, zhT)).toBe('用量查询失败：db locked')
  })

  it('falls back (returns null) for unknown codes, missing codes and incomplete numbers', () => {
    expect(formatCommandResultText({}, zhT)).toBeNull()
    expect(formatCommandResultText(undefined, zhT)).toBeNull()
    expect(formatCommandResultText({ messageCode: 'from_the_future' }, zhT)).toBeNull()
    expect(formatCommandResultText({ messageCode: 'context_pi', contextTokens: null, contextWindow: 200000, contextPercent: null }, zhT)).toBeNull()
    expect(formatCommandResultText({ messageCode: 'context', inputTokens: 1 }, zhT)).toBeNull()
  })
})

describe('hermes-v050:U3/T7 MessageItem command rendering', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  function mountItem(message: Message, locale: 'zh' | 'en' = 'zh') {
    return mount(MessageItem, { props: { message }, global: { plugins: [i18nFor(locale)] } })
  }

  it('shows the Chinese receipt for a coded command message and the server text otherwise', async () => {
    const coded = mountItem({
      id: 'c1', role: 'command', content: 'Native /compact sent to Claude Code.', timestamp: 1, systemType: 'command', commandAction: 'compact',
      commandData: { messageCode: 'compact_sent', agentId: 'claude', message: 'Native /compact sent to Claude Code.' },
    })
    await flushPromises()
    expect(coded.get('.command-result').text()).toContain('已向 Claude 发送原生 /compact。')
    expect(coded.get('.command-result').text()).not.toContain('Claude Code')

    const legacy = mountItem({ id: 'c2', role: 'command', content: 'Compression completed: 10 -> 4 messages.', timestamp: 2, systemType: 'command', commandAction: 'compress', commandData: { message: 'Compression completed: 10 -> 4 messages.' } })
    await flushPromises()
    expect(legacy.get('.command-result').text()).toContain('Compression completed: 10 -> 4 messages.')
  })

  it('translates the /status card keys and running / idle values (T7)', async () => {
    const wrapper = mountItem({
      id: 's1', role: 'command', content: 'Status: idle', timestamp: 1, systemType: 'command', commandAction: 'status',
      commandData: { isWorking: false, source: 'cli', profile: 'default', model: 'm', queueLength: 0 },
    })
    await flushPromises()
    const keys = wrapper.findAll('.command-status-key').map(node => node.text())
    expect(keys).toEqual(['状态', '来源', '配置', '模型', '队列', '运行'])
    expect(wrapper.findAll('.command-status-value')[0].text()).toBe('空闲')

    const english = mountItem({
      id: 's2', role: 'command', content: 'Status: running', timestamp: 1, systemType: 'command', commandAction: 'status',
      commandData: { isWorking: true },
    }, 'en')
    await flushPromises()
    expect(english.findAll('.command-status-key').map(node => node.text())).toEqual(['status', 'source', 'profile', 'model', 'queue', 'run'])
    expect(english.findAll('.command-status-value')[0].text()).toBe('running')
  })
})
