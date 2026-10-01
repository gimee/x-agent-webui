import {
  getSession,
  getSessionDetailPaginated,
} from '../../repositories/session-store'
import { getRecordedUsageTotals, getUsage } from '../../repositories/usage-store'
import { logger } from '../../public/logging'
import { handleMessage } from './message-format'
import { estimateUsageTokensFromMessages } from './usage'
import type { ChatRunSource, SessionState } from './types'

function restoreBackgroundDelegations(messages: any[]): SessionState['backgroundDelegations'] {
  const delegations: NonNullable<SessionState['backgroundDelegations']> = {}
  for (const message of messages) {
    if (message.role !== 'tool' || message.tool_name !== 'delegate_task') continue
    try {
      const payload = JSON.parse(String(message.content || '')) as Record<string, unknown>
      const delegationId = String(payload.delegation_id || '').trim()
      if (payload.mode !== 'background' || !delegationId) continue
      let status: 'running' | 'completed' | 'failed' | 'interrupted' = 'running'
      if (message.display_content) {
        const display = JSON.parse(String(message.display_content)) as Record<string, unknown>
        const displayStatus = String(display.status || '').toLowerCase()
        if (displayStatus === 'completed') status = 'completed'
        else if (displayStatus === 'failed' || displayStatus === 'error') status = 'failed'
        else if (displayStatus === 'interrupted' || displayStatus === 'cancelled') status = 'interrupted'
      }
      delegations[delegationId] = {
        delegationId,
        status,
        updatedAt: Number(message.timestamp || 0) * 1000 || Date.now(),
        toolCallId: String(message.tool_call_id || '').trim() || undefined,
        messageId: message.id,
        dispatchPayload: payload,
      }
    } catch {
      // Non-JSON delegate results are not background dispatch records.
    }
  }
  return delegations
}

export function resolveRunSource(source?: string, sessionId?: string): ChatRunSource {
  if (source === 'coding_agent' || source === 'global_agent' || source === 'cli') return source
  if (sessionId) {
    const stored = getSession(sessionId)?.source
    if (stored === 'coding_agent' || stored === 'global_agent' || stored === 'cli') return stored
  }
  return 'cli'
}

export async function loadSessionStateFromDb(sid: string, _sessionMap: Map<string, SessionState>): Promise<SessionState> {
  try {
    const displayStartedAt = Date.now()
    const actualDetail = getSessionDetailPaginated(sid)
    if (!actualDetail) throw new Error(`Session not found: ${sid}`)

    const messages = actualDetail?.messages ? handleMessage(actualDetail.messages, sid) : []
    const displayElapsedMs = Date.now() - displayStartedAt
    const displayPayload = {
      sessionId: sid,
      rows: actualDetail?.messages.length || 0,
      total: actualDetail?.total || 0,
      elapsedMs: displayElapsedMs,
    }
    logger.info(displayPayload, '[chat-run-socket] display page loaded')
    if (displayElapsedMs > 1_000) logger.warn(displayPayload, '[chat-run-socket] slow display page load')

    let inputTokens: number
    let outputTokens: number
    let contextTokens: number | undefined
    const session = actualDetail?.session || getSession(sid)
    const usageSource = session?.source === 'coding_agent' || ['codex', 'pi', 'claude', 'claude-code', 'claude_code'].includes(session?.agent || '')
      ? 'coding_agent'
      : 'hermes'
    const totals = getRecordedUsageTotals(sid, usageSource)
    const latestUsage = getUsage(sid)
    const hasPersistedUsage = !!latestUsage || totals.inputTokens > 0 || totals.outputTokens > 0
    if (hasPersistedUsage) {
      inputTokens = totals.inputTokens
      outputTokens = totals.outputTokens
    } else {
      // Only fall back to js-tiktoken when nothing is persisted: tokenizing a
      // 150-message page (~430KB of text) costs ~3s and blocks the event loop.
      const pageUsage = estimateUsageTokensFromMessages(messages)
      inputTokens = pageUsage.inputTokens
      outputTokens = pageUsage.outputTokens
    }
    if (latestUsage) {
      contextTokens = Number(latestUsage.input_tokens || 0) + Number(latestUsage.output_tokens || 0)
    }
    // hermes-v0.4.5: Claude runs store the last API call's real context size; the usage row above
    // is a whole-run sum without cache reads.
    if (Number(session?.context_tokens || 0) > 0) contextTokens = Number(session!.context_tokens)

    logger.info('[chat-run-socket] loaded session %s from DB (%d messages)', sid, messages.length)
    return {
      messages,
      messageTotal: actualDetail?.total || messages.length,
      messageLoadedCount: actualDetail?.messages.length || messages.length,
      messagePageLimit: actualDetail?.limit,
      messageStateBaselineCount: messages.length,
      hasMoreBefore: actualDetail?.hasMore || false,
      isWorking: false,
      events: [],
      inputTokens,
      outputTokens,
      contextTokens,
      queue: [],
      backgroundDelegations: restoreBackgroundDelegations(messages),
    }
  } catch (err) {
    logger.warn(err, '[chat-run-socket] failed to load session %s from DB', sid)
    // An empty state is not a valid DB snapshot. Let the resume request fail
    // so the client keeps its displayed window instead of clearing history.
    throw err
  }
}
