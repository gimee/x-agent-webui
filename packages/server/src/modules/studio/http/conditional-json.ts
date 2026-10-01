import { createHash } from 'node:crypto'

/**
 * hermes-v050:S6: conditional GET for polled JSON lists.
 *
 * A weak ETag of the serialized body (weak because api-compression may gzip
 * the representation) plus `Cache-Control: private, no-cache` makes browsers
 * revalidate every fetch on their own, so a poll whose body did not change is
 * answered with an empty 304 instead of the full list. Other callers see the
 * same 200 body as before, with two extra headers.
 */
export function sendJsonWithEtag(ctx: any, body: unknown): void {
  const etag = `W/"${createHash('sha1').update(JSON.stringify(body)).digest('base64url')}"`
  ctx.set?.('ETag', etag)
  ctx.set?.('Cache-Control', 'private, no-cache')
  if (ifNoneMatchIncludes(requestHeader(ctx, 'if-none-match'), etag)) {
    ctx.status = 304
    return
  }
  ctx.body = body
}

function requestHeader(ctx: any, name: string): string {
  if (typeof ctx.get === 'function') return String(ctx.get(name) || '')
  const value = ctx.headers?.[name] ?? ctx.request?.headers?.[name]
  return typeof value === 'string' ? value : ''
}

/** RFC 9110 If-None-Match: weak comparison against a list of tags, or `*`. */
export function ifNoneMatchIncludes(header: string, etag: string): boolean {
  const value = header.trim()
  if (!value) return false
  if (value === '*') return true
  const opaque = (tag: string) => tag.trim().replace(/^W\//, '')
  const target = opaque(etag)
  return value.split(',').some(tag => opaque(tag) === target)
}
