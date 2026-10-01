// @vitest-environment jsdom
// hermes-v050:T6 — Hermes 会话斜杠命令回执按 messageCode 用 i18n 渲染；未知 code、参数不全、没有 code 时回退服务端英文。
// 刷新后从消息行的 command_data 读回 code，仍按界面语言渲染。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import en from '@/i18n/locales/en'
import zh from '@/i18n/locales/zh'
import zhTW from '@/i18n/locales/zh-TW'
import { mergeMessagesWithFallback } from '@/i18n/messages'

const chatApi = vi.hoisted(() => ({
  resumeSession: vi.fn(),
  registerSessionHandlers: vi.fn(),
  sessionCommandHandlers: [] as Array<(event: any) => void>,
}))

vi.mock('naive-ui', () => ({
  NButton: { template: '<button><slot /></button>' },
  NDrawer: { template: '<div><slot /></div>' },
  NDrawerContent: { template: '<div><slot /></div>' },
  NSpin: { template: '<div />' },
  useMessage: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

vi.mock('@/components/hermes/chat/MarkdownRenderer.vue', async () => {
  const { defineComponent } = await import('vue')
  return { default: defineComponent({ name: 'MarkdownRenderer', props: { content: { type: String, default: '' } }, template: '<div class="md-stub">{{ content }}</div>' }) }
})

vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: vi.fn(() => ({ abort: vi.fn() })),
  resumeSession: chatApi.resumeSession,
  registerSessionHandlers: chatApi.registerSessionHandlers,
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn((handler: (event: any) => void) => {
    chatApi.sessionCommandHandlers.push(handler)
    return vi.fn()
  }),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
  onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))

vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'default', hasApiKey: () => false }))
vi.mock('@/api/studio/sessions', () => ({
  archiveSession: vi.fn(), deleteSession: vi.fn(), fetchSession: vi.fn(), fetchSessions: vi.fn(async () => []),
  fetchSessionMessagesPage: vi.fn(), fetchWorkspaceRunChangesForSession: vi.fn(async () => []),
  fetchWorkspaceRunChangeFile: vi.fn(async () => null), setSessionModel: vi.fn(),
}))
vi.mock('@/api/studio/download', () => ({ getDownloadUrl: (_p: string, name: string) => `/download/${name}` }))
vi.mock('@/utils/completion-sound', () => ({ primeCompletionSound: vi.fn(), playCompletionSound: vi.fn() }))

import { formatHermesCommandResultText, hermesCommandDataFields } from '@/utils/hermes/hermes-command-result-text'
import MessageItem from '@/components/hermes/chat/MessageItem.vue'
import { useChatStore, type Message, type Session } from '@/stores/hermes/chat'

function i18nFor(locale: 'zh' | 'en' | 'zh-TW') {
  return createI18n({
    legacy: false, locale, fallbackLocale: 'en',
    messages: { en, zh: mergeMessagesWithFallback(en, zh), 'zh-TW': mergeMessagesWithFallback(en, zhTW) },
  })
}
const zhT = i18nFor('zh').global.t as any
const twT = i18nFor('zh-TW').global.t as any
const enT = i18nFor('en').global.t as any

const YOLO_ON = '⚡ YOLO mode ON for this session — all commands auto-approved. Use with caution.'
const YOLO_OFF = '⚠️ YOLO mode OFF for this session — dangerous commands will require approval.'

