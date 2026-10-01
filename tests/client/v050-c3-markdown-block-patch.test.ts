// @vitest-environment jsdom
// hermes-v050:C3 流式时按顶层块修补 DOM：已完成的块（高亮好的代码块等）节点原样保留，只替换变化的尾部块；
// 块数变少、语言切换、块外被改动时都要回到正确结果。
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createI18n } from 'vue-i18n'

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

const CODE = ['```ts', 'export const a = 1', 'export const b = 2', '```'].join('\n')

describe('MarkdownRenderer patches top-level blocks while streaming (C3)', () => {
  it('keeps the DOM of finished blocks while the tail grows', async () => {
    const i18n = makeI18n()
    const wrapper = mount(MarkdownRenderer, { props: { content: `# Title\n\n${CODE}\n\nfirst` }, global: { plugins: [i18n] } })
    await nextTick()
    const body = wrapper.find('.markdown-body').element as HTMLElement
    const heading = body.querySelector('h1')!
    const pre = body.querySelector('pre')!
    // 用户在已完成的块里产生的 DOM 状态（例如点了复制、mermaid 已渲染）不被下一个 delta 冲掉
    pre.setAttribute('data-user-state', 'kept')

    for (const tail of ['first line', 'first line grows', 'first line grows\n\n- item']) {
      await wrapper.setProps({ content: `# Title\n\n${CODE}\n\n${tail}` })
      await nextTick()
    }
    expect(body.querySelector('h1')).toBe(heading)
    expect(body.querySelector('pre')).toBe(pre)
    expect(pre.getAttribute('data-user-state')).toBe('kept')
    expect(body.querySelector('li')?.textContent).toBe('item')

    const oneShot = mount(MarkdownRenderer, { props: { content: `# Title\n\n${CODE}\n\nfirst line grows\n\n- item` }, global: { plugins: [i18n] } })
    await nextTick()
    const clean = (html: string) => html.replace(/ data-user-state="kept"/, '')
    expect(clean(body.innerHTML)).toBe((oneShot.find('.markdown-body').element as HTMLElement).innerHTML)
    wrapper.unmount()
    oneShot.unmount()
  })

  it('rebuilds correctly when blocks disappear, the locale changes, or someone else edited the top level', async () => {
    const i18n = makeI18n()
    const wrapper = mount(MarkdownRenderer, { props: { content: `a\n\n${CODE}\n\nb\n\nc` }, global: { plugins: [i18n] } })
    await nextTick()
    const body = wrapper.find('.markdown-body').element as HTMLElement
    const expectHtmlFor = async (content: string) => {
      const reference = mount(MarkdownRenderer, { props: { content }, global: { plugins: [i18n] } })
      await nextTick()
      expect(body.innerHTML).toBe((reference.find('.markdown-body').element as HTMLElement).innerHTML)
      reference.unmount()
    }

    await wrapper.setProps({ content: `a\n\n${CODE}` })
    await nextTick()
    await expectHtmlFor(`a\n\n${CODE}`)

    i18n.global.locale.value = 'zh'
    await nextTick()
    await nextTick()
    expect(body.innerHTML).toContain('复制')
    await expectHtmlFor(`a\n\n${CODE}`)

    body.appendChild(document.createElement('hr'))
    await wrapper.setProps({ content: `a\n\n${CODE}\n\nz` })
    await nextTick()
    await expectHtmlFor(`a\n\n${CODE}\n\nz`)
    wrapper.unmount()
  })
})
