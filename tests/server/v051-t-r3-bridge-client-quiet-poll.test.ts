// hermes-v051:T2 R3-01 — the WebUI polls get_session_title every 500 ms for up to 45 s per turn (90 requests when
// the title never upgrades). Like get_output/background_poll it must not write two info lines per request into
// the 3 MB bridge.log.
import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const bridgeLogger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: bridgeLogger,
  bridgeLogger,
}))

import { AgentBridgeClient } from '../../packages/server/src/modules/hermes/services/bridge/client'

describe('hermes-v051:T2 R3-01 quiet get_session_title polling', () => {
  let dir = ''
  let server: Server
  let endpoint = ''

  beforeEach(async () => {
    vi.clearAllMocks()
    dir = mkdtempSync(join(tmpdir(), 'v051-r3-01-'))
    const socketPath = join(dir, 'bridge.sock')
    endpoint = `ipc://${socketPath}`
    server = createServer((socket) => {
      socket.once('data', (chunk) => {
        const req = JSON.parse(chunk.toString('utf8').split('\n')[0])
        const resp = req.action === 'get_session_title'
          ? { ok: true, session_id: req.session_id, title: '首句临时标题', title_source: 'derived' }
          : { ok: true, pong: true }
        socket.end(`${JSON.stringify(resp)}\n`)
      })
    })
    await new Promise<void>(resolve => server.listen(socketPath, resolve))
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not log request/response info lines for get_session_title', async () => {
    const client = new AgentBridgeClient({ endpoint, connectRetryMs: 0, timeoutMs: 2000 })
    for (let i = 0; i < 5; i += 1) {
      const result = await client.getSessionTitle('s1', 'default', { timeoutMs: 2000 })
      expect(result.title_source).toBe('derived')
    }
    expect(bridgeLogger.info).not.toHaveBeenCalled()
  })

  it('still logs ordinary requests', async () => {
    const client = new AgentBridgeClient({ endpoint, connectRetryMs: 0, timeoutMs: 2000 })
    await client.ping()
    expect(bridgeLogger.info).toHaveBeenCalledTimes(2)
  })
})
