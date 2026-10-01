export type LocaleMessages = Record<string, any>

export const supportedLocales = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'de', 'pt', 'ru', 'ar'] as const
export type SupportedLocale = (typeof supportedLocales)[number]
// hermes-v050:C8 键集与 en 完全一致的语言包：启动时不预载英文包（守卫测试 v050-c8-complete-locales-source）
export const COMPLETE_LOCALES: readonly SupportedLocale[] = ['zh']

function isPlainObject(value: unknown): value is LocaleMessages {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function mergeMessagesWithFallback(
  fallback: LocaleMessages,
  locale: LocaleMessages,
): LocaleMessages {
  const merged: LocaleMessages = { ...fallback }

  for (const [key, value] of Object.entries(locale)) {
    const fallbackValue = fallback[key]
    merged[key] = isPlainObject(fallbackValue) && isPlainObject(value)
      ? mergeMessagesWithFallback(fallbackValue, value)
      : value
  }

  return merged
}

const localeLoaders: Record<SupportedLocale, () => Promise<{ default: LocaleMessages }>> = {
  en: () => import('./locales/en'),
  zh: () => import('./locales/zh'),
  'zh-TW': () => import('./locales/zh-TW'),
  ja: () => import('./locales/ja'),
  ko: () => import('./locales/ko'),
  fr: () => import('./locales/fr'),
  es: () => import('./locales/es'),
  de: () => import('./locales/de'),
  pt: () => import('./locales/pt'),
  ru: () => import('./locales/ru'),
  ar: () => import('./locales/ar'),
}

const localeMessagePromises = new Map<SupportedLocale, Promise<LocaleMessages>>()

export function loadLocaleMessages(locale: SupportedLocale): Promise<LocaleMessages> {
  const existing = localeMessagePromises.get(locale)
  if (existing) return existing

  const pending = localeLoaders[locale]()
    .then(module => module.default)
    .catch((error) => {
      localeMessagePromises.delete(locale)
      throw error
    })
  localeMessagePromises.set(locale, pending)
  return pending
}