// code + params exactly as the server sends them, and the English message the server stores.
const receipts: Array<[string, Record<string, unknown> | undefined, string]> = [
  ['hermes_skill_usage', undefined, 'Usage: /skill <skill-name> [instructions]'],
  ['hermes_bundles_usage', undefined, 'Usage: /bundles <bundle-name> [instructions]'],
  ['hermes_bundles_create_hint', undefined, 'Use /bundles create in X-Agent to open the bundle creator.'],
  ['hermes_skill_failed', { error: 'bridge down' }, 'Skill command failed: bridge down'],
  ['hermes_bundle_failed', { error: 'bridge down' }, 'Bundle command failed: bridge down'],
  ['hermes_bundle_not_found', { name: 'foo' }, '/foo did not resolve to a Bundle.'],
  ['hermes_skill_is_bundle', { name: 'foo' }, '/foo resolved to a Bundle. Use /bundles foo instead.'],
  ['hermes_unknown_command', { name: 'foo' }, 'Unknown bridge command: /foo'],
  ['hermes_bridge_command_unsupported', { name: 'foo' }, 'not a supported bridge command: /foo'],
  ['hermes_learn_failed', { error: 'boom' }, 'Learn command failed: boom'],
  ['hermes_learn_unavailable', undefined, 'Learn command is not available.'],
  ['hermes_moa_usage', undefined, 'Usage: /moa <prompt>'],
  ['hermes_moa_queued', { preset: 'duo' }, 'MoA one-shot queued with preset duo.'],
  ['hermes_usage', { input: 10, output: 20, total: 30 }, 'Usage: input 10, output 20, total 30 tokens.'],
  ['hermes_context', { input: 10, output: 20, total: 30, window: 256000, percent: 0.1 }, 'Context: input 10, output 20, total 30 / 256000 tokens (0.1%).'],
  ['hermes_status', { running: false, source: 'cli', profile: 'default', model: 'test-model', queue: 0, run: '-', bridge: 'idle' },
    'Status: idle, source: cli, profile: default, model: test-model, queue: 0, run: -, bridge: idle'],
  ['hermes_status', { running: true, source: 'cli', profile: 'default', model: '-', queue: 2, run: 'run-9', bridge: null },
    'Status: running, source: cli, profile: default, model: -, queue: 2, run: run-9'],
  ['hermes_yolo_unavailable', undefined, 'YOLO mode is not available in the running Hermes Agent runtime.'],
  ['hermes_yolo_on', undefined, YOLO_ON],
  ['hermes_yolo_off', undefined, YOLO_OFF],
  ['hermes_yolo_failed', { error: 'boom' }, 'YOLO command failed: boom'],
  ['hermes_abort_requested', undefined, 'Abort requested.'],
  ['hermes_queue_usage', undefined, 'Usage: /queue <message>'],
  ['hermes_queue_idle', undefined, 'Session is idle. Send the message normally instead.'],
  ['hermes_queue_queued', { length: 1 }, 'Queued message. Queue length: 1.'],
  ['hermes_plan_failed', { error: 'boom' }, 'Plan command failed: boom'],
  ['hermes_plan_unavailable', undefined, 'Plan command is not available.'],
  ['hermes_goal_busy', undefined, 'Agent is running. Use /goal status, /goal pause, or /goal clear mid-run, or /abort before setting a new goal.'],
  ['hermes_goal_failed', { error: 'boom' }, 'Goal command failed: boom'],
  ['hermes_goal_status', { text: 'Goal: ship (2/5 turns)', running: true, runId: 'run-7', turn: { current: 3, max: 5, used: 2 } },
    'Goal: ship (2/5 turns)\nCurrent turn: 3/5 running (completed turns: 2/5; count updates after the judge).\nRun: running (run-7)'],
  ['hermes_goal_status', { text: 'Goal: ship', running: true, runId: null, turn: null },
    'Goal: ship\nCurrent turn: running (turn count updates after the judge).\nRun: running'],
  ['hermes_goal_status', { text: 'Goal: ship', running: false, runId: null, turn: null }, 'Goal: ship\nRun: idle'],
  ['hermes_clear_busy', undefined, 'Cannot clear history while the bridge run is active. Abort or destroy it first.'],
  ['hermes_clear_history_done', { count: 7 }, 'Cleared 7 history messages from the database.'],
  ['hermes_clear_display_done', undefined, 'Cleared the current display. History in the database was not deleted.'],
  ['hermes_title_usage', undefined, 'Usage: /title <new title>'],
  ['hermes_title_updated', { title: 'Sprint notes' }, 'Title updated: Sprint notes'],
  ['hermes_title_not_found', undefined, 'Session was not found in the database.'],
  ['hermes_compress_busy', undefined, 'Compression can only run while the session is idle.'],
  ['hermes_compress_done', { beforeMessages: 10, resultMessages: 3, beforeTokens: 1000, afterTokens: 200 },
    'Compression completed: 10 -> 3 messages, 1000 -> 200 tokens.'],
  ['hermes_compress_failed', { error: 'summarizer offline' }, 'Compression failed: summarizer offline'],
  ['hermes_branch_busy', undefined, 'Cannot branch while the session is running. Wait for it to finish or use /abort first.'],
  ['hermes_branch_coding_agent', undefined, 'Cannot branch coding agent sessions.'],
  ['hermes_branch_empty', undefined, 'Cannot branch: no conversation messages found to copy.'],
  ['hermes_branch_done', { title: 'Alternate', parent: 'session-1' }, 'Branched session "Alternate" from session-1.'],
  ['hermes_steer_usage', undefined, 'Usage: /steer <instruction>'],
  ['hermes_steer_idle', undefined, 'No active bridge run to steer.'],
  ['hermes_steer_sent', undefined, 'Steer instruction sent.'],
  ['hermes_mcp_reload_busy', undefined, 'MCP reload can only run while the session is idle. Wait for the current run to finish or abort it first.'],
  ['hermes_mcp_reloaded', { server: 'github' }, 'MCP reloaded successfully. Server: github'],
  ['hermes_mcp_reloaded', { server: null }, 'MCP reloaded successfully. All servers.'],
  ['hermes_mcp_reload_failed', { error: 'boom' }, 'MCP reload failed: boom'],
  ['hermes_skills_reload_busy', undefined, 'Skills reload can only run while the session is idle. Wait for the current run to finish or abort it first.'],
  ['hermes_skills_reloaded', { added: [], removed: [], total: 3 }, 'Skills reloaded successfully.\nNo skill changes detected. Total skills: 3.'],
  ['hermes_skills_reloaded', { added: [], removed: [], total: null }, 'Skills reloaded successfully.\nNo skill changes detected.'],
  ['hermes_skills_reloaded', { added: ['deploy: Ship it'], removed: ['old'], total: 4 },
    'Skills reloaded successfully.\nAdded skills:\n- deploy: Ship it\nRemoved skills:\n- old\nTotal skills: 4.'],
  ['hermes_skills_reload_failed', { error: 'disk full' }, 'Skills reload failed: disk full'],
  ['hermes_skills_reload_unsupported', undefined,
    'Skills reload failed: The running Agent Bridge does not support /reload-skills yet. Restart the bridge and try again.'],
  ['hermes_destroy_done', { stoppedRun: false }, 'Destroyed bridge agent.'],
  ['hermes_destroy_done', { stoppedRun: true }, 'Destroyed bridge agent and stopped the active run.'],
  ['hermes_destroy_unreachable', { error: 'ECONNREFUSED' }, 'Bridge agent was not reachable; cleared local session state. (ECONNREFUSED)'],
  ['hermes_destroy_unreachable', { error: null }, 'Bridge agent was not reachable; cleared local session state.'],
]

