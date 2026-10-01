// hermes-v050:U3 / U16-T5 — coding-agent command receipts carry a stable
// `messageCode` plus the numbers the server already sends. The client renders
// them in the UI language; anything it does not know falls back to the
// server's English `message`, so old clients and old servers keep working.

type Translate = (key: string, params?: Record<string, unknown>) => string

type CommandResultData = Record<string, unknown> | null | undefined

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function hasNumbers(data: Record<string, unknown>, keys: string[]): boolean {
  return keys.every(key => numberOrNull(data[key]) != null)
}

// Brand names are not translated; never show "Claude Code" in client copy.
function agentDisplayName(agentId: unknown): string {
  const id = String(agentId || '').toLowerCase()
  if (id === 'codex') return 'Codex'
  if (id === 'pi') return 'Pi'
  return 'Claude'
}

export function formatCommandResultText(data: CommandResultData, t: Translate): string | null {
  if (!data || typeof data !== 'object') return null
  const code = typeof data.messageCode === 'string' ? data.messageCode : ''
  const error = String(data.error ?? '')

  switch (code) {
    case 'compact_sent':
      return t('chat.commandResult.compactSent', { agent: agentDisplayName(data.agentId) })
    case 'compact_no_change':
      return t('chat.commandResult.compactNoChange')
    case 'compact_done': {
      const before = numberOrNull(data.beforeTokens)
      const after = numberOrNull(data.afterTokens)
      if (before != null && after != null) return t('chat.commandResult.compactDoneBeforeAfter', { before, after })
      if (before != null) return t('chat.commandResult.compactDoneBefore', { before })
      if (after != null) return null
      return t('chat.commandResult.compactDone')
    }
    case 'compact_failed':
      return t('chat.commandResult.compactFailed', { error })
    case 'context':
      if (!hasNumbers(data, ['inputTokens', 'outputTokens', 'totalTokens', 'contextWindow', 'contextPercent'])) return null
      return t('chat.commandResult.context', {
        input: data.inputTokens,
        output: data.outputTokens,
        total: data.totalTokens,
        window: data.contextWindow,
        percent: data.contextPercent,
      })
    case 'context_pi':
      if (!hasNumbers(data, ['contextTokens', 'contextWindow', 'contextPercent'])) return null
      return t('chat.commandResult.contextPi', {
        tokens: data.contextTokens,
        window: data.contextWindow,
        percent: data.contextPercent,
      })
    case 'usage':
      if (!hasNumbers(data, ['inputTokens', 'outputTokens', 'totalTokens'])) return null
      return t('chat.commandResult.usage', { input: data.inputTokens, output: data.outputTokens, total: data.totalTokens })
    case 'usage_pi':
      if (!hasNumbers(data, ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'])) return null
      return t('chat.commandResult.usagePi', {
        input: data.inputTokens,
        output: data.outputTokens,
        cacheRead: data.cacheReadTokens,
        cacheWrite: data.cacheWriteTokens,
        total: data.totalTokens,
      })
    case 'context_failed':
      return t('chat.commandResult.contextFailed', { error })
    case 'usage_failed':
      return t('chat.commandResult.usageFailed', { error })
    default:
      return null
  }
}
