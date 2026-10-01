import type { Context, Middleware } from 'koa'
import type { Readable } from 'stream'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import {
  brotliCompressSync,
  constants as zlibConstants,
  createBrotliCompress,
  createGzip,
  gzipSync,
} from 'zlib'

export type StaticCompressionEncoding = 'br' | 'gzip'

export interface StaticCompressionOptions {
  minBytes?: number
  maxBrotliBytes?: number
}

const DEFAULT_MIN_BYTES = 1024
// Dynamic Brotli provides great ratios, but it can add seconds of TTFB on multi-megabyte
// built assets. Cap it and fall back to gzip (or no compression) for larger responses.
const DEFAULT_MAX_BROTLI_BYTES = 256 * 1024
// hermes-v050:S2 Built assets arrive precompressed (q11 .br/.gz from the vite build), so live
// Brotli is only a fallback now; q11 took ~370ms of threadpool time for a 204KB chunk, q5 ~7ms.
const LIVE_BROTLI_QUALITY = 5

const COMPRESSIBLE_TYPES = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/json',
  'application/ld+json',
  'application/manifest+json',
  'application/rss+xml',
  'application/wasm',
  'application/xhtml+xml',
  'application/xml',
  'application/x-javascript',
  'image/svg+xml',
  'text/javascript',
])

export function isCompressibleContentType(contentType: string): boolean {
  const normalized = contentType.split(';', 1)[0]?.trim().toLowerCase() || ''
  if (!normalized) return false
  return normalized.startsWith('text/') ||
    COMPRESSIBLE_TYPES.has(normalized) ||
    normalized.endsWith('+json') ||
    normalized.endsWith('+xml')
}

function parseEncodingQuality(header: string, encoding: StaticCompressionEncoding): number {
  let wildcardQuality: number | null = null
  let encodingQuality: number | null = null

  for (const rawPart of header.split(',')) {
    const [rawToken, ...rawParams] = rawPart.split(';')
    const token = rawToken?.trim().toLowerCase()
    if (!token) continue

    let quality = 1
    for (const rawParam of rawParams) {
      const [rawName, rawValue] = rawParam.split('=')
      if (rawName?.trim().toLowerCase() !== 'q') continue
      const parsed = Number(rawValue?.trim())
      quality = Number.isFinite(parsed) ? Math.max(0, Math.min(parsed, 1)) : 0
    }

    if (token === encoding) encodingQuality = quality
    if (token === '*') wildcardQuality = quality
  }

  return encodingQuality ?? wildcardQuality ?? 0
}

interface StaticCompressionSelectionOptions {
  bodyLength?: number | null
  maxBrotliBytes?: number
}

export function selectStaticCompressionEncoding(
  acceptEncoding: string,
  options: StaticCompressionSelectionOptions = {},
): StaticCompressionEncoding | null {
  const brQuality = parseEncodingQuality(acceptEncoding, 'br')
  const gzipQuality = parseEncodingQuality(acceptEncoding, 'gzip')
  const bodyLength = options.bodyLength ?? null
  const maxBrotliBytes = options.maxBrotliBytes ?? DEFAULT_MAX_BROTLI_BYTES

  if (brQuality <= 0 && gzipQuality <= 0) return null

  if (brQuality >= gzipQuality) {
    if (bodyLength !== null && bodyLength > maxBrotliBytes) {
      return gzipQuality > 0 ? 'gzip' : null
    }

    return 'br'
  }

  return 'gzip'
}

function isReadableStream(value: unknown): value is Readable {
  return !!value && typeof (value as { pipe?: unknown }).pipe === 'function'
}

function parseBodyLength(ctx: Context, body: unknown): number | null {
  if (Buffer.isBuffer(body)) return body.byteLength
  if (typeof body === 'string') return Buffer.byteLength(body)

  const contentLength = Number(ctx.response.get('Content-Length'))
  return Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : null
}

