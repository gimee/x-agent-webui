// hermes-v050:T6 — Hermes session slash-command receipts carry a stable
// `messageCode` plus `messageParams` next to the server's English `message`
// (live on the session.command event, and persisted as `command_data` so a
// reload keeps the code). Known codes render in the UI language; an unknown
// code, missing or mistyped params, or no code at all returns null so the
// caller shows the server's English text unchanged.

type Translate = (key: string, params?: Record<string, unknown>) => string

type CommandData = Record<string, unknown> | null | undefined

type Params = Record<string, unknown>

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isString = (value: unknown): value is string => typeof value === 'string'
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString)

function textOf(params: Params, key: string): string | null {
  return isString(params[key]) ? params[key] as string : null
}

function numberOf(params: Params, key: string): number | null {
  return isNumber(params[key]) ? params[key] as number : null
}

function withError(t: Translate, key: string, params: Params): string | null {
  const error = textOf(params, 'error')
  return error == null ? null : t(key, { error })
}

function withName(t: Translate, key: string, params: Params): string | null {
  const name = textOf(params, 'name')
  return name ? t(key, { name }) : null
}

function stateText(running: boolean, t: Translate): string {
  return running ? t('chat.hermesCommand.stateRunning') : t('chat.hermesCommand.stateIdle')
}

function statusText(params: Params, t: Translate): string | null {
  const source = textOf(params, 'source')
  const profile = textOf(params, 'profile')
  const model = textOf(params, 'model')
  const run = textOf(params, 'run')
  const queue = numberOf(params, 'queue')
  if (typeof params.running !== 'boolean' || source == null || profile == null || model == null || run == null || queue == null) return null
  const values = { state: stateText(params.running, t), source, profile, model, queue, run }
  if (params.bridge === 'running' || params.bridge === 'idle') {
    return t('chat.hermesCommand.statusWithBridge', { ...values, bridge: stateText(params.bridge === 'running', t) })
  }
  return params.bridge == null ? t('chat.hermesCommand.status', values) : null
}

function goalStatusText(params: Params, t: Translate): string | null {
  // Mirrors the server's formatGoalStatusMessage. The first line is the
  // bridge's own goal text and stays as written.
  const text = textOf(params, 'text')
  if (text == null || typeof params.running !== 'boolean') return null
  const runId = params.runId == null ? null : textOf(params, 'runId')
  if (params.runId != null && runId == null) return null
  const lines = [text]
  if (params.running) {
    const turn = params.turn && typeof params.turn === 'object' ? params.turn as Params : null
    const current = turn ? numberOf(turn, 'current') : null
    const max = turn ? numberOf(turn, 'max') : null
    const used = turn ? numberOf(turn, 'used') : null
    lines.push(current != null && max != null && used != null
      ? t('chat.hermesCommand.goalTurnProgress', { current, max, used })
      : t('chat.hermesCommand.goalTurnRunning'))
  }
  const state = stateText(params.running, t)
  lines.push(runId ? t('chat.hermesCommand.goalRunWithId', { state, runId }) : t('chat.hermesCommand.goalRun', { state }))
  return lines.filter(Boolean).join('\n')
}

function skillsReloadedText(params: Params, t: Translate): string | null {
  // Mirrors the server's formatReloadSkillsMessage; skill names and
  // descriptions stay as written.
  if (!isStringList(params.added) || !isStringList(params.removed)) return null
  const total = params.total == null ? null : numberOf(params, 'total')
  if (params.total != null && total == null) return null
  const lines = [t('chat.hermesCommand.skillsReloaded')]
  if (!params.added.length && !params.removed.length) {
    lines.push(total == null ? t('chat.hermesCommand.skillsNoChanges') : t('chat.hermesCommand.skillsNoChangesTotal', { total }))
    return lines.join('\n')
  }
  if (params.added.length) {
    lines.push(t('chat.hermesCommand.skillsAdded'))
    for (const item of params.added) lines.push(`- ${item}`)
  }
  if (params.removed.length) {
    lines.push(t('chat.hermesCommand.skillsRemoved'))
    for (const item of params.removed) lines.push(`- ${item}`)
  }
  if (total != null) lines.push(t('chat.hermesCommand.skillsTotal', { total }))
  return lines.join('\n')
}

