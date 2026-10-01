import { createI18n } from 'vue-i18n'
import { COMPLETE_LOCALES, loadLocaleMessages, mergeMessagesWithFallback, supportedLocales } from './messages'
import type { SupportedLocale } from './messages'
import { applyDocumentDirection } from './direction'
import { localeBeforeFailedSwitchReload } from './locale-load-recovery'

const saved = localStorage.getItem('hermes_locale')

function resolveLocale(saved: string | null): SupportedLocale {
  if (saved && (supportedLocales as readonly string[]).includes(saved)) {
    return saved as SupportedLocale
  }

  function normalize(tag: string): SupportedLocale | null {
    const lower = tag.toLowerCase()
    if (lower.startsWith('zh')) {
      const isTraditional =
        lower.includes('hant') ||
        lower.includes('-tw') ||
        lower.includes('-hk') ||
        lower.includes('-mo')
      return isTraditional ? 'zh-TW' : 'zh'
    }
    const short = tag.slice(0, 2)
    if ((supportedLocales as readonly string[]).includes(tag)) return tag as SupportedLocale
    if ((supportedLocales as readonly string[]).includes(short)) return short as SupportedLocale
    return null
  }

  for (const lang of navigator.languages) {
    const resolved = normalize(lang)
    if (resolved) return resolved
  }

  return 'en'
}

function setHtmlLang(locale: SupportedLocale) {
  document.documentElement.lang = locale
  applyDocumentDirection(locale)
}

const locale = resolveLocale(saved)
setHtmlLang(locale)

// hermes-v050:C8 完整语言包启动时不带英文；万一缺键（或切到不完整语言），按需补载英文并合并兜底
let englishFallback: Promise<void> | null = null

function ensureEnglishFallback(i18n: { global: unknown }): Promise<void> {
  if (englishFallback) return englishFallback
  const globalI18n = i18n.global as any
  englishFallback = loadLocaleMessages('en').then((englishMessages) => {
    globalI18n.setLocaleMessage('en', englishMessages)
    for (const loaded of globalI18n.availableLocales as string[]) {
      if (loaded === 'en') continue
      globalI18n.setLocaleMessage(loaded, mergeMessagesWithFallback(englishMessages, globalI18n.getLocaleMessage(loaded)))
    }
  }).catch((error) => {
    englishFallback = null
    throw error
  })
  return englishFallback
}

// hermes-v050:F-17 启动语言改为参数：启动失败时可以退回上一种语言再建一次
async function createAppI18n(locale: SupportedLocale) {
  if (locale !== 'en' && COMPLETE_LOCALES.includes(locale)) {
    const localeMessages = await loadLocaleMessages(locale)
    const i18n = createI18n({
      legacy: false,
      locale,
      fallbackLocale: 'en',
      messages: { [locale]: localeMessages },
      fallbackWarn: false,
      missing: () => {
        void ensureEnglishFallback(i18n).catch(() => undefined)
      },
    })
    return i18n
  }

  const englishMessagesPromise = loadLocaleMessages('en')
  const localeMessagesPromise = locale === 'en'
    ? englishMessagesPromise
    : loadLocaleMessages(locale)
  const [englishMessages, localeMessages] = await Promise.all([
    englishMessagesPromise,
    localeMessagesPromise,
  ])
  const initialMessages = locale === 'en'
    ? { en: englishMessages }
    : {
        en: englishMessages,
        [locale]: mergeMessagesWithFallback(englishMessages, localeMessages),
      }

  return createI18n({
    legacy: false,
    locale,
    fallbackLocale: 'en',
    messages: initialMessages,
  })
}

// hermes-v050:F-17 为切换语言自动刷新后，新选的语言包在启动时仍加载失败：退回刷新前的语言启动，
// 不让每次刷新都读到同一个失败的 hermes_locale、卡在启动失败页
export const i18nReady = createAppI18n(locale).catch((error: unknown) => {
  const previous = localeBeforeFailedSwitchReload(locale)
  if (!previous || !(supportedLocales as readonly string[]).includes(previous)) throw error
  const previousLocale = previous as SupportedLocale
  try {
    localStorage.setItem('hermes_locale', previousLocale)
  } catch {
    // 存不下也照样用它启动
  }
  setHtmlLang(previousLocale)
  return createAppI18n(previousLocale)
})

let localeSwitchSequence = 0

export async function switchLocale(newLocale: string): Promise<void> {
  if (!(supportedLocales as readonly string[]).includes(newLocale)) return

  const i18n = await i18nReady
  const globalI18n = i18n.global as any
  const nextLocale = newLocale as SupportedLocale
  const sequence = ++localeSwitchSequence
  if (!(globalI18n.availableLocales as readonly string[]).includes(nextLocale)) {
    // hermes-v050:C8 从完整语言包启动时英文可能还没加载：合并兜底前先补上
    const needsEnglish = nextLocale !== 'en' && !(globalI18n.availableLocales as readonly string[]).includes('en')
    let nextMessages: Awaited<ReturnType<typeof loadLocaleMessages>>
    try {
      ;[nextMessages] = await Promise.all([
        loadLocaleMessages(nextLocale),
        needsEnglish ? ensureEnglishFallback(i18n) : undefined,
      ])
    } catch (error) {
      // hermes-v050:F-17 失败交给调用方提示；已被后一次切换取代的就不再报
      if (sequence !== localeSwitchSequence) return
      throw error
    }
    if (sequence !== localeSwitchSequence) return
    globalI18n.setLocaleMessage(
      nextLocale,
      nextLocale === 'en'
        ? nextMessages
        : mergeMessagesWithFallback(globalI18n.getLocaleMessage('en'), nextMessages),
    )
  }

  if (sequence !== localeSwitchSequence) return
  globalI18n.locale.value = nextLocale
  setHtmlLang(nextLocale)
  localStorage.setItem('hermes_locale', nextLocale)
}
