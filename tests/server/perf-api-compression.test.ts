import http from 'http'
import { Readable } from 'stream'
import { gunzipSync } from 'zlib'
import Koa from 'koa'
import { describe, expect, it } from 'vitest'
import { createApiCompressionMiddleware } from '../../packages/server/src/modules/studio/middleware/api-compression'

interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

async function withServer<T>(app: Koa, fn: (port: number) => Promise<T>): Promise<T> {
  const server = http.createServer(app.callback())
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected tcp server')
  try {
    return await fn(address.port)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
  }
}

function rawRequest(port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

const bigSessions = { sessions: Array.from({ length: 200 }, (_, i) => ({ id: `session-${i}`, title: `Session ${i}`, preview: 'x'.repeat(64) })) }
const bigJson = JSON.stringify(bigSessions)

function createApp(): Koa {
  const app = new Koa()
  app.use(createApiCompressionMiddleware())
  app.use(async (ctx, next) => {
    switch (ctx.path) {
      case '/api/studio/sessions':
        ctx.body = bigSessions
        return
      case '/api/small':
        ctx.body = { ok: true }
        return
      case '/api/string-json':
        ctx.type = 'application/json'
        ctx.body = bigJson
        return
      case '/api/error':
        ctx.status = 500
        ctx.body = bigSessions
        return
      case '/api/studio/files/download':
        ctx.type = 'application/json'
        ctx.set('Content-Disposition', 'attachment; filename="x.json"')
        ctx.body = bigJson
        return
      case '/api/pre-encoded':
        ctx.type = 'application/json'
        ctx.set('Content-Encoding', 'identity')
        ctx.body = bigJson
        return
      case '/api/sse': {
        ctx.set('Content-Type', 'text/event-stream; charset=utf-8')
        ctx.set('Cache-Control', 'no-cache')
        ctx.body = Readable.from(['data: ' + 'a'.repeat(2048) + '\n\n', 'data: done\n\n'])
        return
      }
      case '/assets/app.js':
        ctx.type = 'text/javascript'
        ctx.body = 'const a = 1;\n'.repeat(500)
        return
      default:
        return next()
    }
  })
  return app
}

describe('API JSON compression middleware', () => {
  it('gzips large JSON object bodies for clients that accept gzip', async () => {
    await withServer(createApp(), async (port) => {
      const res = await rawRequest(port, '/api/studio/sessions', { 'Accept-Encoding': 'gzip, deflate, br' })
      expect(res.status).toBe(200)
      expect(res.headers['content-encoding']).toBe('gzip')
      expect(res.headers['content-type']).toMatch(/application\/json/)
      expect(res.headers.vary).toContain('Accept-Encoding')
      expect(Number(res.headers['content-length'])).toBe(res.body.byteLength)
      expect(res.body.byteLength).toBeLessThan(Buffer.byteLength(bigJson) / 4)
      expect(JSON.parse(gunzipSync(res.body).toString('utf8'))).toEqual(bigSessions)
    })
  })

  it('gzips pre-serialized JSON strings too, and never uses brotli', async () => {
    await withServer(createApp(), async (port) => {
      const res = await rawRequest(port, '/api/string-json', { 'Accept-Encoding': 'br, gzip' })
      expect(res.headers['content-encoding']).toBe('gzip')
      expect(gunzipSync(res.body).toString('utf8')).toBe(bigJson)
    })
  })

  it('leaves the body untouched when the client does not accept gzip', async () => {
    await withServer(createApp(), async (port) => {
      const res = await rawRequest(port, '/api/studio/sessions', {})
      expect(res.headers['content-encoding']).toBeUndefined()
      expect(JSON.parse(res.body.toString('utf8'))).toEqual(bigSessions)
      const brOnly = await rawRequest(port, '/api/studio/sessions', { 'Accept-Encoding': 'br' })
      expect(brOnly.headers['content-encoding']).toBeUndefined()
    })
  })

  it('skips small bodies, error statuses, HEAD, Range, downloads and pre-encoded responses', async () => {
    await withServer(createApp(), async (port) => {
      const headers = { 'Accept-Encoding': 'gzip' }
      const small = await rawRequest(port, '/api/small', headers)
      expect(small.headers['content-encoding']).toBeUndefined()
      expect(JSON.parse(small.body.toString('utf8'))).toEqual({ ok: true })

      const error = await rawRequest(port, '/api/error', headers)
      expect(error.status).toBe(500)
      expect(error.headers['content-encoding']).toBeUndefined()

      const head = await rawRequest(port, '/api/studio/sessions', headers, 'HEAD')
      expect(head.headers['content-encoding']).toBeUndefined()

      const range = await rawRequest(port, '/api/studio/sessions', { ...headers, Range: 'bytes=0-10' })
      expect(range.headers['content-encoding']).toBeUndefined()

      const download = await rawRequest(port, '/api/studio/files/download', headers)
      expect(download.headers['content-encoding']).toBeUndefined()
      expect(download.body.toString('utf8')).toBe(bigJson)

      const pre = await rawRequest(port, '/api/pre-encoded', headers)
      expect(pre.headers['content-encoding']).toBe('identity')
      expect(pre.body.toString('utf8')).toBe(bigJson)
    })
  })

  it('does not touch text/event-stream responses', async () => {
    await withServer(createApp(), async (port) => {
      const res = await rawRequest(port, '/api/sse', { 'Accept-Encoding': 'gzip, br' })
      expect(res.headers['content-type']).toMatch(/text\/event-stream/)
      expect(res.headers['content-encoding']).toBeUndefined()
      expect(res.headers.vary ?? '').not.toContain('Accept-Encoding')
      const text = res.body.toString('utf8')
      expect(text.startsWith('data: aaaa')).toBe(true)
      expect(text.endsWith('data: done\n\n')).toBe(true)
    })
  })

  it('leaves non-JSON content types to the static compression middleware', async () => {
    await withServer(createApp(), async (port) => {
      const res = await rawRequest(port, '/assets/app.js', { 'Accept-Encoding': 'gzip, br' })
      expect(res.headers['content-encoding']).toBeUndefined()
      expect(res.body.toString('utf8')).toBe('const a = 1;\n'.repeat(500))
    })
  })
})
