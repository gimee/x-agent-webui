// hermes-v050:S13 Socket.IO compresses large frames (resume payloads 145-169KB) with
// permessage-deflate, leaves small streaming deltas alone, and stays compatible with
// socket.io-client (browsers negotiate the extension natively).
import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { io as ioClient } from 'socket.io-client'
import { createSocketIoServer } from '../../packages/server/src/modules/studio/sockets/io-server'

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

function payload(bytes: number) {
  const row = { role: 'tool', content: 'const x = "resume payload";\n'.repeat(4), id: 0 }
  const rows = []
  while (JSON.stringify(rows).length < bytes) rows.push({ ...row, id: rows.length })
  return { rows }
}

const BIG = payload(150 * 1024)
const SMALL = payload(16 * 1024)

async function startServer(): Promise<number> {
  const server = http.createServer()
  const io = createSocketIoServer(server)
  io.on('connection', (socket) => {
    socket.on('want', (name: string) => socket.emit(name, name === 'big' ? BIG : SMALL))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise<void>(resolve => { io.close(); server.close(() => resolve()) }))
  const address = server.address()
  return typeof address === 'object' && address ? address.port : 0
}

describe('Socket.IO permessage-deflate for large frames', () => {
  it('negotiates deflate and only compresses frames above the 32KB threshold', async () => {
    const port = await startServer()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`, { perMessageDeflate: true })
    closers.push(async () => { ws.terminate() })
    const messages: string[] = []
    let waiter: ((text: string) => void) | null = null
    ws.on('message', (data) => {
      const text = data.toString()
      if (text === '2') { ws.send('3'); return } // engine.io ping/pong
      if (waiter) { const resolve = waiter; waiter = null; resolve(text) } else messages.push(text)
    })
    const next = () => messages.length ? Promise.resolve(messages.shift()!) : new Promise<string>(resolve => { waiter = resolve })
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
    expect(ws.extensions).toContain('permessage-deflate')

    expect((await next()).startsWith('0')).toBe(true) // engine.io open
    ws.send('40')
    expect((await next()).startsWith('40')).toBe(true) // namespace connected
    const socket = (ws as any)._socket as import('net').Socket

    let before = socket.bytesRead
    ws.send('42["want","big"]')
    const big = await next()
    const bigWire = socket.bytesRead - before
    // connectionStateRecovery appends the packet offset as a trailing argument
    expect(JSON.parse(big.slice(2)).slice(0, 2)).toEqual(['big', BIG])
    expect(bigWire).toBeLessThan(Buffer.byteLength(big) / 3)

    before = socket.bytesRead
    ws.send('42["want","small"]')
    const small = await next()
    const smallWire = socket.bytesRead - before
    expect(JSON.parse(small.slice(2)).slice(0, 2)).toEqual(['small', SMALL])
    expect(smallWire).toBeGreaterThanOrEqual(Buffer.byteLength(small))
  })

  it('delivers large events intact to socket.io-client over websocket and polling', async () => {
    const port = await startServer()
    for (const transports of [['websocket'], ['polling']] as const) {
      const client = ioClient(`http://127.0.0.1:${port}`, { transports: [...transports], forceNew: true, reconnection: false })
      closers.push(async () => { client.close() })
      await new Promise<void>((resolve, reject) => { client.once('connect', () => resolve()); client.once('connect_error', reject) })
      const received = new Promise(resolve => client.once('big', resolve))
      client.emit('want', 'big')
      expect(await received, transports[0]).toEqual(BIG)
    }
  })
})
