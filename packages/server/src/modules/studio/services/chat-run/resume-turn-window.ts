// Resume can return the most recent user turns in a single response, avoiding serial page requests.
// The client sends min_turns; only idle sessions are extended with olderMessages.
// Existing message pagination remains unchanged for clients that omit min_turns.
import { countSessionRowsForTurns, getSessionDetailPaginated } from '../../repositories/session-store'
import { handleMessage } from './message-format'
import { buildResumeMessages, type ResumeMessagePage } from './resume-payload'
import type { SessionMessage } from './types'

export const RESUME_MIN_TURNS_MAX = 50
/** 最新页 + 补齐部分合计的行数上限，防止病态会话拼出无界的 payload。 */
export const RESUME_TURN_WINDOW_MAX_ROWS = 5_000

export type TurnWindowResumePage = ResumeMessagePage & { olderMessages?: SessionMessage[] }

export function parseResumeMinTurns(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const turns = Math.floor(value)
  if (turns <= 0) return undefined
  return Math.min(turns, RESUME_MIN_TURNS_MAX)
}

function countResumeTurns(messages: SessionMessage[]): number {
  let turns = 0
  for (const message of messages) {
    if (message.role === 'tool') continue
    const role = String((message as any).display_role || message.role || '')
    if (role === 'user' || role === 'command') turns += 1
  }
  return turns
}

export function extendResumePageToMinTurns(
  sid: string,
  page: ResumeMessagePage,
  minTurns: number,
  options: { maxRows?: number } = {},
): TurnWindowResumePage {
  if (!(minTurns > 0) || !page.hasMoreBefore) return page
  const haveTurns = countResumeTurns(page.messages)
  if (haveTurns >= minTurns) return page
  const offset = page.messageLoadedCount
  const budget = (options.maxRows ?? RESUME_TURN_WINDOW_MAX_ROWS) - offset
  if (budget <= 0) return page
  const rowCount = countSessionRowsForTurns(sid, offset, minTurns - haveTurns, budget)
  if (rowCount <= 0) return page
  const detail = getSessionDetailPaginated(sid, offset, rowCount)
  if (!detail?.messages?.length) return page

  const newestIds = new Set(page.messages.map(message => String(message.id)))
  const olderMessages = buildResumeMessages(handleMessage(detail.messages, sid))
    .filter(message => !newestIds.has(String(message.id)))
  // 游标按数据库行计（与 REST 分页、客户端 loadOlderMessages 的 offset 同口径）
  const messageLoadedCount = Math.min(page.messageTotal, offset + detail.messages.length)
  return {
    ...page,
    olderMessages,
    messageLoadedCount,
    hasMoreBefore: page.messageTotal > messageLoadedCount,
  }
}
