// hermes-v051:C ccCompression.* (Agent 管理 → Claude → 压缩设置) in all 11 locales: zh / zh-TW in Chinese,
// the other eight carry the English original; placeholders match en; no "Claude Code" brand in the copy.
import { describe, expect, it } from 'vitest'
import en from '@/i18n/locales/en'
import zh from '@/i18n/locales/zh'
import zhTW from '@/i18n/locales/zh-TW'
import ja from '@/i18n/locales/ja'
import ko from '@/i18n/locales/ko'
import fr from '@/i18n/locales/fr'
import es from '@/i18n/locales/es'
import de from '@/i18n/locales/de'
import pt from '@/i18n/locales/pt'
import ru from '@/i18n/locales/ru'
import ar from '@/i18n/locales/ar'

const locales: Record<string, any> = { en, zh, 'zh-TW': zhTW, ja, ko, fr, es, de, pt, ru, ar }
const englishCopies = ['ja', 'ko', 'fr', 'es', 'de', 'pt', 'ru', 'ar']
const KEYS = ['button', 'title', 'followMain', 'followMainHint']
const CJK = /[一-鿿]/
const placeholders = (value: string) => [...value.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort()

describe('hermes-v051:C ccCompression locales', () => {
  it('defines exactly the new keys in every locale', () => {
    expect(Object.keys(en.ccCompression).sort()).toEqual([...KEYS].sort())
    for (const [locale, messages] of Object.entries(locales)) {
      for (const key of KEYS) {
        const value = messages.ccCompression?.[key]
        expect(typeof value, `${locale} ccCompression.${key}`).toBe('string')
        expect(placeholders(value), `${locale} ccCompression.${key}`).toEqual(placeholders((en as any).ccCompression[key]))
        expect(value, `${locale} ccCompression.${key}`).not.toContain('Claude Code')
      }
    }
  })

  it('zh / zh-TW are Chinese, the rest copy English', () => {
    for (const key of KEYS) {
      for (const locale of ['zh', 'zh-TW']) {
        expect(CJK.test(locales[locale].ccCompression[key]), `${locale} ${key}`).toBe(true)
      }
      for (const locale of englishCopies) {
        expect(locales[locale].ccCompression[key], `${locale} ${key}`).toBe((en as any).ccCompression[key])
      }
    }
    expect(zh.ccCompression).toEqual({
      button: '压缩设置',
      title: 'Claude 压缩设置',
      followMain: '与主设置同步',
      followMainHint: '打开后一直使用「设置 → 上下文压缩」的值，主设置改了 Claude 下一条消息生效',
    })
  })

  it('sits right after the reasoning-effort namespace in the locales that have it', () => {
    for (const messages of [en, zh, zhTW]) {
      const keys = Object.keys(messages)
      expect(keys.indexOf('ccCompression')).toBe(keys.indexOf('ccEffort') + 1)
    }
  })
})
