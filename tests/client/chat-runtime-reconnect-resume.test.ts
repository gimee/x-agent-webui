// review-C-F2: resume-path listeners (registerSessionHandlers / resumeServerWorkingRun)
// must survive a transient socket drop: re-emit `resume` on reconnect, hand the
// snapshot to the store for reconciliation, and release listeners on unregister.
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

import {
  connectChatRun,
  disconnectChatRun,
  registerSessionHandlers,
  unregisterSessionHandlers,
  startRunViaSocket,
} from '../../packages/client/src/api/studio/chat'

function handlerSet(overrides: Record<string, any> = {}) {
  const noop = vi.fn()
  return {
    onMessageDelta: noop, onMessageInterim: noop, onReasoningDelta: noop, onThinkingDelta: noop, onReasoningAvailable: noop,
    onToolStarted: noop, onToolCompleted: noop, onRunStarted: noop, onRunCompleted: noop, onRunFailed: noop,
    onCompressionStarted: noop, onCompressionCompleted: noop, onAbortStarted: noop, onAbortCompleted: noop, onUsageUpdated: noop,
    ...overrides,
  }
}

describe('resume-path reconnect compensation (api layer)', () => {
  beforeEach(() => { socketState.sockets.length = 0; disconnectChatRun() })

  it('re-emits resume after a transient disconnect and forwards the snapshot to onReconnectResume', () => {
    connectChatRun('default')
    const socket = socketState.sockets[0]
    const onReconnectResume = vi.fn()
    registerSessionHandlers('s1', handlerSet({ onReconnectResume }), { profile: 'default' })
    socket.emit.mockClear()

    socket.__trigger('disconnect', 'transport close')
    socket.__trigger('connect_error', new Error('still reconnecting'))
    socket.__trigger('connect')

    const resumes = socket.emit.mock.calls.filter((c: any[]) => c[0] === 'resume')
    expect(resumes).toHaveLength(1)
    expect(resumes[0][1]).toEqual(expect.objectContaining({ session_id: 's1', profile: 'default', request_id: expect.any(String) }))

    const requestId = resumes[0][1].request_id
    // A stale response for another request must not be applied.
    socket.__trigger('resumed', { session_id: 's1', request_id: 'resume_other', isWorking: true, messages: [] })
    expect(onReconnectResume).not.toHaveBeenCalled()
    const snapshot = { session_id: 's1', request_id: requestId, isWorking: true, messages: [], events: [] }
    socket.__trigger('resumed', snapshot)
    expect(onReconnectResume).toHaveBeenCalledWith(snapshot)
    // The one-shot resumed listener is gone once the snapshot landed.
    expect(socket.__listenerCount('resumed')).toBe(0)
  })

  it('reports non-transient disconnects through onSocketError and drops the handler set', () => {
    connectChatRun('default')
    const socket = socketState.sockets[0]
    const onSocketError = vi.fn()
    const onMessageDelta = vi.fn()
    registerSessionHandlers('s1', handlerSet({ onSocketError, onMessageDelta }), { profile: 'default' })

    socket.__trigger('disconnect', 'io server disconnect')
    expect(onSocketError).toHaveBeenCalledTimes(1)
    socket.__trigger('message.delta', { event: 'message.delta', session_id: 's1', delta: 'late' })
    expect(onMessageDelta).not.toHaveBeenCalled()
    expect(socket.__listenerCount('disconnect')).toBe(0)
    expect(socket.__listenerCount('connect')).toBe(0)
  })

  it('disposes reconnect listeners on unregister and on terminal run events', () => {
    connectChatRun('default')
    const socket = socketState.sockets[0]
    const baseConnect = socket.__listenerCount('connect')
    const baseDisconnect = socket.__listenerCount('disconnect')

    registerSessionHandlers('s1', handlerSet(), { profile: 'default' })
    expect(socket.__listenerCount('connect')).toBe(baseConnect + 1)
    unregisterSessionHandlers('s1')
    expect(socket.__listenerCount('connect')).toBe(baseConnect)
    expect(socket.__listenerCount('disconnect')).toBe(baseDisconnect)

    // The same registration replaced twice must not accumulate listeners.
    registerSessionHandlers('s2', handlerSet(), { profile: 'default' })
    registerSessionHandlers('s2', handlerSet(), { profile: 'default' })
    expect(socket.__listenerCount('connect')).toBe(baseConnect + 1)
    socket.__trigger('run.completed', { event: 'run.completed', session_id: 's2' })
    expect(socket.__listenerCount('connect')).toBe(baseConnect)

    // Send path keeps its existing behaviour: listeners removed when the run ends.
    startRunViaSocket({ input: 'x', session_id: 's3', profile: 'default' }, vi.fn(), vi.fn(), vi.fn())
    expect(socket.__listenerCount('connect')).toBe(baseConnect + 1)
    socket.__trigger('abort.completed', { event: 'abort.completed', session_id: 's3', queue_length: 0 })
    expect(socket.__listenerCount('connect')).toBe(baseConnect)
    expect(socket.__listenerCount('resumed')).toBe(0)
  })
})
