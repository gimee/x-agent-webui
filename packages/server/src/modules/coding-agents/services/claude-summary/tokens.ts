import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { config } from '../../../studio/public/config'

// hermes-v051:A internal Claude-context endpoints for bin/claude-context (auxiliary summary, live
// compression settings). One random bearer token per managed Claude launch, held only in memory:
// the next managed launch of the same Studio session replaces it, the endpoints reject it once that
// session's run has ended (idle close, stop, relaunch), and a WebUI restart forgets every token.
// Tokens are compared as SHA-256 digests with timingSafeEqual.
export const CLAUDE_CONTEXT_API = '/api/coding-agents/claude-context'

interface TokenEntry { digest: Buffer; profile: string }
const entries = new Map<string, TokenEntry>()
let loopbackBaseUrl = ''

const digest = (token: string) => createHash('sha256').update(token).digest()

/** Set by bootstrap with getLoopbackBaseUrl(server) once the HTTP server listens. */
export function setClaudeSummaryBaseUrl(url: string): void {
  loopbackBaseUrl = url.replace(/\/+$/, '')
}

export function claudeSummaryUrl(): string {
  return `${loopbackBaseUrl || `http://127.0.0.1:${config.port}`}${CLAUDE_CONTEXT_API}/summary`
}

export function issueClaudeSummaryToken(sessionId: string, profile: string): string {
  const token = randomBytes(32).toString('base64url')
  entries.set(sessionId, { digest: digest(token), profile })
  return token
}

/** Without a token: drop the session's token. With one: only while it is still the current token. */
export function revokeClaudeSummaryToken(sessionId: string, token?: string): void {
  const entry = entries.get(sessionId)
  if (entry && (token === undefined || timingSafeEqual(entry.digest, digest(token)))) entries.delete(sessionId)
}

/** Profile bound to this session's current token, or null. */
export function claudeSummaryTokenProfile(sessionId: string, token: string): string | null {
  const entry = entries.get(sessionId)
  if (!entry || !token) return null
  return timingSafeEqual(entry.digest, digest(token)) ? entry.profile : null
}
