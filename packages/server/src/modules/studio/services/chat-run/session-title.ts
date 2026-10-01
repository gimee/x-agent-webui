/**
 * Session title helpers shared by the Hermes bridge title sync (handle-bridge-run) and the
 * coding-agent auto title (hermes-v051:T1).
 */
import { getFirstSessionMessageByRole, getSession } from '../../repositories/session-store'

export function normalizeTitleText(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function fallbackTitleFromText(text: string, limit: number, ellipsis: boolean): string {
  const normalized = normalizeTitleText(text)
  if (!normalized) return ''
  if (normalized.length <= limit) return normalized
  return ellipsis ? `${normalized.slice(0, limit)}...` : normalized.slice(0, limit)
}

/**
 * True while the stored title is still a local placeholder (empty, or a first-line slice of the
 * preview / first user message). A title the user typed is never replaceable.
 */
export function isReplaceableLocalTitle(sessionId: string): boolean {
  const session = getSession(sessionId)
  if (!session) return false
  const current = normalizeTitleText(session.title)
  if (!current) return true
  const variants = new Set<string>([''])
  const preview = normalizeTitleText(session.preview)
  if (preview) {
    variants.add(preview)
    variants.add(fallbackTitleFromText(preview, 40, true))
    variants.add(fallbackTitleFromText(preview, 63, false))
    variants.add(fallbackTitleFromText(preview, 100, false))
  }
  const firstUser = getFirstSessionMessageByRole(sessionId, 'user')
  const firstUserText = normalizeTitleText(firstUser?.content)
  if (firstUserText) {
    variants.add(firstUserText)
    variants.add(fallbackTitleFromText(firstUserText, 40, true))
    variants.add(fallbackTitleFromText(firstUserText, 63, false))
    variants.add(fallbackTitleFromText(firstUserText, 100, false))
  }
  return variants.has(current)
}

// hermes-v051:T3 answer-shaped guard (same rule as bridge_title.looks_like_answer_title): a small
// title model sometimes answers the message instead of naming it. Such output is not adopted and
// the placeholder stays.
export const MAX_TITLE_HAN_CHARS = 30
const HAN_CHARS = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{3134f}]/gu

/** hermes-v051:T3 more than 30 Han characters, a trailing full stop (。 or .), or a line break. */
export function isAnswerShapedTitle(value: unknown): boolean {
  const raw = String(value ?? '')
  if (/[\r\n]/.test(raw)) return true
  const text = raw.trim()
  if (!text) return false
  if (text.endsWith('。') || text.endsWith('.')) return true
  return (text.match(HAN_CHARS)?.length ?? 0) > MAX_TITLE_HAN_CHARS
}
