// @vitest-environment jsdom
// hermes-v050:F-17 switchLocale 失败要抛给调用方（由语言下拉框提示）；但已被后一次切换取代的那次失败
// 不再抛出（用户已经选了别的语言，不该再弹错误或触发刷新）。
// 为切换语言自动刷新后，如果新选的语言包在启动时仍加载失败，退回刷新前的语言启动，不卡在启动失败页。
import { afterEach, describe, expect, it, vi } from 'vitest'

async function boot(locale: string) {
  localStorage.setItem('hermes_locale', locale)
  vi.resetModules()
  const { i18nReady, switchLocale } = await import('@/i18n')
  const i18n = await i18nReady
  return { i18n, switchLocale }
}

describe('switchLocale failures (F-17)', () => {
  afterEach(() => {
    localStorage.removeItem('hermes_locale')
    sessionStorage.clear()
    vi.doUnmock('@/i18n/locales/ja')
    vi.resetModules()
  })

  it('rejects when the locale bundle cannot be loaded and keeps the current locale', async () => {
    vi.doMock('@/i18n/locales/ja', () => { throw new TypeError('Failed to fetch dynamically imported module: /assets/ja-1.js') })
    const { i18n, switchLocale } = await boot('zh')
    await expect(switchLocale('ja')).rejects.toThrow()
    expect(i18n.global.locale.value).toBe('zh')
    expect(localStorage.getItem('hermes_locale')).toBe('zh')
  })

  it('swallows the failure of a switch that a later switch already superseded', async () => {
    vi.doMock('@/i18n/locales/ja', () => { throw new TypeError('Failed to fetch dynamically imported module: /assets/ja-1.js') })
    const { i18n, switchLocale } = await boot('zh')
    const superseded = switchLocale('ja')
    const latest = switchLocale('en')
    await expect(superseded).resolves.toBeUndefined()
    await latest
    expect(i18n.global.locale.value).toBe('en')
  })

  it('boots in the previous language if the language chosen right before an automatic reload still fails to load', async () => {
    vi.doMock('@/i18n/locales/ja', () => { throw new TypeError('Failed to fetch dynamically imported module: /assets/ja-1.js') })
    sessionStorage.setItem('hermes_locale_reload_at', JSON.stringify({ at: Date.now(), from: 'zh', to: 'ja' }))
    const { i18n } = await boot('ja')
    expect(i18n.global.locale.value).toBe('zh')
    expect(localStorage.getItem('hermes_locale')).toBe('zh')
    expect(document.documentElement.lang).toBe('zh')
  })

  it('still fails the boot for an unrelated locale load failure (no reload mark)', async () => {
    vi.doMock('@/i18n/locales/ja', () => { throw new TypeError('Failed to fetch dynamically imported module: /assets/ja-1.js') })
    localStorage.setItem('hermes_locale', 'ja')
    vi.resetModules()
    const { i18nReady } = await import('@/i18n')
    await expect(i18nReady).rejects.toThrow()
  })
})
