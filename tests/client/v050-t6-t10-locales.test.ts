// hermes-v050:T6/T10 — 新增的 chat.hermesCommand.* / chat.errors.* 在 11 个语言包里齐全：
// 占位符与 en 一致；zh、zh-TW 为中文；其余 8 个给英文原文；任何文案都不出现「Claude Code」。
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

const HERMES_COMMAND_KEYS = [
  'skillUsage', 'bundlesUsage', 'bundlesCreateHint', 'skillFailed', 'bundleFailed', 'bundleNotFound', 'skillIsBundle',
  'unknownCommand', 'bridgeCommandUnsupported', 'learnFailed', 'learnUnavailable', 'moaUsage', 'moaQueued',
  'usage', 'context', 'status', 'statusWithBridge', 'stateRunning', 'stateIdle',
  'yoloUnavailable', 'yoloOn', 'yoloOff', 'yoloFailed', 'abortRequested',
  'queueUsage', 'queueIdle', 'queueQueued', 'planFailed', 'planUnavailable',
  'goalBusy', 'goalFailed', 'goalTurnProgress', 'goalTurnRunning', 'goalRun', 'goalRunWithId',
  'clearBusy', 'clearHistoryDone', 'clearDisplayDone', 'titleUsage', 'titleUpdated', 'titleNotFound',
  'compressBusy', 'compressDone', 'compressFailed',
  'branchBusy', 'branchCodingAgent', 'branchEmpty', 'branchDone',
  'steerUsage', 'steerIdle', 'steerSent',
  'mcpReloadBusy', 'mcpReloaded', 'mcpReloadedAll', 'mcpReloadFailed',
  'skillsReloadBusy', 'skillsReloaded', 'skillsNoChanges', 'skillsNoChangesTotal', 'skillsAdded', 'skillsRemoved',
  'skillsTotal', 'skillsReloadFailed', 'skillsReloadUnsupported',
  'destroyDone', 'destroyDoneStopped', 'destroyUnreachable', 'destroyUnreachableWithError',
]

const CHAT_ERROR_KEYS = [
  'hermesRuntimeNotInstalled', 'hermesRuntimeUnavailable', 'agentBridgeUnreachable', 'agentBridgeStatusUnconfirmed',
  'codingAgentExited', 'codingAgentExitedWithDetail', 'exitCodeUnknown', 'codingAgentRunFailed', 'claudeApiError', 'codexRunFailed',
]

const placeholders = (value: string) => [...value.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort()
const CJK = /[一-鿿]/

function groups() {
  return [
    { path: 'chat.hermesCommand', keys: HERMES_COMMAND_KEYS, pick: (messages: any) => messages.chat?.hermesCommand },
    { path: 'chat.errors', keys: CHAT_ERROR_KEYS, pick: (messages: any) => messages.chat?.errors },
  ]
}

describe('hermes-v050:T6/T10 locale coverage', () => {
  it('defines every new key in all 11 locales with the English placeholders', () => {
    for (const group of groups()) {
      const english = group.pick(en)
      expect(english, `${group.path} in en`).toBeTruthy()
      expect(Object.keys(english).sort()).toEqual([...group.keys].sort())
      for (const [locale, messages] of Object.entries(locales)) {
        const table = group.pick(messages)
        expect(table, `${group.path} in ${locale}`).toBeTruthy()
        for (const key of group.keys) {
          expect(typeof table[key], `${locale} ${group.path}.${key}`).toBe('string')
          expect(placeholders(table[key]), `${locale} ${group.path}.${key}`).toEqual(placeholders(english[key]))
        }
      }
    }
  })

  it('gives Chinese copy in zh / zh-TW and the English original elsewhere', () => {
    for (const group of groups()) {
      const english = group.pick(en)
      for (const key of group.keys) {
        for (const locale of ['zh', 'zh-TW']) {
          const value = group.pick(locales[locale])[key]
          // A few values are brand words or symbols only (e.g. none today); every current key is prose.
          expect(value, `${locale} ${group.path}.${key}`).not.toBe(english[key])
          expect(CJK.test(value), `${locale} ${group.path}.${key} = ${value}`).toBe(true)
        }
        for (const locale of englishCopies) {
          expect(group.pick(locales[locale])[key], `${locale} ${group.path}.${key}`).toBe(english[key])
        }
      }
    }
  })

  it('never writes the Claude Code brand into client copy', () => {
    for (const group of groups()) {
      for (const [locale, messages] of Object.entries(locales)) {
        for (const value of Object.values(group.pick(messages) as Record<string, string>)) {
          expect(value, locale).not.toMatch(/Claude\s*Code/i)
        }
      }
    }
  })

  it('does not collide with the chat.commandResult / chat.commandStatus keys of the other line', () => {
    expect((en as any).chat.hermesCommand.commandResult).toBeUndefined()
    expect((en as any).chat.errors.errorWithMessage).toBeUndefined()
  })
})
