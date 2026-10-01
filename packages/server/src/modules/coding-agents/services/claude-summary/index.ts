import type { Context } from 'koa'
import { randomUUID } from 'node:crypto'
import type { ChatMessage } from '../../../studio/contracts/runs/messages'
import { getWebUiHome } from '../../../studio/public/config'
import { logger } from '../../../studio/public/logging'
import { getModelContextLength } from '../../../studio/public/provider-runtime'
import {
  assertUsableSummary,
  buildFullPrompt,
  buildIncrementalPrompt,
  callSummarizer,
  chunkForSummary,
  countTokens,
  resolveCompressionModelContext,
  serializeForSummary,
} from '../../../studio/public/context-compression'
import { codingAgentRunManager, sanitizeCodingAgentTerminalOutput } from '../runtime/run-manager'
import { claudeCompressionEnv, resolveClaudeCompressionSettings } from '../claude-compression-settings'
import { claudeRecordsToChatMessages, type ClaudeSummaryRecord } from './transcript'
import { claudeSummaryTokenProfile, revokeClaudeSummaryToken } from './tokens'

export { CLAUDE_CONTEXT_API } from './tokens'

// hermes-v051:A the Claude host wrapper's summary is written by 「模型 → 辅助模型 → 压缩」 through the
// same summarizer as Hermes chats. Output speed is the bottleneck for large archives, so one call when the summary model's window allows (chunk = max(30K, window × 0.5)),
// and the wait is max(270s, auxiliary timeout). Anything else answers {ok:false, reason} and the
// wrapper lets Claude write the summary in the same turn.
export const CLAUDE_SUMMARY_MIN_TIMEOUT_MS = 270_000
const DEADLINE_SLACK_MS = 15_000
const MAX_RECORDS = 200_000
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export interface ClaudeSummaryPlan {
  model: string
  provider?: string
  reasoningEffort?: string
  timeoutMs: number
  chunkTokens: number
}

export interface ClaudeSummaryInput {
  records: ClaudeSummaryRecord[]
  previousSummary?: string | null
  focus?: string | null
  summaryBudget?: number
  workerKey?: string
}

export type ClaudeSummaryOutcome =
  | { ok: true; summary: string; model: string; provider: string | null; seconds: number; chunks: number }
  | { ok: false; reason: 'empty' | 'invalid_summary' | 'failed' | 'timeout' | 'cancelled' }

/** The auxiliary compression model for this profile, or null when it is auto/unset. */
export async function resolveClaudeSummaryPlan(profile: string): Promise<ClaudeSummaryPlan | null> {
  const context = await resolveCompressionModelContext(profile, {})
  const model = String(context.model || '').trim()
  if (!context.auxiliary || !model) return null
  const provider = String(context.provider || '').trim() || undefined
  const window = Number(getModelContextLength({ profile, model, provider })) || 0
  return {
    model,
    provider,
    reasoningEffort: context.reasoningEffort,
    chunkTokens: Math.max(30_000, Math.floor(window * 0.5)),
    timeoutMs: Math.max(CLAUDE_SUMMARY_MIN_TIMEOUT_MS, (context.timeoutSeconds || 0) * 1000),
  }
}

// hermes-v051:R1-11 credentials pasted into the conversation (Bearer tokens, sk-… keys, api_key=…) are
// redacted before any of it leaves for the auxiliary provider.
const redact = (text: string): string => sanitizeCodingAgentTerminalOutput(text)
const redacted = (message: ChatMessage): ChatMessage => ({
  ...message,
  content: typeof message.content === 'string' ? redact(message.content) : message.content,
  ...(message.tool_calls ? { tool_calls: message.tool_calls.map(call => ({ ...call, function: { ...call.function, arguments: redact(call.function.arguments) } })) } : {}),
})

class DeadlineExceeded extends Error {}
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeadlineExceeded()), ms) })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

export async function summarizeClaudeTranscript(
  profile: string,
  plan: ClaudeSummaryPlan,
  input: ClaudeSummaryInput,
  signal?: AbortSignal,
): Promise<ClaudeSummaryOutcome> {
  const started = Date.now()
  const deadline = started + plan.timeoutMs
  const messages = claudeRecordsToChatMessages(input.records).map(redacted)
  if (!messages.length) return { ok: false, reason: 'empty' }
  // hermes-v051:R1-07 every token spans at least one UTF-8 byte: a history within one chunk by bytes is
  // one chunk, without chunkForSummary's per-message exact count (it can block the event loop for seconds on very large archives).
  const whole = serializeForSummary(messages)
  const chunks = Buffer.byteLength(whole) <= plan.chunkTokens ? [whole] : chunkForSummary(messages, plan.chunkTokens)
  // Same rule as compressionBudgets: retained × 10%, clamped to 4K-16K (the wrapper sends it).
  const requested = Number(input.summaryBudget)
  const budget = Math.min(16_000, Math.max(4_000, Number.isFinite(requested) ? Math.floor(requested) : 8_000))
  const focus = input.focus?.trim()
    ? `\n\nAdditional requirement from the user for this summary (a focus request, not a task): ${redact(input.focus.trim())}`
    : ''
  let summary = input.previousSummary?.trim() ? redact(input.previousSummary.trim()) : undefined
  try {
    for (const chunk of chunks) {
      if (signal?.aborted) return { ok: false, reason: 'cancelled' }
      const remaining = deadline - Date.now()
      if (remaining <= 0) return { ok: false, reason: 'timeout' }
      const prompt = (summary ? buildIncrementalPrompt(summary, chunk, budget) : buildFullPrompt(chunk, budget)) + focus
      const next = await withDeadline(callSummarizer('', undefined, prompt, [], remaining, summary, {
        profile,
        model: plan.model,
        provider: plan.provider,
        reasoningEffort: plan.reasoningEffort,
        workerKey: input.workerKey,
      }), remaining)
      summary = assertUsableSummary(next, countTokens(chunk))
    }
  } catch (err) {
    if (err instanceof DeadlineExceeded) return { ok: false, reason: 'timeout' }
    const message = err instanceof Error ? err.message : String(err)
    // Provider error text can quote credentials: redacted and bounded before it reaches the log.
    logger.warn('[claude-summary] auxiliary summary failed: %s', sanitizeCodingAgentTerminalOutput(message).slice(0, 200))
    if (/^Summarizer (?:returned an error notice|output too short)/.test(message)) return { ok: false, reason: 'invalid_summary' }
    return { ok: false, reason: /did not finish|timed? ?out/i.test(message) ? 'timeout' : 'failed' }
  }
  if (!summary?.trim()) return { ok: false, reason: 'invalid_summary' }
  return {
    ok: true,
    summary,
    model: plan.model,
    provider: plan.provider ?? null,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    chunks: chunks.length,
  }
}

