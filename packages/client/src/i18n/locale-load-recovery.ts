// hermes-v050:F-17 语言包加载失败后的恢复。
// 发版后开着的旧页面去加载旧 hash 的语言包会 404；Chrome 还会把失败的模块留在 module map 里
// （Q-3，真浏览器核实：同一 URL 再 import 直接失败、不再发请求），所以页内重试恢复不了，只能整页刷新。
// 这里记下所选语言后刷新一次；同一标签页 60s 内已经为此刷新过就不再刷新（防循环），交给调用方提示。
const RELOAD_MARK_KEY = 'hermes_locale_reload_at'
const RELOAD_GUARD_MS = 60_000
const RELOAD_DELAY_MS = 800

const MODULE_LOAD_FAILURE = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i

export const localeReloadRuntime = {
  reload: () => window.location.reload(),
}

export function isLocaleModuleLoadError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? '')
  return MODULE_LOAD_FAILURE.test(text)
}

function readStorage(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function writeStorage(storage: Storage | undefined, key: string, value: string): boolean {
  try {
    storage?.setItem(key, value)
    return !!storage
  } catch {
    return false
  }
}

type ReloadMark = { at: number; from?: string; to?: string }

function sessionStore(): Storage | undefined {
  return typeof sessionStorage === 'undefined' ? undefined : sessionStorage
}

function readReloadMark(): ReloadMark | null {
  const raw = readStorage(sessionStore(), RELOAD_MARK_KEY)
  if (!raw) return null
  try {
    const mark = JSON.parse(raw) as ReloadMark
    return mark && typeof mark.at === 'number' ? mark : null
  } catch {
    return null
  }
}

function isRecent(mark: ReloadMark | null, now: number): mark is ReloadMark {
  return !!mark && Number.isFinite(mark.at) && now - mark.at >= 0 && now - mark.at < RELOAD_GUARD_MS
}

export function reloadForLocaleUpdate(
  locale: string,
  error: unknown,
  options: { from?: string; reload?: () => void; now?: () => number; delayMs?: number } = {},
): boolean {
  if (!isLocaleModuleLoadError(error)) return false
  const now = (options.now ?? Date.now)()
  if (isRecent(readReloadMark(), now)) return false
  // 记不下防循环标记就不自动刷新（否则可能一直刷新下去）
  const mark: ReloadMark = { at: now, from: options.from, to: locale }
  if (!writeStorage(sessionStore(), RELOAD_MARK_KEY, JSON.stringify(mark))) return false
  writeStorage(typeof localStorage === 'undefined' ? undefined : localStorage, 'hermes_locale', locale)
  const reload = options.reload ?? localeReloadRuntime.reload
  setTimeout(() => reload(), options.delayMs ?? RELOAD_DELAY_MS)
  return true
}

// 刚为切换语言自动刷新过、而新页面启动时仍加载不了所选语言：返回刷新前的语言，让启动退回它
export function localeBeforeFailedSwitchReload(bootLocale: string, now = Date.now()): string | null {
  const mark = readReloadMark()
  if (!isRecent(mark, now) || mark.to !== bootLocale || !mark.from || mark.from === bootLocale) return null
  return mark.from
}
