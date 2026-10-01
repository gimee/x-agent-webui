// @vitest-environment jsdom
// hermes-v050:U16 — 组件里写死的英文提示改走 i18n（行为测试，真实 zh 语言包）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/i18n/locales/en'
import zh from '@/i18n/locales/zh'
import { mergeMessagesWithFallback } from '@/i18n/messages'
import ThemeSwitch from '@/components/layout/ThemeSwitch.vue'
import DesktopTitleBar from '@/components/layout/DesktopTitleBar.vue'

const zhI18n = () => createI18n({ legacy: false, locale: 'zh', fallbackLocale: 'en', messages: { en, zh: mergeMessagesWithFallback(en, zh) } })

describe('hermes-v050:U16-T13 theme switch titles', () => {
  it('uses the theme page wording instead of Ink style / Comic style / Light mode / Dark mode', () => {
    document.documentElement.classList.remove('dark', 'comic')
    const wrapper = mount(ThemeSwitch, { global: { plugins: [zhI18n()] } })
    const titles = wrapper.findAll('button.theme-switch').map(node => node.attributes('title'))
    expect(titles.length).toBe(2)
    for (const title of titles) expect(title).toMatch(/^(水墨|漫画|浅色|深色)$/)
    expect(titles.join(' ')).not.toMatch(/style|mode/)
  })
})

describe('hermes-v050:U16-T30 desktop window controls', () => {
  afterEach(() => {
    delete (window as any).hermesDesktop
  })

  it('labels the window buttons in the UI language', async () => {
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { platform: 'win32', getWindowState: vi.fn().mockResolvedValue({ isMaximized: false }), windowControl: vi.fn() },
    })
    const wrapper = mount(DesktopTitleBar, { global: { plugins: [zhI18n()] } })
    await flushPromises()
    expect(wrapper.findAll('.desktop-window-btn').map(node => node.attributes('aria-label'))).toEqual(['最小化', '最大化', '关闭'])
  })
})
