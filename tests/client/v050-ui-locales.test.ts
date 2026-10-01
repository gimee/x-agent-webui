// hermes-v050:U2/U3/U16/U25/U27/U28 — 界面线 C 新增的 locale key 在 11 个 locale 里都存在，
// zh / zh-TW 给中文，其余 8 个给英文原文（仓库现有做法），插值名与 en 一致。
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

const raw: Record<string, Record<string, unknown>> = { en, zh, 'zh-TW': zhTW, ja, ko, fr, es, de, pt, ru, ar }

export const V050_NEW_KEYS = [
  'chat.compression.running',
  'chat.compression.done',
  'chat.compression.doneBeforeOnly',
  'chat.compression.skipped',
  'chat.abort.pausing',
  'chat.abort.stillStopping',
  'chat.abort.pausedSynced',
  'chat.commandResult.compactSent',
  'chat.commandResult.compactNoChange',
  'chat.commandResult.compactDone',
  'chat.commandResult.compactDoneBefore',
  'chat.commandResult.compactDoneBeforeAfter',
  'chat.commandResult.compactFailed',
  'chat.commandResult.context',
  'chat.commandResult.contextPi',
  'chat.commandResult.usage',
  'chat.commandResult.usagePi',
  'chat.commandResult.contextFailed',
  'chat.commandResult.usageFailed',
  'chat.commandStatus.status',
  'chat.commandStatus.source',
  'chat.commandStatus.profile',
  'chat.commandStatus.model',
  'chat.commandStatus.queue',
  'chat.commandStatus.run',
  'chat.commandStatus.running',
  'chat.commandStatus.idle',
  'chat.errorWithMessage',
  'chat.agentNoOutput',
  'chat.branchDefaultTitle',
  'chat.completionNotificationBody',
  'chat.uploadFailed',
  'chat.reasoningEffort.tooltipWithValue',
  'sidebar.website',
  'sidebar.a11y.chatActions',
  'sidebar.a11y.conversationType',
  'skills.stats.views',
  'skills.stats.uses',
  'skills.stats.patches',
  'common.yes',
  'common.no',
  'common.menu',
  'models.providerNoModels',
  'kanban.board.fallbackWarning',
  'kanban.detail.taskId',
  'kanban.detail.parents',
  'kanban.detail.children',
  'usage.a11y.tokenTypeLegend',
  'usage.a11y.period',
  'codingAgents.revealSecrets',
  'codingAgents.hideSecrets',
  'session.source.codingAgent',
  'session.source.weixin',
  'session.source.cron',
  'session.source.dingtalk',
  'session.source.wecom',
  'session.source.email',
  'session.source.sms',
  'desktopTitleBar.minimize',
  'desktopTitleBar.restore',
  'desktopTitleBar.maximize',
  'desktopTitleBar.close',
]

function get(messages: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as any)[part] : undefined), messages)
}

const names = (value: string) => [...value.matchAll(/\{([^}]+)\}/g)].map(m => m[1]).sort().join(',')
const CJK = /[一-鿿]/

describe('hermes-v050 界面线 C locale keys', () => {
  it('defines every new key in all 11 raw locales with matching interpolation names', () => {
    const issues: string[] = []
    for (const key of V050_NEW_KEYS) {
      const english = get(en, key)
      if (typeof english !== 'string') { issues.push(`en: ${key} missing`); continue }
      for (const [locale, messages] of Object.entries(raw)) {
        const value = get(messages, key)
        if (typeof value !== 'string') { issues.push(`${locale}: ${key} missing`); continue }
        if (names(value) !== names(english)) issues.push(`${locale}: ${key} interpolation mismatch`)
      }
    }
    expect(issues).toEqual([])
  })

  it('gives zh / zh-TW Chinese text and the other locales the English original', () => {
    const issues: string[] = []
    for (const key of V050_NEW_KEYS) {
      const english = get(en, key) as string
      for (const [locale, messages] of Object.entries(raw)) {
        const value = get(messages, key) as string
        if (locale === 'zh' || locale === 'zh-TW') {
          if (!CJK.test(value)) issues.push(`${locale}: ${key} not Chinese`)
        } else if (value !== english) {
          issues.push(`${locale}: ${key} differs from English original`)
        }
      }
    }
    expect(issues).toEqual([])
  })

  it('renames the mobile conversation tab and translates the T29 column/field values in zh and zh-TW', () => {
    expect(get(zh, 'sidebar.singleChat')).toBe('对话')
    expect(get(zhTW, 'sidebar.singleChat')).toBe('對話')
    for (const messages of [zh, zhTW]) {
      expect(CJK.test(String(get(messages, 'models.auxiliaryExtraBody')))).toBe(true)
      expect(CJK.test(String(get(messages, 'settings.webhooks.columns.eventId')))).toBe(true)
      expect(CJK.test(String(get(messages, 'settings.webhooks.columns.deliveryId')))).toBe(true)
    }
  })

  it('hermes-v050:E-07 defines kanban.board.optionLabel in all 11 locales: full-width colons in zh / zh-TW, the English original elsewhere', () => {
    const english = get(en, 'kanban.board.optionLabel')
    expect(english).toBe('{title}: {board} · {tasks}: {count}')
    for (const [locale, messages] of Object.entries(raw)) {
      const value = get(messages, 'kanban.board.optionLabel')
      if (locale === 'zh' || locale === 'zh-TW') expect(value, locale).toBe('{title}：{board} · {tasks}：{count}')
      else expect(value, locale).toBe(english)
    }
  })

  it('never writes the Claude Code brand into new client copy', () => {
    for (const key of V050_NEW_KEYS) {
      for (const messages of Object.values(raw)) {
        expect(String(get(messages, key))).not.toContain('Claude Code')
      }
    }
  })
})
