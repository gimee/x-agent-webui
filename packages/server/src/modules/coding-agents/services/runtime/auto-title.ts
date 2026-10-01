/**
 * hermes-v051:T1 titles for coding-agent sessions (Claude Code / Codex / Pi).
 *
 * Hermes titles its own sessions from the bridge; coding-agent turns never go through it, so these
 * sessions kept an empty title (the sidebar shows the first-line preview). After a completed turn
 * this asks the bridge `generate_title` action (Hermes' auxiliary title model, with the T0
 * reasoning-floor retry) to name the session from its first user message — the input Hermes titles
 * from. Same budget as the Agent: turn 1, then turns 2-3 while the title is still a placeholder
 * (R3-07: a retry adds the current user turn to the first message, and stops after a deterministic
 * failure such as a disabled title model). A title the user typed is never replaced. Any failure
 * keeps the placeholder and is only logged.
 */
import { getFirstSessionMessageByRole, getSession, getSessionMessageCountByRole, updateSession } from '../../../studio/public/sessions'
import { isAnswerShapedTitle, isReplaceableLocalTitle, normalizeTitleText } from '../../../studio/public/session-title'
import { createPrimaryAgentBridge } from '../../../studio/public/chat-agent-runtime'
import { logger } from '../../../studio/public/logging'

/** Agent rule: a placeholder title is retried through the third user turn. */
export const CODING_AGENT_TITLE_MAX_USER_TURNS = 3
/** One title call (aux timeout 30 s) plus the floored retry, with room for a cold worker start. */
export const CODING_AGENT_TITLE_TIMEOUT_MS = 90_000
/** Hermes hands the title model at most 1000 characters of the opening message. */
const TITLE_INPUT_CHARS = 1000
/** hermes-v051:T1 R3-07 share of that budget kept for the first message when the current turn rides along. */
const FIRST_MESSAGE_CHARS = 400
/** hermes-v051:T1 R3-07 failures a retry cannot fix (title model switched off, Hermes API missing). */
const DETERMINISTIC_TITLE_FAILURES = new Set(['disabled', 'unavailable'])
const MAX_STOPPED_SESSIONS = 5000

interface TitleMessage {
  role?: unknown
  content?: unknown
}

export interface CodingAgentAutoTitleTarget {
  sessionId: string
  profile?: string
  agentId?: string
  /** The run's messages; the last user message is the current turn. */
  messages?: ReadonlyArray<TitleMessage>
  /** Current turn text captured at schedule time (wins over `messages`). */
  latestUserText?: string
}

export type CodingAgentTitleEmit = (sessionId: string, event: string, payload: Record<string, unknown>) => void

const inFlight = new Set<string>()
const stoppedSessions = new Set<string>()

function userMessageText(content: unknown): string {
  const text = typeof content === 'string' ? content.trim() : ''
  if (!text.startsWith('[')) return text
  // Multimodal turns are stored as a JSON content-block array (contentBlocksToString).
  try {
    const blocks = JSON.parse(text)
    if (!Array.isArray(blocks)) return text
    return blocks
      .filter(block => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text.trim())
      .filter(Boolean)
      .join('\n')
  } catch {
    return text
  }
}

function latestUserMessageText(messages: ReadonlyArray<TitleMessage> | undefined): string {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const text = userMessageText(message.content)
    if (text) return text
  }
  return ''
}

/** hermes-v051:T1 R3-07 first message, plus the current turn on a retry, within the Hermes budget. */
function titleInput(first: string, latest: string): string {
  if (!latest || normalizeTitleText(latest) === normalizeTitleText(first)) return first.slice(0, TITLE_INPUT_CHARS)
  if (!first) return latest.slice(0, TITLE_INPUT_CHARS)
  const head = first.slice(0, FIRST_MESSAGE_CHARS)
  return `${head}\n\n${latest.slice(0, Math.max(0, TITLE_INPUT_CHARS - head.length - 2))}`
}

function isTitleable(sessionId: string): boolean {
  if (stoppedSessions.has(sessionId)) return false
  const session = getSession(sessionId)
  if (!session || session.source !== 'coding_agent') return false
  const userTurns = getSessionMessageCountByRole(sessionId, 'user')
  if (userTurns < 1 || userTurns > CODING_AGENT_TITLE_MAX_USER_TURNS) return false
  return isReplaceableLocalTitle(sessionId)
}

/** Generate and store the title once; resolves to the stored title or null. Never rejects. */
export async function runCodingAgentAutoTitle(
  target: CodingAgentAutoTitleTarget,
  emit: CodingAgentTitleEmit,
): Promise<string | null> {
  const sessionId = String(target?.sessionId || '').trim()
  if (!sessionId) return null
  try {
    if (!isTitleable(sessionId)) return null
    const first = userMessageText(getFirstSessionMessageByRole(sessionId, 'user')?.content)
    const input = titleInput(first, target.latestUserText ?? latestUserMessageText(target.messages))
    if (!input) return null

    const bridge = createPrimaryAgentBridge({ timeoutMs: CODING_AGENT_TITLE_TIMEOUT_MS })
    const result = await bridge.generateTitle(input, target.profile || undefined, { timeoutMs: CODING_AGENT_TITLE_TIMEOUT_MS })
    const title = normalizeTitleText(result?.title)
    if (!title) {
      const reason = String(result?.reason || 'no_title')
      if (DETERMINISTIC_TITLE_FAILURES.has(reason)) {
        if (stoppedSessions.size >= MAX_STOPPED_SESSIONS) stoppedSessions.clear()
        stoppedSessions.add(sessionId)
      }
      logger.info({ sessionId, agentId: target.agentId, reason }, '[coding-agent-title] kept placeholder title')
      return null
    }
    // hermes-v051:T3 checked on the raw text: normalizing would hide a line break.
    if (isAnswerShapedTitle(result.title)) {
      logger.info({ sessionId, agentId: target.agentId }, '[coding-agent-title] rejected answer-shaped title')
      return null
    }
    // The user may have renamed the session while the model was running.
    if (!isTitleable(sessionId)) return null
    updateSession(sessionId, { title })
    emit(sessionId, 'session.title.updated', {
      event: 'session.title.updated',
      session_id: sessionId,
      title,
    })
    return title
  } catch (err) {
    logger.info({ sessionId, agentId: target?.agentId, err: (err as Error)?.message }, '[coding-agent-title] title generation unavailable')
    return null
  }
}

/**
 * Fire-and-forget entry for the turn-completion path: never throws, one request per session.
 * `messages` are the run's messages; the current user turn is read from them right away.
 */
export function scheduleCodingAgentAutoTitle(
  target: CodingAgentAutoTitleTarget,
  emit: CodingAgentTitleEmit,
  messages?: ReadonlyArray<TitleMessage>,
): void {
  try {
    const sessionId = String(target?.sessionId || '').trim()
    if (!sessionId || inFlight.has(sessionId)) return
    inFlight.add(sessionId)
    const snapshot: CodingAgentAutoTitleTarget = {
      sessionId,
      profile: target.profile,
      agentId: target.agentId,
      latestUserText: latestUserMessageText(messages ?? target.messages),
    }
    void runCodingAgentAutoTitle(snapshot, emit).finally(() => inFlight.delete(sessionId))
  } catch (err) {
    logger.debug({ err: (err as Error)?.message }, '[coding-agent-title] schedule failed')
  }
}
