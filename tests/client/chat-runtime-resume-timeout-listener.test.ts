// review-C-F7: resumeSession must return a dispose handle so switchSession can
// detach its `resumed` listener when it gives up after the 15s timeout.
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
      __trigger: (e: string, ...args: any[]) => { for (const h of [...(listeners.get(e) || [])]) h(...args) },
    }
    return socket
  }
  return { io: vi.fn(() => { const s = createSocket(); socketState.sockets.push(s); return s }) }
})

vi.mock('../../packages/client/src/api/client', () => ({ getApiKey: () => 'test-token', getBaseUrlValue: () => '' }))

import { disconnectChatRun, resumeSession } from '../../packages/client/src/api/studio/chat'

describe('resumeSession dispose handle', () => {
  beforeEach(() => { socketState.sockets.length = 0; disconnectChatRun() })

  it('returns a dispose function that removes the pending resumed listener', () => {
    const onResumed = vi.fn()
    const dispose = resumeSession('s1', onResumed, 'default')
    const socket = socketState.sockets[0]
    expect(typeof dispose).toBe('function')
    expect(socket.__listenerCount('resumed')).toBe(1)

    dispose()
    expect(socket.__listenerCount('resumed')).toBe(0)
    const requestId = socket.emit.mock.calls.find((c: any[]) => c[0] === 'resume')[1].request_id
    socket.__trigger('resumed', { session_id: 's1', request_id: requestId, messages: [] })
    expect(onResumed).not.toHaveBeenCalled()
  })

  it('does not accumulate listeners across repeated abandoned resumes', () => {
    const socketCountBefore = socketState.sockets.length
    const disposers = Array.from({ length: 5 }, (_, i) => resumeSession(`s${i}`, vi.fn(), 'default'))
    const socket = socketState.sockets[socketCountBefore]
    expect(socket.__listenerCount('resumed')).toBe(5)
    for (const dispose of disposers) dispose()
    expect(socket.__listenerCount('resumed')).toBe(0)
  })

  it('is a no-op after the response already settled the listener', () => {
    const onResumed = vi.fn()
    const dispose = resumeSession('s1', onResumed, 'default')
    const socket = socketState.sockets[0]
    const requestId = socket.emit.mock.calls.find((c: any[]) => c[0] === 'resume')[1].request_id
    socket.__trigger('resumed', { session_id: 's1', request_id: requestId, messages: [] })
    expect(onResumed).toHaveBeenCalledTimes(1)
    expect(socket.__listenerCount('resumed')).toBe(0)
    expect(() => dispose()).not.toThrow()
  })
})
