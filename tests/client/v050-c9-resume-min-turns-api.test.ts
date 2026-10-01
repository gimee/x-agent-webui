// hermes-v050:C9/S8 resume 请求的 min_turns 字段：只在调用方要求时发送，旧调用形状不变。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const socketState = vi.hoisted(() => ({
  sockets: [] as any[],
}))

vi.mock('socket.io-client', () => {
  function createSocket() {
    const listeners = new Map<string, Set<(...args: any[]) => void>>()

    const addListener = (event: string, handler: (...args: any[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(handler)
    }

    const removeListener = (event: string, handler: (...args: any[]) => void) => {
      const eventListeners = listeners.get(event)
      if (!eventListeners) return
      for (const candidate of [...eventListeners]) {
        if (candidate === handler || (candidate as any).__original === handler) {
          eventListeners.delete(candidate)
        }
      }
    }

    const socket: any = {
      connected: true,
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        addListener(event, handler)
        return socket
      }),
      once: vi.fn((event: string, handler: (...args: any[]) => void) => {
        const wrapped = (...args: any[]) => {
          removeListener(event, wrapped)
          handler(...args)
        }
        ;(wrapped as any).__original = handler
        addListener(event, wrapped)
        return socket
      }),
      off: vi.fn((event: string, handler: (...args: any[]) => void) => {
        removeListener(event, handler)
        return socket
      }),
      removeListener: vi.fn((event: string, handler: (...args: any[]) => void) => {
        removeListener(event, handler)
        return socket
      }),
      removeAllListeners: vi.fn(() => {
        listeners.clear()
        return socket
      }),
      emit: vi.fn(),
      disconnect: vi.fn(() => {
        socket.connected = false
      }),
      __listenerCount: (event: string) => listeners.get(event)?.size || 0,
      __trigger: (event: string, ...args: any[]) => {
        if (event === 'connect') socket.connected = true
        if (event === 'disconnect') socket.connected = false
        for (const handler of [...(listeners.get(event) || [])]) handler(...args)
      },
    }

    return socket
  }

  return {
    io: vi.fn(() => {
      const socket = createSocket()
      socketState.sockets.push(socket)
      return socket
    }),
  }
})

vi.mock('../../packages/client/src/api/client', () => ({
  getApiKey: () => 'test-token',
  getBaseUrlValue: () => '',
}))

describe('resume request asks for the ten-turn window (C9/S8)', () => {
  beforeEach(() => {
    vi.resetModules()
    socketState.sockets = []
  })

  it('sends min_turns when the caller asks for a turn window', async () => {
    const { resumeSession } = await import('../../packages/client/src/api/studio/chat')
    resumeSession('session-1', vi.fn(), 'default', 'chat-run', { minTurns: 10 })
    const socket = socketState.sockets[0]
    expect(socket.emit).toHaveBeenCalledWith('resume', {
      session_id: 'session-1', request_id: expect.any(String), profile: 'default', min_turns: 10,
    })
  })

  it('keeps the old request shape without the option', async () => {
    const { resumeSession } = await import('../../packages/client/src/api/studio/chat')
    resumeSession('session-1', vi.fn(), 'default')
    const socket = socketState.sockets[0]
    expect(socket.emit).toHaveBeenCalledWith('resume', { session_id: 'session-1', request_id: expect.any(String), profile: 'default' })
  })
})
