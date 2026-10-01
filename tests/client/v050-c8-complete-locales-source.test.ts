// hermes-v050:C8 COMPLETE_LOCALES 里的语言启动时不预载英文包，所以它们必须与 en 键集一致（缺键时运行时会补载英文，但不该依赖）。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import en from '@/i18n/locales/en'
import zh from '@/i18n/locales/zh'
import { COMPLETE_LOCALES } from '@/i18n/messages'

const bundles: Record<string, Record<string, unknown>> = { zh }

function missingKeys(reference: Record<string, unknown>, target: unknown, prefix = ''): string[] {
  const missing: string[] = []
  for (const [key, value] of Object.entries(reference)) {
    const path = prefix ? `${prefix}.${key}` : key
    const candidate = target && typeof target === 'object' ? (target as Record<string, unknown>)[key] : undefined
    if (value && typeof value === 'object' && !Array.isArray(value)) missing.push(...missingKeys(value as Record<string, unknown>, candidate, path))
    else if (candidate === undefined) missing.push(path)
  }
  return missing
}

describe('complete locales skip the English preload (C8)', () => {
  it('lists only zh as complete', () => {
    expect([...COMPLETE_LOCALES]).toEqual(['zh'])
  })

  for (const locale of ['zh']) {
    it(`${locale} has every key that en has`, () => {
      expect(missingKeys(en, bundles[locale])).toEqual([])
    })
  }

  it('prefetches the initial route component before waiting for i18n', () => {
    const main = readFileSync('packages/client/src/main.ts', 'utf8')
    const prefetch = main.indexOf('prefetchRouteComponents(router')
    const awaitI18n = main.indexOf('await i18nReady')
    expect(prefetch).toBeGreaterThan(-1)
    expect(awaitI18n).toBeGreaterThan(prefetch)
  })
})
