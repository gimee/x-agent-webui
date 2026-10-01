// @vitest-environment jsdom
// hermes-v050:C8 语言包：完整的中文包不再预载英文包；不完整的语言照旧并入英文兜底；
// 万一完整包缺了键，按需补载英文并刷新；切到不完整语言前先确保英文已就位。
import { afterEach, describe, expect, it, vi } from 'vitest'

async function boot(locale: string) {
  localStorage.setItem('hermes_locale', locale)
  vi.resetModules()
  const { i18nReady, switchLocale } = await import('@/i18n')
  const i18n = await i18nReady
  return { i18n, switchLocale }
}

describe('C8 locale loading does not block Chinese users on the English bundle', () => {
  afterEach(() => {
    localStorage.removeItem('hermes_locale')
    vi.doUnmock('@/i18n/locales/zh')
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('boots zh with only the zh bundle', async () => {
    const { i18n } = await boot('zh')
    expect(i18n.global.availableLocales).toEqual(['zh'])
    expect(i18n.global.locale.value).toBe('zh')
    expect(i18n.global.t('common.cancel')).toBe('取消')
  })

  it('still merges the English fallback for an incomplete locale', async () => {
    const { i18n } = await boot('zh-TW')
    expect(i18n.global.availableLocales).toEqual(['en', 'zh-TW'])
    expect(i18n.global.t('common.cancel')).not.toBe('common.cancel')
  })

  it('loads English before switching from zh to an incomplete locale', async () => {
    const { i18n, switchLocale } = await boot('zh')
    await switchLocale('ja')
    expect(i18n.global.availableLocales).toEqual(expect.arrayContaining(['zh', 'en', 'ja']))
    const ja = i18n.global.getLocaleMessage('ja') as Record<string, any>
    const en = i18n.global.getLocaleMessage('en') as Record<string, any>
    // ja 合并了英文兜底：英文的每个顶层分组在 ja 里都有
    for (const group of Object.keys(en)) expect(ja).toHaveProperty(group)
  })

  it('switching zh -> en -> zh keeps working', async () => {
    const { i18n, switchLocale } = await boot('zh')
    await switchLocale('en')
    expect(i18n.global.t('common.cancel')).toBe('Cancel')
    await switchLocale('zh')
    expect(i18n.global.t('common.cancel')).toBe('取消')
  })

  it('backfills English lazily if the zh bundle ever lacks a key', async () => {
    vi.doMock('@/i18n/locales/zh', () => ({ default: { common: { cancel: '取消' } } }))
    const { i18n } = await boot('zh')
    expect(i18n.global.availableLocales).toEqual(['zh'])
    // 首次缺键：返回键名并触发按需加载英文
    i18n.global.t('common.confirm')
    await vi.waitFor(() => expect(i18n.global.availableLocales).toEqual(expect.arrayContaining(['en', 'zh'])), { timeout: 5_000 })
    expect(i18n.global.t('common.confirm')).toBe((i18n.global.getLocaleMessage('en') as any).common.confirm)
    expect(i18n.global.t('common.cancel')).toBe('取消')
  })
})