function shouldCompress(ctx: Context, minBytes: number): boolean {
  if (ctx.method === 'HEAD') return false
  if (ctx.status < 200 || ctx.status >= 300 || ctx.status === 204) return false
  if (ctx.get('Range')) return false
  if (ctx.response.get('Content-Encoding')) return false
  if (!isCompressibleContentType(ctx.response.get('Content-Type') || ctx.type || '')) return false

  const body = ctx.body
  if (!body || !(Buffer.isBuffer(body) || typeof body === 'string' || isReadableStream(body))) return false

  const bodyLength = parseBodyLength(ctx, body)
  return bodyLength === null || bodyLength >= minBytes
}

function compressBuffer(body: Buffer, encoding: StaticCompressionEncoding): Buffer {
  if (encoding === 'br') {
    return brotliCompressSync(body, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: LIVE_BROTLI_QUALITY,
      },
    })
  }

  return gzipSync(body)
}

function createCompressionStream(encoding: StaticCompressionEncoding) {
  if (encoding === 'br') {
    return createBrotliCompress({
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: LIVE_BROTLI_QUALITY,
      },
    })
  }

  return createGzip()
}

const PRECOMPRESSED_SIBLINGS: Record<string, StaticCompressionEncoding> = { '.br': 'br', '.gz': 'gzip' }

// hermes-v050:S2 koa-send streams an accepted `<file>.br`/`<file>.gz` sibling as-is. Mark the
// response as varying on Accept-Encoding, and refuse a sibling older than its original (a
// later rewrite of dist/client) so stale bytes are never served: swap back to the original
// and let the live path below compress it.
async function settlePrecompressedSibling(ctx: Context): Promise<void> {
  const body = ctx.body as (Readable & { path?: unknown }) | null
  const encoding = ctx.response.get('Content-Encoding')
  if (!encoding || !isReadableStream(body) || typeof body.path !== 'string') return
  const servedPath = body.path
  const suffix = servedPath.slice(-3)
  if (PRECOMPRESSED_SIBLINGS[suffix] !== encoding) return

  ctx.vary('Accept-Encoding')
  const originalPath = servedPath.slice(0, -suffix.length)
  const [sibling, original] = await Promise.all([stat(servedPath), stat(originalPath)]).catch(() => [null, null])
  if (!sibling || !original || sibling.mtimeMs >= original.mtimeMs) return

  body.destroy()
  ctx.remove('Content-Encoding')
  ctx.body = createReadStream(originalPath)
  ctx.set('Content-Length', String(original.size))
  ctx.set('Last-Modified', original.mtime.toUTCString())
}

export function createStaticCompressionMiddleware(options: StaticCompressionOptions = {}): Middleware {
  const minBytes = options.minBytes ?? DEFAULT_MIN_BYTES
  const maxBrotliBytes = options.maxBrotliBytes ?? DEFAULT_MAX_BROTLI_BYTES

  return async (ctx, next) => {
    await next()

    await settlePrecompressedSibling(ctx)
    if (!shouldCompress(ctx, minBytes)) return

    const body = ctx.body
    const bodyLength = parseBodyLength(ctx, body)
    ctx.vary('Accept-Encoding')
    const encoding = selectStaticCompressionEncoding(ctx.get('Accept-Encoding'), {
      bodyLength,
      maxBrotliBytes,
    })
    if (!encoding) return

    ctx.set('Content-Encoding', encoding)

    if (Buffer.isBuffer(body) || typeof body === 'string') {
      const original = Buffer.isBuffer(body) ? body : Buffer.from(body)
      const compressed = compressBuffer(original, encoding)
      if (compressed.byteLength >= original.byteLength) {
        ctx.remove('Content-Encoding')
        return
      }

      ctx.body = compressed
      ctx.set('Content-Length', String(compressed.byteLength))
      return
    }

    if (isReadableStream(body)) {
      ctx.remove('Content-Length')
      ctx.body = body.pipe(createCompressionStream(encoding))
    }
  }
}