const data = (code: string, params?: Record<string, unknown>) => (params ? { messageCode: code, messageParams: params } : { messageCode: code })
const CJK = /[一-鿿]/

describe('hermes-v050:T6 formatHermesCommandResultText', () => {
  it('reproduces the server English message exactly in English for every code', () => {
    for (const [code, params, english] of receipts) {
      expect(formatHermesCommandResultText(data(code, params), enT), code).toBe(english)
    }
  })

  it('renders every code in Chinese (zh and zh-TW)', () => {
    for (const [code, params, english] of receipts) {
      for (const t of [zhT, twT]) {
        const text = formatHermesCommandResultText(data(code, params), t)
        expect(text, code).toBeTruthy()
        expect(text, code).not.toBe(english)
        expect(CJK.test(String(text)), `${code}: ${text}`).toBe(true)
      }
    }
  })

  it('uses the existing Chinese terms', () => {
    expect(formatHermesCommandResultText(data('hermes_queue_queued', { length: 2 }), zhT)).toBe('消息已加入队列，当前队列长度：2。')
    expect(formatHermesCommandResultText(data('hermes_abort_requested'), zhT)).toBe('已请求停止当前 Bridge 运行。')
    expect(formatHermesCommandResultText(data('hermes_compress_done', { beforeMessages: 10, resultMessages: 3, beforeTokens: 1000, afterTokens: 200 }), zhT))
      .toBe('上下文压缩完成：10 → 3 条消息，1000 → 200 tokens。')
    expect(formatHermesCommandResultText(data('hermes_compress_failed', { error: 'summarizer offline' }), zhT)).toBe('上下文压缩失败：summarizer offline')
    expect(formatHermesCommandResultText(data('hermes_title_updated', { title: 'Sprint notes' }), zhT)).toBe('标题已更新：Sprint notes')
    expect(formatHermesCommandResultText(data('hermes_clear_history_done', { count: 7 }), zhT)).toBe('已从数据库删除 7 条历史消息。')
    expect(formatHermesCommandResultText(data('hermes_usage', { input: 10, output: 20, total: 30 }), zhT)).toBe('用量：输入 10，输出 20，合计 30 tokens。')
    expect(formatHermesCommandResultText(data('hermes_context', { input: 10, output: 20, total: 30, window: 256000, percent: 0 }), zhT))
      .toBe('上下文：输入 10，输出 20，合计 30 / 256000 tokens（0%）。')
    expect(formatHermesCommandResultText(data('hermes_status', { running: false, source: 'cli', profile: 'default', model: 'm', queue: 0, run: '-', bridge: 'running' }), zhT))
      .toBe('状态：空闲，来源：cli，配置：default，模型：m，队列：0，运行：-，Bridge：运行中')
    expect(formatHermesCommandResultText(data('hermes_steer_sent'), zhT)).toBe('引导文本已发送。')
    expect(formatHermesCommandResultText(data('hermes_yolo_on'), zhT)).toBe('⚡ 已为当前会话开启 YOLO 模式：所有命令自动批准，请谨慎使用。')
    expect(formatHermesCommandResultText(data('hermes_skills_reloaded', { added: ['deploy: Ship it'], removed: [], total: 4 }), zhT))
      .toBe('技能重载成功。\n新增技能：\n- deploy: Ship it\n技能总数：4。')
    expect(formatHermesCommandResultText(data('hermes_goal_status', { text: 'Goal: ship', running: false, runId: null, turn: null }), zhT))
      .toBe('Goal: ship\n运行：空闲')
    expect(formatHermesCommandResultText(data('hermes_unknown_command', { name: 'foo' }), zhT)).toBe('未知的 Bridge 命令：/foo')
    expect(formatHermesCommandResultText(data('hermes_queue_queued', { length: 2 }), twT)).toBe('訊息已加入佇列，目前佇列長度：2。')
  })

  it('returns null (server English wins) for unknown codes, other lines\' codes, and incomplete params', () => {
    expect(formatHermesCommandResultText(undefined, zhT)).toBeNull()
    expect(formatHermesCommandResultText(null, zhT)).toBeNull()
    expect(formatHermesCommandResultText({}, zhT)).toBeNull()
    expect(formatHermesCommandResultText({ message: 'Abort requested.' }, zhT)).toBeNull()
    expect(formatHermesCommandResultText(data('hermes_from_the_future'), zhT)).toBeNull()
    expect(formatHermesCommandResultText({ messageCode: 'compact_sent', agentId: 'claude' }, zhT)).toBeNull()
    expect(formatHermesCommandResultText({ messageCode: 'context', inputTokens: 1 }, zhT)).toBeNull()
    expect(formatHermesCommandResultText(data('hermes_queue_queued'), zhT)).toBeNull()
    expect(formatHermesCommandResultText(data('hermes_queue_queued', { length: 'two' }), zhT)).toBeNull()
    expect(formatHermesCommandResultText(data('hermes_usage', { input: 10, output: 20 }), zhT)).toBeNull()
    expect(formatHermesCommandResultText(data('hermes_title_updated', {}), zhT)).toBeNull()
    expect(formatHermesCommandResultText(data('hermes_skills_reloaded', { added: 'x', removed: [] }), zhT)).toBeNull()
    expect(formatHermesCommandResultText(data('hermes_goal_status', { running: true }), zhT)).toBeNull()
  })
})

