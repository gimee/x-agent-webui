// hermes-v051:C Claude compression settings (Agent 管理 → Claude → 压缩设置).
// Contract shared by the settings API/UI (owner) and the Claude launch/wrapper (consumer).
// Signatures, field names and env names below are frozen for v0.5.1; only bodies may change.

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  ClaudeCompressionDocument,
  ClaudeCompressionDocumentValues,
  ClaudeCompressionUpdateResult,
} from '../../studio/public/claude-compression'
import { normalizeCompressionSection } from '../../studio/public/compression-config'
import { logger } from '../../studio/public/logging'
import { readConfigYamlForProfile } from '../../studio/public/profile-config'

export interface ClaudeCompressionValues {
  enabled: boolean
  /** Fraction of the 1M window at which the host compacts on a user-turn boundary (applied ≤ 0.8). */
  threshold: number
  /** Retained context after compaction = min(1M × targetRatio, trigger × 0.8). */
  targetRatio: number
  /** Minimum number of most recent raw messages kept verbatim (tool exchanges stay whole). */
  protectLastN: number
  /** Earliest raw messages of the conversation carried by every compaction. */
  protectFirstN: number
}

export interface ClaudeCompressionSettingsView {
  /** true = always follow Settings → Context compression of the session's profile. */
  followMain: boolean
  own: ClaudeCompressionValues
  main: ClaudeCompressionValues
  effective: ClaudeCompressionValues
}

/**
 * Claude's own defaults keep the v0.5.0 trigger (400K) and retention target (80K). New in v0.5.1 are the
 * two floors below (20 recent / 3 opening raw messages) and a retention hard limit of trigger × 0.9.
 */
export const CLAUDE_COMPRESSION_DEFAULTS: Readonly<ClaudeCompressionValues> = Object.freeze({
  enabled: true,
  threshold: 0.4,
  targetRatio: 0.08,
  protectLastN: 20,
  protectFirstN: 3,
})

/** Env names read by bin/claude-context (never forwarded to the native Claude child). */
export const CLAUDE_COMPRESSION_ENV = Object.freeze({
  enabled: 'HERMES_CC_COMPACT_ENABLED',
  threshold: 'HERMES_CC_COMPACT_THRESHOLD',
  targetRatio: 'HERMES_CC_COMPACT_TARGET_RATIO',
  protectLastN: 'HERMES_CC_COMPACT_PROTECT_LAST_N',
  protectFirstN: 'HERMES_CC_COMPACT_PROTECT_FIRST_N',
})

export function claudeCompressionEnv(values: ClaudeCompressionValues): Record<string, string> {
  return {
    [CLAUDE_COMPRESSION_ENV.enabled]: values.enabled ? '1' : '0',
    [CLAUDE_COMPRESSION_ENV.threshold]: String(values.threshold),
    [CLAUDE_COMPRESSION_ENV.targetRatio]: String(values.targetRatio),
    [CLAUDE_COMPRESSION_ENV.protectLastN]: String(values.protectLastN),
    [CLAUDE_COMPRESSION_ENV.protectFirstN]: String(values.protectFirstN),
  }
}

/**
 * Effective values for one Claude launch, resolved on every turn so a main-settings change applies
 * to the next message. Never throws: unreadable/corrupt files fall back to defaults.
 * Reads compression.json (Claude's own values + follow switch) and the profile's config.yaml `compression`.
 */
export async function resolveClaudeCompressionSettings(_webUiHome: string, _profile: string): Promise<ClaudeCompressionSettingsView> {
  return settingsView(await readStoredSettings(_webUiHome), await readMainValues(_profile))
}

// ---- hermes-v051:C storage, main-settings resolution and API document (non-frozen additions) ----

/** Limits of the dialog's number boxes (same min/max as Settings → Context compression); PUT enforces them. */
export const CLAUDE_COMPRESSION_OWN_LIMITS = Object.freeze({
  threshold: Object.freeze({ min: 0.1, max: 0.95 }),
  targetRatio: Object.freeze({ min: 0.05, max: 0.8 }),
  protectLastN: Object.freeze({ min: 0, max: 200 }),
  protectFirstN: Object.freeze({ min: 0, max: 50 }),
})

const NUMERIC_KEYS = ['threshold', 'targetRatio', 'protectLastN', 'protectFirstN'] as const
const WIRE_KEYS = Object.freeze({
  threshold: 'threshold',
  targetRatio: 'target_ratio',
  protectLastN: 'protect_last_n',
  protectFirstN: 'protect_first_n',
} as const)

interface StoredClaudeCompression {
  followMain: boolean
  own: ClaudeCompressionValues
}

