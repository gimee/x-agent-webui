// hermes-v050:S2 behavior of the real static chain from bootstrap/http.ts
// (static compression middleware -> koa-static -> SPA fallback via koa-send).
import http from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants, gunzipSync, gzipSync } from 'node:zlib'
import Koa from 'koa'
import serve from 'koa-static'
import send from 'koa-send'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStaticCompressionMiddleware } from '../../packages/server/src/modules/studio/middleware/static-compression'
import {
  getStaticCacheControl,
  IMMUTABLE_ASSET_CACHE_CONTROL,
  SPA_ENTRY_CACHE_CONTROL,
} from '../../packages/server/src/modules/studio/middleware/static-cache'

interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

let distDir = ''
const indexHtml = `<!doctype html><html><head><title>Hermes Studio</title></head><body>${'<p>shell</p>'.repeat(400)}</body></html>`
const appJs = 'export const route = "/chat";\n'.repeat(3000)

// Same sibling layout the build writes (scripts/vite-precompress.ts is tested separately).
function writeSiblings(path: string): void {
  const original = readFileSync(path)
  writeFileSync(`${path}.br`, brotliCompressSync(original, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }))
  writeFileSync(`${path}.gz`, gzipSync(original, { level: 9 }))
}

function createStaticApp(root: string): Koa {
  const app = new Koa()
  app.use(createStaticCompressionMiddleware())
  app.use(serve(root, {
    setHeaders(res, filePath) {
      const cacheControl = getStaticCacheControl(relative(root, filePath))
      if (cacheControl) res.setHeader('Cache-Control', cacheControl)
    },
  }))
  app.use(async (ctx) => {
    if ((ctx.method === 'GET' || ctx.method === 'HEAD') && !ctx.path.startsWith('/api') && ctx.path !== '/health') {
      ctx.set('Cache-Control', SPA_ENTRY_CACHE_CONTROL)
      await send(ctx, 'index.html', { root })
    }
  })
  return app
}

async function request(app: Koa, path: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  const server = http.createServer(app.callback())
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected tcp server')
  try {
    return await new Promise<RawResponse>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: address.port, path, headers, agent: false }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(Buffer.from(chunk)))
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }))
      })
      req.on('error', reject)
      req.end()
    })
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
  }
}

beforeEach(() => {
  distDir = mkdtempSync(join(tmpdir(), 'hermes-static-precompressed-'))
  mkdirSync(join(distDir, 'assets', 'js'), { recursive: true })
  writeFileSync(join(distDir, 'index.html'), indexHtml)
  writeFileSync(join(distDir, 'assets', 'js', 'app-abc.js'), appJs)
  writeSiblings(join(distDir, 'index.html'))
  writeSiblings(join(distDir, 'assets', 'js', 'app-abc.js'))
})

afterEach(() => {
  rmSync(distDir, { recursive: true, force: true })
})

describe('precompressed static assets on the real serving chain', () => {
  it('sends the prebuilt .br file untouched instead of compressing per request', async () => {
    const response = await request(createStaticApp(distDir), '/assets/js/app-abc.js', { 'Accept-Encoding': 'gzip, deflate, br' })

    expect(response.status).toBe(200)
    expect(response.headers['content-encoding']).toBe('br')
    expect(response.body.equals(readFileSync(join(distDir, 'assets', 'js', 'app-abc.js.br')))).toBe(true)
    expect(brotliDecompressSync(response.body).toString('utf8')).toBe(appJs)
    expect(response.headers['content-type']).toMatch(/javascript/)
    expect(response.headers['cache-control']).toBe(IMMUTABLE_ASSET_CACHE_CONTROL)
    expect(response.headers.vary).toContain('Accept-Encoding')
  })

  it('serves the precompressed SPA entry with its no-cache policy on / and on client routes', async () => {
    for (const path of ['/', '/chat/some-session']) {
      const response = await request(createStaticApp(distDir), path, { 'Accept-Encoding': 'br, gzip' })
      expect(response.headers['content-encoding'], path).toBe('br')
      expect(brotliDecompressSync(response.body).toString('utf8'), path).toBe(indexHtml)
      expect(response.headers['cache-control'], path).toBe(SPA_ENTRY_CACHE_CONTROL)
      expect(response.headers['content-type'], path).toMatch(/text\/html/)
      expect(response.headers.vary, path).toContain('Accept-Encoding')
    }
  })

  it('falls back to the .gz sibling and to identity by Accept-Encoding', async () => {
    const gzip = await request(createStaticApp(distDir), '/assets/js/app-abc.js', { 'Accept-Encoding': 'gzip' })
    expect(gzip.headers['content-encoding']).toBe('gzip')
    expect(gunzipSync(gzip.body).toString('utf8')).toBe(appJs)

    const identity = await request(createStaticApp(distDir), '/assets/js/app-abc.js', { 'Accept-Encoding': 'identity' })
    expect(identity.headers['content-encoding']).toBeUndefined()
    expect(identity.body.toString('utf8')).toBe(appJs)
    expect(identity.headers.vary).toContain('Accept-Encoding')
  })

  it('never serves a sibling that is older than a later rewrite of the original', async () => {
    const rewritten = indexHtml.replace('<title>', '<style>.late-injection{}</style><title>')
    writeFileSync(join(distDir, 'index.html'), rewritten)
    const future = new Date(Date.now() + 60_000)
    utimesSync(join(distDir, 'index.html'), future, future)

    for (const encoding of ['br', 'gzip']) {
      const response = await request(createStaticApp(distDir), '/', { 'Accept-Encoding': encoding })
      const decoded = response.headers['content-encoding'] === 'br'
        ? brotliDecompressSync(response.body)
        : response.headers['content-encoding'] === 'gzip' ? gunzipSync(response.body) : response.body
      expect(decoded.toString('utf8'), encoding).toBe(rewritten)
      expect(response.headers['cache-control'], encoding).toBe(SPA_ENTRY_CACHE_CONTROL)
    }
  })

  it('uses Brotli quality 5 for the remaining live compression', async () => {
    const app = new Koa()
    app.use(createStaticCompressionMiddleware())
    app.use((ctx) => {
      ctx.type = 'application/javascript'
      ctx.body = Buffer.from(appJs)
    })

    const response = await request(app, '/live.js', { 'Accept-Encoding': 'br' })

    expect(response.headers['content-encoding']).toBe('br')
    const q5 = brotliCompressSync(Buffer.from(appJs), { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } })
    expect(response.body.equals(q5)).toBe(true)
  })
})

describe('static cache policy for precompressed siblings', () => {
  it('maps .br/.gz siblings to the policy of the file they encode', () => {
    expect(getStaticCacheControl('index.html.br')).toBe(SPA_ENTRY_CACHE_CONTROL)
    expect(getStaticCacheControl('index.html.gz')).toBe(SPA_ENTRY_CACHE_CONTROL)
    expect(getStaticCacheControl('assets/js/index-abc.js.br')).toBe(IMMUTABLE_ASSET_CACHE_CONTROL)
    expect(getStaticCacheControl('logo.png')).toBeNull()
  })
})