describe('hermes-v050:T6 hermesCommandDataFields (persisted command_data)', () => {
  it('parses the stored JSON into commandData', () => {
    expect(hermesCommandDataFields(JSON.stringify({ messageCode: 'hermes_queue_queued', messageParams: { length: 2 } })))
      .toEqual({ commandData: { messageCode: 'hermes_queue_queued', messageParams: { length: 2 } } })
    expect(hermesCommandDataFields({ messageCode: 'hermes_abort_requested' })).toEqual({ commandData: { messageCode: 'hermes_abort_requested' } })
  })

  it('ignores missing, broken or foreign data', () => {
    expect(hermesCommandDataFields(undefined)).toEqual({})
    expect(hermesCommandDataFields(null)).toEqual({})
    expect(hermesCommandDataFields('')).toEqual({})
    expect(hermesCommandDataFields('{not json')).toEqual({})
    expect(hermesCommandDataFields('[1,2]')).toEqual({})
    expect(hermesCommandDataFields(JSON.stringify({ messageParams: { length: 2 } }))).toEqual({})
  })
})

describe('hermes-v050:T6 MessageItem renders coded Hermes receipts', () => {
  beforeEach(() => setActivePinia(createPinia()))

  function mountItem(message: Message, locale: 'zh' | 'en' = 'zh') {
    return mount(MessageItem, { props: { message }, global: { plugins: [i18nFor(locale)] } })
  }

  it('shows the Chinese receipt for a coded message and keeps the English text without a code', async () => {
    const coded = mountItem({
      id: 'c1', role: 'command', content: 'Queued message. Queue length: 2.', timestamp: 1, systemType: 'command', commandAction: 'queue',
      commandData: { action: 'queue', message: 'Queued message. Queue length: 2.', messageCode: 'hermes_queue_queued', messageParams: { length: 2 } },
    })
    await flushPromises()
    expect(coded.findAll('.command-result')).toHaveLength(1)
    expect(coded.get('.command-result').text()).toContain('消息已加入队列，当前队列长度：2。')
    expect(coded.text()).not.toContain('Queued message')

    const legacy = mountItem({ id: 'c2', role: 'command', content: 'Queued message. Queue length: 2.', timestamp: 2, systemType: 'command' })
    await flushPromises()
    expect(legacy.get('.command-result').text()).toContain('Queued message. Queue length: 2.')

    const unknown = mountItem({
      id: 'c3', role: 'command', content: 'Something new.', timestamp: 3, systemType: 'command',
      commandData: { messageCode: 'hermes_from_the_future' },
    })
    await flushPromises()
    expect(unknown.get('.command-result').text()).toContain('Something new.')
  })

  it('shows the same English text in English', async () => {
    const wrapper = mountItem({
      id: 'c4', role: 'command', content: 'Abort requested.', timestamp: 1, systemType: 'command',
      commandData: { messageCode: 'hermes_abort_requested' },
    }, 'en')
    await flushPromises()
    expect(wrapper.get('.command-result').text()).toContain('Abort requested.')
  })

  it('keeps the live /status card and renders a reloaded /status row as text', async () => {
    const live = mountItem({
      id: 's1', role: 'command', content: 'Status: idle, source: cli', timestamp: 1, systemType: 'command', commandAction: 'status',
      commandData: {
        isWorking: false, source: 'cli', profile: 'default', model: 'm', queueLength: 0,
        messageCode: 'hermes_status', messageParams: { running: false, source: 'cli', profile: 'default', model: 'm', queue: 0, run: '-', bridge: null },
      },
    })
    await flushPromises()
    expect(live.find('.command-status').exists()).toBe(true)
    expect(live.findAll('.command-result')).toHaveLength(1)

    const reloaded = mountItem({
      id: 's2', role: 'command', content: 'Status: idle, source: cli, profile: default, model: m, queue: 0, run: -', timestamp: 1, systemType: 'command',
      commandData: { messageCode: 'hermes_status', messageParams: { running: false, source: 'cli', profile: 'default', model: 'm', queue: 0, run: '-', bridge: null } },
    })
    await flushPromises()
    expect(reloaded.find('.command-status').exists()).toBe(false)
    expect(reloaded.get('.command-result').text()).toContain('状态：空闲，来源：cli，配置：default，模型：m，队列：0，运行：-')
  })
})

