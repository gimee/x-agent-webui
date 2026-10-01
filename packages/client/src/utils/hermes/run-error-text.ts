// hermes-v050:T10 — run.failed / run.reattach_failed carry a stable
// `error_code` (+ `error_params`: exit code, raw detail) next to the server's
// English `error` / `text`. Known codes map to chat.errors.* in the UI
// language; anything else keeps the server text. Agent names are shown as
// Claude / Codex / Pi (the client never shows the upstream CLI brand).
import { getActivePinia } from 'pinia'
import type { App } from 'vue'

type Translate = (key: string, params?: Record<string, unknown>) => string

type RunErrorEvent = { error?: unknown; error_code?: unknown; error_params?: unknown } | null | undefined

const AGENT_NAMES: Record<string, string> = { 'claude-code': 'Claude', claude: 'Claude', codex: 'Codex', pi: 'Pi' }

function paramsOf(evt: NonNullable<RunErrorEvent>): Record<string, unknown> {
  const params = evt.error_params
  return params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {}
}

function detailOf(params: Record<string, unknown>): string | null {
  return typeof params.detail === 'string' ? params.detail : null
}

export function formatRunErrorText(evt: RunErrorEvent, t: Translate): string | null {
  if (!evt || typeof evt !== 'object' || typeof evt.error_code !== 'string') return null
  const params = paramsOf(evt)
  switch (evt.error_code) {
    case 'hermes_runtime_not_installed':
      return t('chat.errors.hermesRuntimeNotInstalled')
    case 'hermes_runtime_unavailable': {
      const detail = detailOf(params)
      return detail == null ? null : t('chat.errors.hermesRuntimeUnavailable', { detail })
    }
    case 'agent_bridge_unreachable': {
      const detail = detailOf(params)
      return detail == null ? null : t('chat.errors.agentBridgeUnreachable', { detail })
    }
    case 'agent_bridge_status_unconfirmed': {
      const detail = detailOf(params)
      return detail == null ? null : t('chat.errors.agentBridgeStatusUnconfirmed', { detail })
    }
    case 'coding_agent_exited': {
      const agent = typeof params.agent === 'string' && Object.prototype.hasOwnProperty.call(AGENT_NAMES, params.agent)
        ? AGENT_NAMES[params.agent]
        : null
      const exitCode = params.exit_code
      if (!agent || (exitCode !== null && !(typeof exitCode === 'number' && Number.isFinite(exitCode)))) return null
      const code = exitCode === null ? t('chat.errors.exitCodeUnknown') : exitCode
      const detail = detailOf(params)
      return detail
        ? t('chat.errors.codingAgentExitedWithDetail', { agent, code, detail })
        : t('chat.errors.codingAgentExited', { agent, code })
    }
    case 'coding_agent_run_failed':
      return t('chat.errors.codingAgentRunFailed')
    case 'claude_api_error':
      return t('chat.errors.claudeApiError')
    case 'codex_run_failed':
      return t('chat.errors.codexRunFailed')
    default:
      return null
  }
}

// Stores are not components, so they cannot call useI18n(). The app that
// installed Pinia exposes vue-i18n's global $t / $te; without it (unit tests,
// detached stores) the caller keeps the server's English text.
function appTranslate(): { t: Translate; missing: () => boolean } | null {
  const app = (getActivePinia() as { _a?: App } | undefined)?._a
  const globals = app?.config?.globalProperties as Record<string, any> | undefined
  const $t = globals?.$t
  const $te = globals?.$te
  if (typeof $t !== 'function' || typeof $te !== 'function') return null
  let missing = false
  return {
    t: (key, params) => {
      if (!$te(key)) {
        missing = true
        return ''
      }
      return params ? $t(key, params) : $t(key)
    },
    missing: () => missing,
  }
}

function translated(evt: RunErrorEvent): string | null {
  const translator = appTranslate()
  if (!translator) return null
  const text = formatRunErrorText(evt, translator.t)
  return text && !translator.missing() ? text : null
}

/** The error to show for a run.failed event: its translation, or the server's `error` as before. */
export function runErrorForDisplay(evt: RunErrorEvent): unknown {
  return translated(evt) ?? evt?.error
}

/** The translated text of a coded run.reattach_failed warning, or null to keep the server text. */
export function runEventTextForDisplay(evt: { event?: unknown } & NonNullable<RunErrorEvent>): string | null {
  return evt?.event === 'run.reattach_failed' ? translated(evt) : null
}