export function claudeCompressionSettingsPath(webUiHome: string): string {
  return join(webUiHome, 'coding-agent', 'claude-context', 'compression.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isInteger(key: typeof NUMERIC_KEYS[number]): boolean {
  return key === 'protectLastN' || key === 'protectFirstN'
}

// Hand-edited files: a bad field falls back to its default alone, out-of-range values clamp to the limits.
function ownFromFile(raw: unknown): ClaudeCompressionValues {
  const own = isRecord(raw) ? raw : {}
  const values: ClaudeCompressionValues = {
    ...CLAUDE_COMPRESSION_DEFAULTS,
    enabled: typeof own.enabled === 'boolean' ? own.enabled : CLAUDE_COMPRESSION_DEFAULTS.enabled,
  }
  for (const key of NUMERIC_KEYS) {
    const value = own[WIRE_KEYS[key]]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    const { min, max } = CLAUDE_COMPRESSION_OWN_LIMITS[key]
    values[key] = Math.min(max, Math.max(min, isInteger(key) ? Math.floor(value) : value))
  }
  return values
}

async function readStoredSettings(webUiHome: string): Promise<StoredClaudeCompression> {
  try {
    const value = JSON.parse(await fs.readFile(claudeCompressionSettingsPath(webUiHome), 'utf8'))
    const record = isRecord(value) ? value : {}
    return { followMain: record.follow_main === true, own: ownFromFile(record.own) }
  } catch {
    return { followMain: false, own: { ...CLAUDE_COMPRESSION_DEFAULTS } }
  }
}

// Same read + normalization as Hermes' getRunChatCompressionConfig (chat-run/compression.ts).
async function readMainValues(profile: string): Promise<ClaudeCompressionValues> {
  let raw: unknown
  try {
    raw = (await readConfigYamlForProfile(profile))?.compression
  } catch (err) {
    logger.warn(err, '[claude-compression] failed to read compression config for profile %s, using defaults', profile)
  }
  return normalizeCompressionSection(raw)
}

function settingsView(stored: StoredClaudeCompression, main: ClaudeCompressionValues): ClaudeCompressionSettingsView {
  return { followMain: stored.followMain, own: stored.own, main, effective: { ...(stored.followMain ? main : stored.own) } }
}

function toWire(values: ClaudeCompressionValues): ClaudeCompressionDocumentValues {
  return {
    enabled: values.enabled,
    threshold: values.threshold,
    target_ratio: values.targetRatio,
    protect_last_n: values.protectLastN,
    protect_first_n: values.protectFirstN,
  }
}

function toDocument(view: ClaudeCompressionSettingsView): ClaudeCompressionDocument {
  return { follow_main: view.followMain, own: toWire(view.own), main: toWire(view.main), effective: toWire(view.effective) }
}

async function writeStoredSettings(webUiHome: string, stored: StoredClaudeCompression): Promise<void> {
  const path = claudeCompressionSettingsPath(webUiHome)
  // Same modes as prepareClaudeContextLaunch, which refuses a group/world-accessible state directory.
  await fs.mkdir(webUiHome, { recursive: true, mode: 0o700 })
  for (const dir of [dirname(dirname(path)), dirname(path)]) {
    try { await fs.mkdir(dir, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    // hermes-v051:C same check as prepareClaudeContextLaunch: never write through a symlinked or
    // group/world-accessible state directory that the next Claude launch would refuse anyway.
    const stat = await fs.lstat(dir)
    if (!stat.isDirectory() || (dir === dirname(path) && (stat.mode & 0o077) !== 0)) {
      throw new Error(`Claude compression settings: unsafe state directory ${dir}`)
    }
  }
  // Temp file + rename: readers never see a partial file and a symlink at the target is replaced, not followed.
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    await fs.writeFile(tmp, `${JSON.stringify({ follow_main: stored.followMain, own: toWire(stored.own) }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await fs.rename(tmp, path)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

interface ClaudeCompressionPatch {
  followMain?: boolean
  own: Partial<ClaudeCompressionValues>
}

function parsePatch(body: unknown): ClaudeCompressionPatch | string {
  if (!isRecord(body)) return 'body must be a JSON object'
  const patch: ClaudeCompressionPatch = { own: {} }
  if (body.follow_main !== undefined) {
    if (typeof body.follow_main !== 'boolean') return 'follow_main must be a boolean'
    patch.followMain = body.follow_main
  }
  if (body.own !== undefined) {
    if (!isRecord(body.own)) return 'own must be an object'
    const own = body.own
    if (own.enabled !== undefined) {
      if (typeof own.enabled !== 'boolean') return 'own.enabled must be a boolean'
      patch.own.enabled = own.enabled
    }
    for (const key of NUMERIC_KEYS) {
      const raw = own[WIRE_KEYS[key]]
      if (raw === undefined) continue
      const { min, max } = CLAUDE_COMPRESSION_OWN_LIMITS[key]
      // hermes-v051:C message counts are floored like the main settings (clampInt), not rejected:
      // the copied number box accepts 2.5 and the main page stores it as 2.
      const value = typeof raw === 'number' && isInteger(key) ? Math.floor(raw) : raw
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        return `own.${WIRE_KEYS[key]} must be ${isInteger(key) ? 'an integer' : 'a number'} between ${min} and ${max}`
      }
      patch.own[key] = value
    }
  }
  if (patch.followMain === undefined && Object.keys(patch.own).length === 0) {
    return 'nothing to update: send follow_main and/or own.enabled, own.threshold, own.target_ratio, own.protect_last_n, own.protect_first_n'
  }
  return patch
}

/** GET /api/hermes/cc-api/compression document for the request profile. */
export async function readClaudeCompressionDocument(webUiHome: string, profile: string): Promise<ClaudeCompressionDocument> {
  return toDocument(await resolveClaudeCompressionSettings(webUiHome, profile))
}

// One writer at a time: read-merge-write of concurrent partial PUTs must not drop a field.
let updateQueue: Promise<unknown> = Promise.resolve()

/** PUT /api/hermes/cc-api/compression: partial fields; invalid input leaves the file untouched. */
export async function updateClaudeCompressionDocument(webUiHome: string, profile: string, body: unknown): Promise<ClaudeCompressionUpdateResult> {
  const patch = parsePatch(body)
  if (typeof patch === 'string') return { ok: false, error: patch }
  const run = updateQueue.then(async () => {
    const stored = await readStoredSettings(webUiHome)
    const next: StoredClaudeCompression = {
      followMain: patch.followMain ?? stored.followMain,
      own: { ...stored.own, ...patch.own },
    }
    await writeStoredSettings(webUiHome, next)
    return next
  })
  updateQueue = run.catch(() => undefined)
  const next = await run
  return { ok: true, settings: toDocument(settingsView(next, await readMainValues(profile))) }
}