function reply(ctx: Context, status: number, body: Record<string, unknown>): void {
  ctx.status = status
  ctx.set('Cache-Control', 'no-store')
  ctx.body = body
}

/**
 * Loopback peer (not relayed by a local reverse proxy), bearer token of this Studio session's
 * current managed launch, and that session's run still alive. Replies and returns null otherwise.
 */
function authorize(ctx: Context): { sessionId: string; profile: string } | null {
  const forwarded = ['x-forwarded-for', 'forwarded', 'x-real-ip'].some(header => ctx.get(header))
  if (!LOOPBACK.has(String(ctx.req.socket.remoteAddress || '')) || forwarded) {
    reply(ctx, 403, { ok: false, reason: 'forbidden' })
    return null
  }
  const body = ctx.request.body as Record<string, unknown> | undefined
  const sessionId = typeof body?.session_id === 'string' ? body.session_id : ''
  const token = /^Bearer\s+(\S+)$/i.exec(ctx.get('authorization'))?.[1] || ''
  const profile = sessionId && token ? claudeSummaryTokenProfile(sessionId, token) : null
  if (profile && !codingAgentRunManager.hasSession(sessionId)) revokeClaudeSummaryToken(sessionId, token)
  else if (profile) return { sessionId, profile }
  reply(ctx, 401, { ok: false, reason: 'unauthorized' })
  return null
}

function summaryInput(body: any): ClaudeSummaryInput | null {
  if (!Array.isArray(body?.rows) || body.rows.length > MAX_RECORDS) return null
  for (const key of ['previous_summary', 'focus']) {
    if (body[key] != null && typeof body[key] !== 'string') return null
  }
  return { records: body.rows, previousSummary: body.previous_summary ?? null, focus: body.focus ?? null, summaryBudget: body.summary_budget }
}

/** POST {CLAUDE_CONTEXT_API}/summary — see docs/claude-context.md for the contract. */
export async function claudeContextSummary(ctx: Context): Promise<void> {
  const auth = authorize(ctx)
  if (!auth) return
  const input = summaryInput(ctx.request.body)
  if (!input) return reply(ctx, 400, { ok: false, reason: 'bad_request' })
  let plan: ClaudeSummaryPlan | null = null
  try {
    plan = await resolveClaudeSummaryPlan(auth.profile)
  } catch (err) {
    logger.warn(err, '[claude-summary] auxiliary compression model lookup failed')
  }
  if (!plan) return reply(ctx, 200, { ok: false, reason: 'unavailable' })

  // Accepted: announce the deadline so the wrapper waits exactly as long as the auxiliary timeout allows.
  ctx.respond = false
  const res = ctx.res
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-hermes-summary-deadline-ms': String(plan.timeoutMs + DEADLINE_SLACK_MS),
  })
  res.flushHeaders()
  // A cancelled wrapper closes the connection: no further chunk is started.
  const cancelled = new AbortController()
  res.once('close', () => { if (!res.writableFinished) cancelled.abort() })
  const outcome = await summarizeClaudeTranscript(auth.profile, plan, {
    ...input,
    // hermes-v051:R1-14 a worker per request: a retry after a cancel never queues behind the orphaned call.
    workerKey: `${auth.profile}:compression:${auth.sessionId}:${randomUUID().slice(0, 8)}`,
  }, cancelled.signal)
  logger.info({
    sessionId: auth.sessionId,
    profile: auth.profile,
    model: plan.model,
    provider: plan.provider,
    records: input.records.length,
    ok: outcome.ok,
    ...(outcome.ok ? { seconds: outcome.seconds, chunks: outcome.chunks, summaryChars: outcome.summary.length } : { reason: outcome.reason }),
  }, '[claude-summary] auxiliary summary')
  if (!res.destroyed) res.end(JSON.stringify(outcome))
}

/**
 * POST {CLAUDE_CONTEXT_API}/settings — the effective Claude compression settings as the wrapper's
 * env names. A Studio run (and its launch env) outlives turns; the wrapper asks on every turn so
 * a settings change applies to the next message.
 */
export async function claudeContextSettings(ctx: Context): Promise<void> {
  const auth = authorize(ctx)
  if (!auth) return
  const settings = await resolveClaudeCompressionSettings(getWebUiHome(), auth.profile)
  reply(ctx, 200, { ok: true, env: claudeCompressionEnv(settings.effective) })
}