export function formatHermesCommandResultText(data: CommandData, t: Translate): string | null {
  if (!data || typeof data !== 'object') return null
  const code = typeof data.messageCode === 'string' ? data.messageCode : ''
  if (!code.startsWith('hermes_')) return null
  const params: Params = data.messageParams && typeof data.messageParams === 'object' && !Array.isArray(data.messageParams)
    ? data.messageParams as Params
    : {}

  switch (code) {
    case 'hermes_skill_usage': return t('chat.hermesCommand.skillUsage')
    case 'hermes_bundles_usage': return t('chat.hermesCommand.bundlesUsage')
    case 'hermes_bundles_create_hint': return t('chat.hermesCommand.bundlesCreateHint')
    case 'hermes_skill_failed': return withError(t, 'chat.hermesCommand.skillFailed', params)
    case 'hermes_bundle_failed': return withError(t, 'chat.hermesCommand.bundleFailed', params)
    case 'hermes_bundle_not_found': return withName(t, 'chat.hermesCommand.bundleNotFound', params)
    case 'hermes_skill_is_bundle': return withName(t, 'chat.hermesCommand.skillIsBundle', params)
    case 'hermes_unknown_command': return withName(t, 'chat.hermesCommand.unknownCommand', params)
    case 'hermes_bridge_command_unsupported': return withName(t, 'chat.hermesCommand.bridgeCommandUnsupported', params)
    case 'hermes_learn_failed': return withError(t, 'chat.hermesCommand.learnFailed', params)
    case 'hermes_learn_unavailable': return t('chat.hermesCommand.learnUnavailable')
    case 'hermes_moa_usage': return t('chat.hermesCommand.moaUsage')
    case 'hermes_moa_queued': {
      const preset = textOf(params, 'preset')
      return preset ? t('chat.hermesCommand.moaQueued', { preset }) : null
    }
    case 'hermes_usage': {
      const input = numberOf(params, 'input')
      const output = numberOf(params, 'output')
      const total = numberOf(params, 'total')
      return input == null || output == null || total == null ? null : t('chat.hermesCommand.usage', { input, output, total })
    }
    case 'hermes_context': {
      const input = numberOf(params, 'input')
      const output = numberOf(params, 'output')
      const total = numberOf(params, 'total')
      const window = numberOf(params, 'window')
      const percent = numberOf(params, 'percent')
      return input == null || output == null || total == null || window == null || percent == null
        ? null
        : t('chat.hermesCommand.context', { input, output, total, window, percent })
    }
    case 'hermes_status': return statusText(params, t)
    case 'hermes_yolo_unavailable': return t('chat.hermesCommand.yoloUnavailable')
    case 'hermes_yolo_on': return t('chat.hermesCommand.yoloOn')
    case 'hermes_yolo_off': return t('chat.hermesCommand.yoloOff')
    case 'hermes_yolo_failed': return withError(t, 'chat.hermesCommand.yoloFailed', params)
    case 'hermes_abort_requested': return t('chat.hermesCommand.abortRequested')
    case 'hermes_queue_usage': return t('chat.hermesCommand.queueUsage')
    case 'hermes_queue_idle': return t('chat.hermesCommand.queueIdle')
    case 'hermes_queue_queued': {
      const length = numberOf(params, 'length')
      return length == null ? null : t('chat.hermesCommand.queueQueued', { length })
    }
    case 'hermes_plan_failed': return withError(t, 'chat.hermesCommand.planFailed', params)
    case 'hermes_plan_unavailable': return t('chat.hermesCommand.planUnavailable')
    case 'hermes_goal_busy': return t('chat.hermesCommand.goalBusy')
    case 'hermes_goal_failed': return withError(t, 'chat.hermesCommand.goalFailed', params)
    case 'hermes_goal_status': return goalStatusText(params, t)
    case 'hermes_clear_busy': return t('chat.hermesCommand.clearBusy')
    case 'hermes_clear_history_done': {
      const count = numberOf(params, 'count')
      return count == null ? null : t('chat.hermesCommand.clearHistoryDone', { count })
    }
    case 'hermes_clear_display_done': return t('chat.hermesCommand.clearDisplayDone')
    case 'hermes_title_usage': return t('chat.hermesCommand.titleUsage')
    case 'hermes_title_updated': {
      const title = textOf(params, 'title')
      return title == null ? null : t('chat.hermesCommand.titleUpdated', { title })
    }
    case 'hermes_title_not_found': return t('chat.hermesCommand.titleNotFound')
    case 'hermes_compress_busy': return t('chat.hermesCommand.compressBusy')
    case 'hermes_compress_done': {
      const beforeMessages = numberOf(params, 'beforeMessages')
      const resultMessages = numberOf(params, 'resultMessages')
      const beforeTokens = numberOf(params, 'beforeTokens')
      const afterTokens = numberOf(params, 'afterTokens')
      return beforeMessages == null || resultMessages == null || beforeTokens == null || afterTokens == null
        ? null
        : t('chat.hermesCommand.compressDone', { beforeMessages, resultMessages, beforeTokens, afterTokens })
    }
    case 'hermes_compress_failed': return withError(t, 'chat.hermesCommand.compressFailed', params)
    case 'hermes_branch_busy': return t('chat.hermesCommand.branchBusy')
    case 'hermes_branch_coding_agent': return t('chat.hermesCommand.branchCodingAgent')
    case 'hermes_branch_empty': return t('chat.hermesCommand.branchEmpty')
    case 'hermes_branch_done': {
      const title = textOf(params, 'title')
      const parent = textOf(params, 'parent')
      return title == null || parent == null ? null : t('chat.hermesCommand.branchDone', { title, parent })
    }
    case 'hermes_steer_usage': return t('chat.hermesCommand.steerUsage')
    case 'hermes_steer_idle': return t('chat.hermesCommand.steerIdle')
    case 'hermes_steer_sent': return t('chat.hermesCommand.steerSent')
    case 'hermes_mcp_reload_busy': return t('chat.hermesCommand.mcpReloadBusy')
    case 'hermes_mcp_reloaded': {
      if (params.server == null) return t('chat.hermesCommand.mcpReloadedAll')
      const server = textOf(params, 'server')
      return server ? t('chat.hermesCommand.mcpReloaded', { server }) : null
    }
    case 'hermes_mcp_reload_failed': return withError(t, 'chat.hermesCommand.mcpReloadFailed', params)
    case 'hermes_skills_reload_busy': return t('chat.hermesCommand.skillsReloadBusy')
    case 'hermes_skills_reloaded': return skillsReloadedText(params, t)
    case 'hermes_skills_reload_failed': return withError(t, 'chat.hermesCommand.skillsReloadFailed', params)
    case 'hermes_skills_reload_unsupported': return t('chat.hermesCommand.skillsReloadUnsupported')
    case 'hermes_destroy_done':
      if (typeof params.stoppedRun !== 'boolean') return null
      return params.stoppedRun ? t('chat.hermesCommand.destroyDoneStopped') : t('chat.hermesCommand.destroyDone')
    case 'hermes_destroy_unreachable': {
      if (params.error == null || params.error === '') return t('chat.hermesCommand.destroyUnreachable')
      const error = textOf(params, 'error')
      return error == null ? null : t('chat.hermesCommand.destroyUnreachableWithError', { error })
    }
    default:
      return null
  }
}

/**
 * The persisted `command_data` of a command row ({messageCode, messageParams}
 * as JSON), as the `commandData` a live receipt carries. Anything else, or
 * nothing, adds no field.
 */
export function hermesCommandDataFields(raw: unknown): { commandData?: Record<string, unknown> } {
  let value: unknown = raw
  if (typeof raw === 'string') {
    if (!raw) return {}
    try {
      value = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  if (typeof record.messageCode !== 'string' || !record.messageCode) return {}
  return { commandData: record }
}
