// @vitest-environment jsdom
// hermes-v050:T10 — run.failed / run.reattach_failed 按 error_code 映射到 chat.errors.*（退出码、原始详情作参数）；
// 没有 code、未知 code、没有 app i18n 时照旧显示服务端英文。错误气泡的前缀由另一条线负责，这里只保证传入的是译文。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import en from '@/i18n/locales/en'
import zh from '@/i18n/locales/zh'
import zhTW from '@/i18n/locales/zh-TW'
import { mergeMessagesWithFallback } from '@/i18n/messages'

const chatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(),
  resumeSession: vi.fn(),
  registerSessionHandlers: vi.fn(),
}))

vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: chatApi.startRunViaSocket,
  resumeSession: chatApi.resumeSession,
  registerSessionHandlers: chatApi.registerSessionHandlers,
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
  onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))
vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'default', hasApiKey: () => false }))
vi.mock('@/api/studio/sessions', () => ({
  archiveSession: vi.fn(), deleteSession: vi.fn(), fetchSession: vi.fn(), fetchSessions: vi.fn(async () => []),
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []), fetchWorkspaceRunChangeFile: vi.fn(async () => null), setSessionModel: vi.fn(),
}))
vi.mock('@/api/studio/download', () => ({ getDownloadUrl: (_p: string, name: string) => `/download/${name}` }))
vi.mock('@/utils/completion-sound', () => ({ primeCompletionSound: vi.fn(), playCompletionSound: vi.fn() }))

import { formatRunErrorText, runErrorForDisplay } from '@/utils/hermes/run-error-text'
import { useChatStore, type Session } from '@/stores/hermes/chat'

function i18nFor(locale: 'zh' | 'en' | 'zh-TW') {
  return createI18n({
    legacy: false, locale, fallbackLocale: 'en',
    messages: { en, zh: mergeMessagesWithFallback(en, zh), 'zh-TW': mergeMessagesWithFallback(en, zhTW) },
  })
}
const zhT = i18nFor('zh').global.t as any
const twT = i18nFor('zh-TW').global.t as any
const enT = i18nFor('en').global.t as any

// Server English error (unchanged) → code + params the server adds.
const errors: Array<[string, Record<string, unknown> | undefined, string, string]> = [
  ['agent_bridge_unreachable', { detail: 'bridge offline' }, 'Agent Bridge is not reachable: bridge offline', 'Agent Bridge 无法连接：bridge offline'],
  ['hermes_runtime_unavailable', { detail: 'Runtime 0.21.0 is missing python/run_agent.py' },
    'Hermes Runtime is unavailable: Runtime 0.21.0 is missing python/run_agent.py', 'Hermes Runtime 不可用：Runtime 0.21.0 is missing python/run_agent.py'],
  ['hermes_runtime_not_installed', undefined,
    'Hermes Runtime is unavailable: Hermes Runtime is not installed or is incomplete. Open Runtime Manager to repair or download a Runtime.',
    'Hermes Runtime 不可用：未安装或安装不完整。请打开「版本管理」修复或下载 Runtime。'],
  ['agent_bridge_status_unconfirmed', { detail: 'connect ECONNREFUSED configured endpoint' },
    'Unable to confirm Agent Bridge status while resuming: connect ECONNREFUSED configured endpoint',
    '恢复会话时无法确认 Agent Bridge 状态：connect ECONNREFUSED configured endpoint'],
  ['coding_agent_exited', { agent: 'claude-code', exit_code: 2 }, 'Claude Code exited with code 2', 'Claude 进程已退出（退出码：2）'],
  ['coding_agent_exited', { agent: 'pi', exit_code: 1, detail: 'Traceback' }, 'Pi exited with code 1: Traceback', 'Pi 进程已退出（退出码：1）：Traceback'],
  ['coding_agent_exited', { agent: 'codex', exit_code: null }, 'Codex exited with code unknown', 'Codex 进程已退出（退出码：未知）'],
  ['coding_agent_run_failed', undefined, 'Coding agent run failed', '编程工具运行失败'],
  ['claude_api_error', undefined, 'Claude Code API error', 'Claude API 错误'],
  ['codex_run_failed', undefined, 'Codex run failed', 'Codex 运行失败'],
]

const event = (code: string | undefined, params: Record<string, unknown> | undefined, error: string) => ({
  event: 'run.failed', session_id: 's1', error, ...(code ? { error_code: code } : {}), ...(params ? { error_params: params } : {}),
})

