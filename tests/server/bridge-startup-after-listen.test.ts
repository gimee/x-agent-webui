import { createServer, type Server } from 'net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// hermes-v050:S5 behavior the late (after-listen) bridge start relies on: a chat run that
// arrives during the startup window joins the in-flight start and sees an explicit
// 'starting' readiness until then — it never spawns a second bridge or fails silently.
const originalEnv = { ...process.env }

beforeEach(() => {
  vi.resetModules()
  process.env = { ...originalEnv }
})

afterEach(() => {
  process.env = { ...originalEnv }
})

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

describe('agent bridge started after listen', () => {
  it('lets early chat runs wait on the same bridge start and reports starting meanwhile', async () => {
    const port = await reservePort()
    const endpoint = `tcp://127.0.0.1:${port}`
    const actions: string[] = []
    let server: Server | undefined
    // The bridge only comes up a little after bootstrap began starting it.
    const bridgeUp = new Promise<void>((resolve) => {
      setTimeout(() => {
        server = createServer((socket) => {
          socket.once('data', (chunk) => {
            const request = JSON.parse(chunk.toString('utf8').trim())
            actions.push(request.action)
            socket.end(`${JSON.stringify({ ok: true, pong: request.action === 'ping' })}\n`)
          })
        })
        server.listen(port, '127.0.0.1', () => resolve())
      }, 300)
    })

    try {
      const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
      const manager = new AgentBridgeManager({ endpoint, startupTimeoutMs: 2000 })

      const bootStart = manager.start()
      await expect(manager.checkReadiness({ timeoutMs: 50, connectRetryMs: 0 })).resolves.toMatchObject({
        status: 'starting',
        reachable: false,
      })

      // ensureBridgeReadyForChatRun: start() then ensureReady({ recover: false }).
      const chatStart = manager.start()
      await Promise.all([bootStart, chatStart, bridgeUp])
      await expect(manager.ensureReady({ timeoutMs: 1000, connectRetryMs: 0, recover: false })).resolves.toMatchObject({
        status: 'ready',
        reachable: true,
      })
      // One attach ping for the shared start, one readiness ping for the chat run.
      expect(actions).toEqual(['ping', 'ping'])
      await manager.stop()
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve())
    }
  })
})
