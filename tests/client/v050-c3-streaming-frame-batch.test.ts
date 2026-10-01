// @vitest-environment jsdom
// hermes-v050:C3 流式 delta 按帧合并通知：store 数据即时、视图通知每帧一次、非 delta 事件前先冲刷。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { watch } from 'vue'

const state = vi.hoisted(() => ({ resume: undefined as undefined | ((data: any) => void), event: undefined as any, handlers: undefined as any }))
vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: vi.fn((_body: any, event: any) => { state.event = event; return { abort: vi.fn() } }),
  resumeSession: vi.fn((_sid: string, cb: (data: any) => void) => { state.resume = cb }),
  registerSessionHandlers: vi.fn((_sid: string, handlers: any) => { state.handlers = handlers }),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(), respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()), onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()), onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))
vi.mock('@/api/studio/sessions', () => ({
  fetchSessions: vi.fn(async () => []), fetchSessionMessagesPage: vi.fn(),
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []), fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  archiveSession: vi.fn(), deleteSession: vi.fn(), setSessionModel: vi.fn(),
  setSessionPushEnabled: vi.fn(), setSessionReasoningEffort: vi.fn(),
}))
vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'default', hasApiKey: vi.fn(() => false) }))
vi.mock('@/api/studio/download', () => ({ getDownloadUrl: (_p: string, n: string) => `/download/${n}` }))
vi.mock('@/utils/completion-sound', () => ({ primeCompletionSound: vi.fn(), playCompletionSound: vi.fn() }))
vi.mock('@/utils/completion-notification', () => ({ showCompletionNotification: vi.fn() }))
vi.mock('@/utils/session-sync', () => ({ subscribeSessionSync: vi.fn(() => vi.fn()), publishSessionSync: vi.fn() }))

import { useChatStore, type Session } from '@/stores/hermes/chat'

const session = (): Session => ({ id: 's1', title: '', messages: [], createdAt: 1, updatedAt: 1, source: 'cli', profile: 'default', messageCount: 0, messageTotal: 0, loadedMessageCount: 0, hasMoreBefore: false })
const wire = (event: string, extra: any = {}) => ({ event, session_id: 's1', run_marker: 'run-1', ...extra })

let frames: FrameRequestCallback[] = []
function runFrame() {
  const queued = frames
  frames = []
  for (const callback of queued) callback(performance.now())
}

async function setup(resumed: boolean) {
  const store = useChatStore()
  const s = session()
  store.sessions = [s]
  store.activeSessionId = s.id
  store.activeSession = s
  if (resumed) {
    const pending = store.switchSession(s.id)
    state.resume!({ session_id: 's1', messages: [], messageTotal: 0, messageLoadedCount: 0, hasMoreBefore: false, isWorking: true, events: [] })
    await pending
  } else {
    await store.sendMessage('probe')
  }
  const names: Record<string, string> = {
    'run.started': 'onRunStarted',
    'message.delta': 'onMessageDelta',
    'reasoning.delta': 'onReasoningDelta',
    'tool.started': 'onToolStarted',
    'run.completed': 'onRunCompleted',
  }
  const event = resumed ? (e: any) => state.handlers[names[e.event]](e) : state.event
  event(wire('run.started'))
  runFrame()
  // 经 store 取响应式代理：视图订阅的就是这些代理
  const live = () => store.sessions.find(item => item.id === 's1')!
  return { store, s, event, live }
}

describe('C3 streaming deltas are coalesced per animation frame', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.resume = undefined
    state.event = undefined
    state.handlers = undefined
    localStorage.clear()
    frames = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  for (const resumed of [false, true]) {
    it(`keeps store data current but notifies views once per frame, resumed=${resumed}`, async () => {
      const { event, live } = await setup(resumed)
      event(wire('message.delta', { delta: 'Hello' }))
      const assistant = () => live().messages.find(m => m.role === 'assistant')!
      const seen: string[] = []
      watch(() => assistant().content, value => { seen.push(value) }, { flush: 'sync' })

      const parts = [' wor', 'ld', ', this', ' is', ' one', ' frame']
      for (const delta of parts) event(wire('message.delta', { delta }))

      // store 自身读到的是完整内容（后续 delta 拼接、边界检测不受影响）
      expect(assistant().content).toBe('Hello world, this is one frame')
      // 视图依赖在本帧内还没被通知
      expect(seen).toEqual([])
      runFrame()
      expect(seen).toEqual(['Hello world, this is one frame'])
      runFrame()
      expect(seen).toHaveLength(1)
    })

    it(`flushes pending deltas before a non-delta event so ordering is preserved, resumed=${resumed}`, async () => {
      const { s, event, live } = await setup(resumed)
      event(wire('message.delta', { delta: 'Partial' }))
      runFrame()
      const assistant = live().messages.find(m => m.role === 'assistant')!
      const observed: Array<[string, boolean | undefined]> = []
      watch(() => [assistant.content, assistant.isStreaming] as const, ([content, streaming]) => {
        observed.push([content, streaming])
      }, { flush: 'sync' })
      event(wire('message.delta', { delta: ' answer' }))
      event(wire('run.completed', { output: 'Partial answer' }))
      expect(observed[0]).toEqual(['Partial answer', true])
      expect(s.messages.filter(m => m.role === 'assistant').map(m => m.content)).toEqual(['Partial answer'])
    })

    it(`coalesces reasoning deltas the same way, resumed=${resumed}`, async () => {
      const { event, live } = await setup(resumed)
      event(wire('reasoning.delta', { delta: 'Think' }))
      const assistant = () => live().messages.find(m => m.role === 'assistant')!
      const seen: Array<string | undefined> = []
      watch(() => assistant().reasoning, value => { seen.push(value) }, { flush: 'sync' })
      for (const delta of ['ing', ' hard', '.']) event(wire('reasoning.delta', { delta }))
      expect(assistant().reasoning).toBe('Thinking hard.')
      expect(seen).toEqual([])
      runFrame()
      expect(seen).toEqual(['Thinking hard.'])
    })
  }

  it('still flushes when animation frames are paused (background tab)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { event, live } = await setup(false)
    event(wire('message.delta', { delta: 'Hidden' }))
    runFrame()
    const assistant = live().messages.find(m => m.role === 'assistant')!
    const seen: string[] = []
    watch(() => assistant.content, value => { seen.push(value) }, { flush: 'sync' })
    event(wire('message.delta', { delta: ' tab' }))
    expect(seen).toEqual([])
    vi.advanceTimersByTime(200)
    expect(seen).toEqual(['Hidden tab'])
  })
})