describe('hermes-v050:T6 chat store keeps the code live and after a reload', () => {
  function makeSession(): Session {
    return { id: 'session-1', title: 'session', messages: [], createdAt: Date.now(), updatedAt: Date.now(), source: 'cli' } as Session
  }

  beforeEach(() => {
    vi.clearAllMocks()
    chatApi.sessionCommandHandlers = []
    setActivePinia(createPinia())
  })

  it('stores the live session.command event (with its code) as commandData', () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session
    chatApi.sessionCommandHandlers[0]({
      event: 'session.command', session_id: 'session-1', command: 'queue', action: 'queue', ok: true, terminal: false,
      message: 'Queued message. Queue length: 1.', messageCode: 'hermes_queue_queued', messageParams: { length: 1 }, queueLength: 1,
    })
    const receipt = store.messages.find(message => message.content === 'Queued message. Queue length: 1.')
    expect(receipt?.commandData).toEqual(expect.objectContaining({ messageCode: 'hermes_queue_queued', messageParams: { length: 1 } }))
  })

  it('reads command_data back from persisted rows on resume and renders them in Chinese', async () => {
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (payload: any) => void) => {
      onResumed({
        session_id: sessionId,
        messages: [
          { id: 11, session_id: sessionId, role: 'command', content: '/queue later', timestamp: 10, command_data: null },
          {
            id: 12, session_id: sessionId, role: 'command', content: 'Queued message. Queue length: 1.', timestamp: 11,
            command_data: JSON.stringify({ messageCode: 'hermes_queue_queued', messageParams: { length: 1 } }),
          },
          { id: 13, session_id: sessionId, role: 'command', content: 'Abort requested.', timestamp: 12 },
        ],
        messageTotal: 3, messageLoadedCount: 3, hasMoreBefore: false, isWorking: false, events: [],
      })
      return {} as any
    })
    const store = useChatStore()
    store.sessions = [makeSession()]
    await store.switchSession('session-1')
    const messages = store.activeSession!.messages
    const echo = messages.find(message => message.content === '/queue later')!
    const coded = messages.find(message => message.content === 'Queued message. Queue length: 1.')!
    const legacy = messages.find(message => message.content === 'Abort requested.')!
    expect(echo.commandData).toBeUndefined()
    expect(legacy.commandData).toBeUndefined()
    expect(coded.commandData).toEqual({ messageCode: 'hermes_queue_queued', messageParams: { length: 1 } })

    const wrapper = mount(MessageItem, { props: { message: coded }, global: { plugins: [i18nFor('zh')] } })
    await flushPromises()
    expect(wrapper.get('.command-result').text()).toContain('消息已加入队列，当前队列长度：1。')
  })
})