describe('hermes-v050:T10 formatRunErrorText', () => {
  it('maps every code to chat.errors.* in Chinese', () => {
    for (const [code, params, english, chinese] of errors) {
      expect(formatRunErrorText(event(code, params, english), zhT), code).toBe(chinese)
      const tw = formatRunErrorText(event(code, params, english), twT)
      expect(tw, code).toBeTruthy()
      expect(tw, code).not.toBe(english)
    }
  })

  it('reproduces the English text in English, but never names the Claude Code brand', () => {
    for (const [code, params, english] of errors) {
      const text = formatRunErrorText(event(code, params, english), enT)
      expect(text).not.toMatch(/Claude Code/)
      expect(text).toBe(english.replace('Claude Code', 'Claude'))
    }
  })

  it('returns null for missing / unknown codes and incomplete params', () => {
    expect(formatRunErrorText(undefined, zhT)).toBeNull()
    expect(formatRunErrorText({ error: 'boom' }, zhT)).toBeNull()
    expect(formatRunErrorText(event('from_the_future', undefined, 'x'), zhT)).toBeNull()
    expect(formatRunErrorText(event('agent_bridge_unreachable', undefined, 'x'), zhT)).toBeNull()
    expect(formatRunErrorText(event('coding_agent_exited', { agent: 'someone', exit_code: 1 }, 'x'), zhT)).toBeNull()
    expect(formatRunErrorText(event('coding_agent_exited', { agent: 'pi', exit_code: 'one' }, 'x'), zhT)).toBeNull()
  })
})

describe('hermes-v050:T10 runErrorForDisplay (store side)', () => {
  it('keeps the server error when no app i18n is installed', () => {
    setActivePinia(createPinia())
    expect(runErrorForDisplay(event('agent_bridge_unreachable', { detail: 'x' }, 'Agent Bridge is not reachable: x'))).toBe('Agent Bridge is not reachable: x')
    expect(runErrorForDisplay({ error: { message: 'raw object' } })).toEqual({ message: 'raw object' })
    expect(runErrorForDisplay(undefined)).toBeUndefined()
  })
})

describe('hermes-v050:T10 chat store shows the translated error', () => {
  let handlers: any

  function installApp(locale: 'zh' | 'en') {
    const app = createApp({})
    const pinia = createPinia()
    app.use(i18nFor(locale))
    app.use(pinia)
    setActivePinia(pinia)
  }

  function makeSession(id: string): Session {
    return { id, title: id, messages: [], createdAt: Date.now(), updatedAt: Date.now(), source: 'cli' } as Session
  }

  beforeEach(() => {
    handlers = undefined
    vi.resetAllMocks()
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({ session_id: sessionId, messages: [], isWorking: true, events: [] })
      return {} as any
    })
    chatApi.registerSessionHandlers.mockImplementation((_sid: string, registered: any) => {
      handlers = registered
      return vi.fn()
    })
  })

  it('passes the Chinese error text into the error bubble', async () => {
    installApp('zh')
    const store = useChatStore()
    store.sessions = [makeSession('s1')]
    await store.switchSession('s1')
    handlers.onRunFailed({ ...event('agent_bridge_unreachable', { detail: 'bridge offline' }, 'Agent Bridge is not reachable: bridge offline'), run_id: 'r1' })
    await nextTick()
    const last = store.activeSession!.messages.at(-1)!
    expect(last).toEqual(expect.objectContaining({ role: 'assistant', systemType: 'error' }))
    expect(last.content).toContain('Agent Bridge 无法连接：bridge offline')
    expect(last.content).not.toContain('is not reachable')
  })

  it('keeps the English error for an uncoded failure', async () => {
    installApp('zh')
    const store = useChatStore()
    store.sessions = [makeSession('s2')]
    await store.switchSession('s2')
    handlers.onRunFailed({ event: 'run.failed', session_id: 's2', error: 'API Error: 529 overloaded', run_id: 'r2' })
    await nextTick()
    expect(store.activeSession!.messages.at(-1)!.content).toContain('API Error: 529 overloaded')
  })

  it('translates the reattach warning', async () => {
    installApp('zh')
    const store = useChatStore()
    store.sessions = [makeSession('s3')]
    await store.switchSession('s3')
    handlers.onAgentEvent({
      event: 'run.reattach_failed', session_id: 's3', error: 'connect ECONNREFUSED configured endpoint',
      message: 'Unable to confirm Agent Bridge status while resuming: connect ECONNREFUSED configured endpoint',
      text: 'Unable to confirm Agent Bridge status while resuming: connect ECONNREFUSED configured endpoint',
      error_code: 'agent_bridge_status_unconfirmed', error_params: { detail: 'connect ECONNREFUSED configured endpoint' },
    })
    await nextTick()
    const last = store.activeSession!.messages.at(-1)!
    expect(last.role).toBe('system')
    expect(last.content).toBe('恢复会话时无法确认 Agent Bridge 状态：connect ECONNREFUSED configured endpoint')
  })

  it('keeps the English reattach warning without app i18n', async () => {
    setActivePinia(createPinia())
    const store = useChatStore()
    store.sessions = [makeSession('s4')]
    await store.switchSession('s4')
    handlers.onAgentEvent({
      event: 'run.reattach_failed', session_id: 's4', error: 'x',
      message: 'Unable to confirm Agent Bridge status while resuming: x', text: 'Unable to confirm Agent Bridge status while resuming: x',
      error_code: 'agent_bridge_status_unconfirmed', error_params: { detail: 'x' },
    })
    await nextTick()
    expect(store.activeSession!.messages.at(-1)!.content).toBe('Unable to confirm Agent Bridge status while resuming: x')
  })
})
