import { constants, promises as fs } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { claudeCompressionEnv, resolveClaudeCompressionSettings } from './claude-compression-settings'

export interface ClaudeContextLaunchOptions {
  mode: string
  model?: string
  profile: string
  // Studio identity must already exist; the native Claude session may still be new.
  sessionId?: string
  parentSessionId?: string
  workspaceDir: string
  configDir: string
  webUiHome: string
  realCommand: string
  nodeCommand: string
  wrapperPath: string
  args: string[]
  env: NodeJS.ProcessEnv
  /** hermes-v051:A internal summary endpoint and this launch's bearer token (claude-summary/tokens.ts). */
  summary?: { url: string; token: string }
}

export interface ClaudeContextLaunch {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  managed: boolean
  unsupportedReason?: string
}

async function entry(path: string) {
  try { return await fs.lstat(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function policyReason(workspaceDir: string, configDir: string): Promise<string | undefined> {
  try {
    if (await entry('/etc/claude-code/managed-settings.json')) return 'managed-settings'
    const userPath = join(configDir, 'settings.json')
    const user = await entry(userPath) ? await fs.stat(userPath) : undefined
    const seen = new Set<string>()
    // Inspect both lexical and real ancestry, all the way to /, not only to .git.
    for (let dir of [resolve(workspaceDir), await fs.realpath(workspaceDir)]) {
      while (!seen.has(dir)) {
        seen.add(dir)
        for (const name of ['settings.json', 'settings.local.json']) {
          const path = join(dir, '.claude', name)
          if (!await entry(path)) continue
          const file = name === 'settings.json' && user ? await fs.stat(path) : undefined
          if (!file || file.dev !== user!.dev || file.ino !== user!.ino) return 'project-settings'
        }
        dir = dirname(dir)
      }
    }
  } catch { return 'policy-inspection-failed' }
}

// Same capability rule as bin/claude-context/models.mjs (keep in sync): Claude 5+
// opus/sonnet/fable ids are 1M-context models, so future ids need no release.
const MANAGED_FAMILY = /^claude-(?:opus|sonnet|fable)-(\d+)(?:-\d+)?$/

async function modelOverrides(stateRoot: string): Promise<{ include: string[], exclude: string[] }> {
  try {
    const value = JSON.parse(await fs.readFile(join(stateRoot, 'models.json'), 'utf8'))
    const list = (key: string) => Array.isArray(value?.[key]) ? value[key].filter((x: unknown): x is string => typeof x === 'string') : []
    return { include: list('include'), exclude: list('exclude') }
  } catch { return { include: [], exclude: [] } }
}

export function isManagedClaudeModel(model: string | undefined, overrides = { include: [] as string[], exclude: [] as string[] }): boolean {
  if (!model) return false
  const bare = model.endsWith('[1m]') ? model.slice(0, -4) : model
  if (overrides.exclude.includes(model) || overrides.exclude.includes(bare)) return false
  if (/^[^\s\[\]]+\[1m\]$/.test(model)) return true
  const match = MANAGED_FAMILY.exec(model)
  return (!!match && Number(match[1]) >= 5) || overrides.include.includes(model)
}

/** Linux global: Claude 5+ family ids or explicit [1m], plus operator models.json overrides.
 * <stateRoot>/DISABLED turns every launch back to native immediately, without a rebuild.
 * User settings remain untouched. Unknown policy stays native; broken managed assets throw.
 */
export async function prepareClaudeContextLaunch(options: ClaudeContextLaunchOptions): Promise<ClaudeContextLaunch> {
  const native = (unsupportedReason: string): ClaudeContextLaunch => ({
    command: options.realCommand, args: options.args, env: options.env, managed: false, unsupportedReason,
  })
  if (options.mode !== 'global') return native('unsupported-mode')
  if (process.platform !== 'linux') return native('unsupported-platform')
  if (!options.sessionId) return native('missing-session-id')
  if (options.parentSessionId) return native('forked-session')
  // All profiles share native-session ownership; only the wrapper scopes checkpoints.
  const stateRoot = join(options.webUiHome, 'coding-agent', 'claude-context')
  if (await entry(join(stateRoot, 'DISABLED')).catch(() => undefined)) return native('disabled')
  if (!isManagedClaudeModel(options.model, await modelOverrides(stateRoot))) return native('unsupported-model')
  for (const key of ['realCommand', 'nodeCommand', 'wrapperPath', 'workspaceDir', 'configDir', 'webUiHome'] as const) {
    if (!isAbsolute(options[key])) throw new Error(`Claude context launch: ${key} must be absolute`)
  }
  let sourceCount = 0
  for (let i = 0; i < options.args.length; i++) {
    const arg = options.args[i]
    if (arg === '--') return native('unsupported-setting-sources')
    if (arg !== '--setting-sources' && !arg.startsWith('--setting-sources=')) continue
    const value = arg === '--setting-sources' ? options.args[++i] : arg.slice('--setting-sources='.length)
    if (++sourceCount > 1 || value !== 'user') return native('unsupported-setting-sources')
  }
  const reason = await policyReason(options.workspaceDir, options.configDir)
  if (reason) return native(reason)
  for (const key of ['realCommand', 'nodeCommand', 'wrapperPath'] as const) {
    try {
      if (!(await fs.stat(options[key])).isFile()) throw new Error('not a regular file')
      await fs.access(options[key], key === 'wrapperPath' ? constants.R_OK : constants.X_OK)
    } catch (cause) { throw new Error(`Claude context launch: unusable ${key}`, { cause }) }
  }
  await fs.mkdir(options.webUiHome, { recursive: true, mode: 0o700 })
  for (const path of [dirname(stateRoot), stateRoot]) {
    try { await fs.mkdir(path, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const stat = await fs.lstat(path)
    if (!stat.isDirectory() || (path === stateRoot && (stat.mode & 0o077) !== 0)) {
      throw new Error(`Claude context launch: unsafe state directory ${path}`)
    }
  }
  // hermes-v051:C effective Claude compression settings for this launch (the wrapper also re-reads
  // them every turn); a resolution failure leaves them out, so the wrapper keeps the v0.5.0 numbers.
  const compression = await resolveClaudeCompressionSettings(options.webUiHome, options.profile)
    .then(settings => claudeCompressionEnv(settings.effective), () => ({}))
  return {
    command: options.nodeCommand, managed: true,
    args: [options.wrapperPath, ...options.args, ...(sourceCount ? [] : ['--setting-sources', 'user'])],
    env: {
      ...options.env, HERMES_CC_REAL_BIN: options.realCommand, HERMES_CC_STATE_DIR: stateRoot,
      CLAUDE_CONFIG_DIR: options.configDir, HERMES_CC_PROFILE_ID: options.profile,
      HERMES_STUDIO_SESSION_ID: options.sessionId, HERMES_WEB_UI_HOME: options.webUiHome,
      HERMES_WEBUI_STATE_DIR: options.webUiHome, ELECTRON_RUN_AS_NODE: '1', ...compression,
      // hermes-v051:A the wrapper removes both before starting any native Claude child.
      ...(options.summary ? { HERMES_CC_SUMMARY_URL: options.summary.url, HERMES_CC_SUMMARY_TOKEN: options.summary.token } : {}),
    },
  }
}
