// 审查复现：startRunViaSocket 把任何 terminal !== false 的 session.command 当作终态，
// 服务端 /title 成功回执不带 terminal 字段 → 活跃 run 的监听被拆掉，后续 message.delta 丢失
import { beforeEach, describe, expect, it, vi } from 'vitest'

const socketState = vi.hoisted(() => ({ sockets: [] as any[] }))

vi.mock('socket.io-client', () => {
  function createSocket() {
    const listeners = new Map<string, Set<(...args: any[]) => void>>()
    const add = (e: string, h: any) => { if (!listeners.has(e)) listeners.set(e, new Set()); listeners.get(e)!.add(h) }
    const remove = (e: string, h: any) => { listeners.get(e)?.delete(h) }
    const socket: any = {
      connected: true,
      on: vi.fn((e: string, h: any) => { add(e, h); return socket }),
      off: vi.fn((e: string, h: any) => { remove(e, h); return socket }),
      removeListener: vi.fn((e: string, h: any) => { remove(e, h); return socket }),
      removeAllListeners: vi.fn(() => { listeners.clear(); return socket }),
      emit: vi.fn(),
      disconnect: vi.fn(() => { socket.connected = false }),
      __listenerCount: (e: string) => listeners.get(e)?.size || 0,
      __trigger: (e: string, ...args: any[]) => {
        if (e === 'connect') socket.connected = true
        if (e === 'disconnect') socket.connected = false
        for (const h of [...(listeners.get(e) || [])]) h(...args)
      },
    }
    return socket
  }
  return { io: vi.fn(() => { const s = createSocket(); socketState.sockets.push(s); return s }) }
})

vi.mock('../../packages/client/src/api/client', () => ({ getApiKey: () => 'test-token', getBaseUrlValue: () => '' }))

import { startRunViaSocket, registerSessionHandlers, disconnectChatRun } from '../../packages/client/src/api/studio/chat'

describe('startRunViaSocket terminal handling of session.command', () => {
  beforeEach(() => { socketState.sockets.length = 0; disconnectChatRun() })

  it('/title success (no terminal field) during a live run tears down the stream', () => {
    const onEvent = vi.fn()
    const onDone = vi.fn()
    startRunViaSocket({ input: 'hi', session_id: 's1', profile: 'default' }, onEvent, onDone, vi.fn())
    const socket = socketState.sockets[0]
    socket.__trigger('run.started', { event: 'run.started', session_id: 's1', run_id: 'r1' })
    socket.__trigger('message.delta', { event: 'message.delta', session_id: 's1', delta: 'part 1 ' })
    // 服务端 session-command.ts:726 /title 成功回执：无 terminal 字段
    socket.__trigger('session.command', { event: 'session.command', session_id: 's1', command: 'title', ok: true, action: 'title', title: 'New', message: 'Title updated: New' })
    socket.__trigger('message.delta', { event: 'message.delta', session_id: 's1', delta: 'part 2' })
    socket.__trigger('run.completed', { event: 'run.completed', session_id: 's1', output: 'part 1 part 2' })

    const deltas = onEvent.mock.calls.map(c => c[0]).filter(e => e.event === 'message.delta').map(e => e.delta)
    // 记录实际行为
    console.log('deltas received:', deltas, 'onDone calls:', onDone.mock.calls.length,
      'run.completed received:', onEvent.mock.calls.some(c => c[0].event === 'run.completed'))
    expect(deltas).toEqual(['part 1 ', 'part 2'])
  })

  it('resume-path handlers (registerSessionHandlers) never re-emit resume after a transient reconnect', () => {
    const noop = vi.fn()
    // 先建立 socket（模拟 switchSession 已连接）
    startRunViaSocket({ input: 'x', session_id: 'warm', profile: 'default' }, noop, noop, noop)
    const socket = socketState.sockets[0]
    socket.__trigger('run.completed', { event: 'run.completed', session_id: 'warm' })
    socket.emit.mockClear()
    registerSessionHandlers('s2', {
      onMessageDelta: noop, onMessageInterim: noop, onReasoningDelta: noop, onThinkingDelta: noop, onReasoningAvailable: noop,
      onToolStarted: noop, onToolCompleted: noop, onRunStarted: noop, onRunCompleted: noop, onRunFailed: noop,
      onCompressionStarted: noop, onCompressionCompleted: noop, onAbortStarted: noop, onAbortCompleted: noop, onUsageUpdated: noop,
    })
    socket.__trigger('disconnect', 'transport close')
    socket.__trigger('connect')
    const resumes = socket.emit.mock.calls.filter(c => c[0] === 'resume')
    console.log('resume emits after reconnect on resume-path:', resumes.length)
    expect(resumes.length).toBeGreaterThan(0)
  })
})
