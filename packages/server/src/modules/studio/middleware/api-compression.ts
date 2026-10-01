import type { Context, Middleware } from 'koa'
import type { Readable } from 'stream'
import { promisify } from 'util'
import { createGzip, gzip } from 'zlib'

/**
 * gzip for JSON API responses.
 *
 * The static compression middleware is mounted *after* the routers, so API
 * bodies were never compressed (e.g. GET /api/studio/sessions: 690KB plain JSON
 * → 71KB gzip). This middleware is mounted before the routers and deliberately
 * only handles JSON: HTML/JS/CSS keep going through static-compression, and
 * everything that must stay byte-exact or streaming is excluded below.
 *
 * gzip (zlib default level) is used on purpose instead of Brotli q11: Brotli
 * costs ~50ms for a 29KB body, gzip ~9ms for 690KB, and the transfers are LAN.
 */

export interface ApiCompressionOptions {
  /** Minimum serialized body size to compress. Default 1KB. */
  minBytes?: number
  /** Request paths that are never compressed (exact match or prefix + '/'). */
  excludedPaths?: string[]
}

const DEFAULT_MIN_BYTES = 1024

// - text/event-stream: SSE (coding-agents claude-code/codex proxies) must flush per event.
// - /socket.io: Socket.IO is attached to the raw http server and normally never
//   reaches Koa, but keep it excluded in case of a fallback route.
// - /api/studio/files/download: attachment streaming with exact Content-Length.
export const DEFAULT_EXCLUDED_PATHS = [
  '/socket.io',
  '/api/studio/files/download',
]

const gzipAsync = promisify(gzip)

function isJsonContentType(contentType: string): boolean {
  const normalized = contentType.split(';', 1)[0]?.trim().toLowerCase() || ''
  if (!normalized) return false
  return normalized === 'application/json' || normalized.endsWith('+json')
}

function acceptsGzip(acceptEncoding: string): boolean {
  if (!acceptEncoding) return false
  let wildcard: number | null = null
  let gzipQuality: number | null = null
  for (const rawPart of acceptEncoding.split(',')) {
    const [rawToken, ...rawParams] = rawPart.split(';')
    const token = rawToken?.trim().toLowerCase()
    if (!token) continue
    let quality = 1
    for (const rawParam of rawParams) {
      const [name, value] = rawParam.split('=')
      if (name?.trim().toLowerCase() !== 'q') continue
      const parsed = Number(value?.trim())
      quality = Number.isFinite(parsed) ? Math.max(0, Math.min(parsed, 1)) : 0
    }
    if (token === 'gzip') gzipQuality = quality
    else if (token === '*') wildcard = quality
  }
  return (gzipQuality ?? wildcard ?? 0) > 0
}

function isReadableStream(value: unknown): value is Readable {
  return !!value && typeof (value as { pipe?: unknown }).pipe === 'function'
}

function isExcludedPath(path: string, excluded: string[]): boolean {
  return excluded.some(prefix => path === prefix || path.startsWith(prefix + '/'))
}

function isPlainJsonBody(body: unknown): boolean {
  if (body === null || body === undefined) return false
  if (Buffer.isBuffer(body) || typeof body === 'string' || isReadableStream(body)) return false
  return typeof body === 'object' || typeof body === 'number' || typeof body === 'boolean'
}

function isEligible(ctx: Context, excluded: string[]): boolean {
  if (ctx.method === 'HEAD') return false
  if (ctx.status < 200 || ctx.status >= 300 || ctx.status === 204) return false
  if (ctx.get('Range')) return false
  if (ctx.response.get('Content-Encoding')) return false
  if (isExcludedPath(ctx.path, excluded)) return false
  const disposition = ctx.response.get('Content-Disposition').toLowerCase()
  if (disposition.startsWith('attachment')) return false

  const body = ctx.body
  if (body === null || body === undefined) return false
  const contentType = ctx.response.get('Content-Type') || ''
  if (contentType.toLowerCase().startsWith('text/event-stream')) return false

  // Koa serializes plain objects as JSON only when no explicit type overrides it.
  if (isPlainJsonBody(body)) return !contentType || isJsonContentType(contentType)
  return isJsonContentType(contentType)
}

export function createApiCompressionMiddleware(options: ApiCompressionOptions = {}): Middleware {
  const minBytes = options.minBytes ?? DEFAULT_MIN_BYTES
  const excluded = options.excludedPaths ?? DEFAULT_EXCLUDED_PATHS

  return async (ctx, next) => {
    await next()

    if (!isEligible(ctx, excluded)) return

    const body = ctx.body
    if (isReadableStream(body)) {
      // JSON streams are rare; length unknown, so compress on the fly.
      ctx.vary('Accept-Encoding')
      if (!acceptsGzip(ctx.get('Accept-Encoding'))) return
      ctx.remove('Content-Length')
      ctx.set('Content-Encoding', 'gzip')
      ctx.body = body.pipe(createGzip())
      return
    }

    let original: Buffer
    if (Buffer.isBuffer(body)) {
      original = body
    } else if (typeof body === 'string') {
      original = Buffer.from(body)
    } else {
      // Same serialization Koa would apply (JSON.stringify without spacing);
      // set the type explicitly since we replace the object with a Buffer.
      original = Buffer.from(JSON.stringify(body))
      if (!ctx.response.get('Content-Type')) ctx.type = 'application/json'
    }

    if (original.byteLength < minBytes) {
      if (!Buffer.isBuffer(body) && typeof body !== 'string') {
        ctx.body = original
        ctx.set('Content-Length', String(original.byteLength))
      }
      return
    }

    ctx.vary('Accept-Encoding')
    if (!acceptsGzip(ctx.get('Accept-Encoding'))) {
      if (!Buffer.isBuffer(body) && typeof body !== 'string') {
        ctx.body = original
        ctx.set('Content-Length', String(original.byteLength))
      }
      return
    }

    const compressed = await gzipAsync(original)
    if (compressed.byteLength >= original.byteLength) {
      ctx.body = original
      ctx.set('Content-Length', String(original.byteLength))
      return
    }

    ctx.set('Content-Encoding', 'gzip')
    ctx.body = compressed
    ctx.set('Content-Length', String(compressed.byteLength))
  }
}
