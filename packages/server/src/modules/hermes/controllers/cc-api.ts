import { copyFile, mkdir, readFile, rename, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { readClaudeCompressionSettings, updateClaudeCompressionSettings } from '../../studio/public/claude-compression'
import { getActiveProfileName } from '../services/profiles/profile'

// Claude Code API endpoint manager ("cc api").  Profiles live next to Claude
// Code's own settings so they ride the same persisted volume; applying one
// rewrites env.ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN in settings.json and
// leaves every other key untouched.

export interface CcApiProfile {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  createdAt: number
}

function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

function profilesPath(): string {
  return join(claudeDir(), 'cc-api-profiles.json')
}

function settingsPath(): string {
  return join(claudeDir(), 'settings.json')
}

async function readJson(path: string): Promise<any | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8'))
  } catch {
    return null
  }
}

async function writeJsonAtomic(path: string, value: any): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
  await rename(tmp, path)
}

async function readProfiles(): Promise<CcApiProfile[]> {
  const data = await readJson(profilesPath())
  const list = Array.isArray(data?.profiles) ? data.profiles : []
  // Guard: require all four string fields so findActiveId never calls .trim()
  // on undefined when a profile was hand-edited and is missing a key.
  return list.filter(
    (p: any) =>
      p &&
      typeof p.id === 'string' &&
      typeof p.name === 'string' &&
      typeof p.baseUrl === 'string' &&
      typeof p.apiKey === 'string',
  )
}

async function writeProfiles(profiles: CcApiProfile[]): Promise<void> {
  await mkdir(claudeDir(), { recursive: true })
  await writeJsonAtomic(profilesPath(), { profiles })
}

async function settingsEnv(): Promise<Record<string, any>> {
  const settings = await readJson(settingsPath())
  return settings && typeof settings.env === 'object' && settings.env ? settings.env : {}
}

function normalizeUrl(url: string): string {
  return String(url || '').trim().replace(/\/+$/, '')
}

function findActiveId(profiles: CcApiProfile[], env: Record<string, any>): string | null {
  const url = normalizeUrl(env.ANTHROPIC_BASE_URL)
  const token = String(env.ANTHROPIC_AUTH_TOKEN || '').trim()
  if (!url && !token) return null
  const hit = profiles.find(
    p => normalizeUrl(p.baseUrl) === url && String(p.apiKey || '').trim() === token,
  )
  return hit ? hit.id : null
}

async function respondList(ctx: any, profiles: CcApiProfile[]): Promise<void> {
  const env = await settingsEnv()
  ctx.body = { profiles, active_id: findActiveId(profiles, env) }
}

function validateInput(ctx: any): { name: string; baseUrl: string; apiKey: string } | null {
  const { name, base_url, api_key } = (ctx.request.body || {}) as Record<string, string>
  const cleanName = String(name || '').trim()
  const cleanUrl = String(base_url || '').trim()
  const cleanKey = String(api_key || '').trim()
  if (!cleanName || !cleanUrl || !cleanKey) {
    ctx.status = 400
    ctx.body = { error: 'name, base_url and api_key are all required' }
    return null
  }
  if (!/^https?:\/\//i.test(cleanUrl)) {
    ctx.status = 400
    ctx.body = { error: 'base_url must start with http:// or https://' }
    return null
  }
  return { name: cleanName, baseUrl: cleanUrl, apiKey: cleanKey }
}

export async function list(ctx: any) {
  let profiles = await readProfiles()
  // First run: seed a profile from whatever settings.json currently uses, so
  // the "active" marker has something to point at.
  if (profiles.length === 0 && (await readJson(profilesPath())) === null) {
    const env = await settingsEnv()
    const url = String(env.ANTHROPIC_BASE_URL || '').trim()
    const token = String(env.ANTHROPIC_AUTH_TOKEN || '').trim()
    if (url && token) {
      profiles = [{ id: randomUUID(), name: 'current', baseUrl: url, apiKey: token, createdAt: Date.now() }]
      await writeProfiles(profiles)
    }
  }
  await respondList(ctx, profiles)
}

export async function create(ctx: any) {
  const input = validateInput(ctx)
  if (!input) return
  const profiles = await readProfiles()
  profiles.push({ id: randomUUID(), ...input, createdAt: Date.now() })
  await writeProfiles(profiles)
  await respondList(ctx, profiles)
}

export async function update(ctx: any) {
  const input = validateInput(ctx)
  if (!input) return
  const profiles = await readProfiles()
  const target = profiles.find(p => p.id === ctx.params.id)
  if (!target) {
    ctx.status = 404
    ctx.body = { error: 'profile not found' }
    return
  }
  if (findActiveId(profiles, await settingsEnv()) === target.id) {
    ctx.status = 409
    ctx.body = { error: 'the active profile cannot be edited; apply another one first' }
    return
  }
  Object.assign(target, input)
  await writeProfiles(profiles)
  await respondList(ctx, profiles)
}

export async function remove(ctx: any) {
  const profiles = await readProfiles()
  const target = profiles.find(p => p.id === ctx.params.id)
  if (!target) {
    ctx.status = 404
    ctx.body = { error: 'profile not found' }
    return
  }
  if (findActiveId(profiles, await settingsEnv()) === target.id) {
    ctx.status = 409
    ctx.body = { error: 'the active profile cannot be deleted; apply another one first' }
    return
  }
  const next = profiles.filter(p => p.id !== target.id)
  await writeProfiles(next)
  await respondList(ctx, next)
}

export async function apply(ctx: any) {
  const profiles = await readProfiles()
  const target = profiles.find(p => p.id === ctx.params.id)
  if (!target) {
    ctx.status = 404
    ctx.body = { error: 'profile not found' }
    return
  }
  const path = settingsPath()
  const settings = (await readJson(path)) || {}
  // Rolling single-slot backup before every mutation.
  try {
    await copyFile(path, `${path}.ccbak`)
  } catch {
    /* first run may have no settings.json yet */
  }
  if (!settings.env || typeof settings.env !== 'object') settings.env = {}
  settings.env.ANTHROPIC_BASE_URL = target.baseUrl
  settings.env.ANTHROPIC_AUTH_TOKEN = target.apiKey
  await writeJsonAtomic(path, settings)
  await respondList(ctx, profiles)
}

// Reasoning effort ("推理强度"). Claude Code ignores a user-level top-level
// effortLevel for current models (Opus 5.5/5.6 run at their own default), while
// env.CLAUDE_CODE_EFFORT_LEVEL applies to every model including 'max'. Write the
// env var as the source of truth and mirror effortLevel; 'auto' removes both.
export const CC_EFFORT_LEVELS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const
type CcEffortLevel = typeof CC_EFFORT_LEVELS[number]

function isEffortLevel(value: unknown): value is CcEffortLevel {
  return typeof value === 'string' && (CC_EFFORT_LEVELS as readonly string[]).includes(value)
}

function effortFromSettings(settings: any): CcEffortLevel {
  const value = String(settings?.env?.CLAUDE_CODE_EFFORT_LEVEL || '').trim().toLowerCase()
  return isEffortLevel(value) ? value : 'auto'
}

export async function getEffort(ctx: any) {
  ctx.body = { level: effortFromSettings(await readJson(settingsPath())), levels: CC_EFFORT_LEVELS }
}

export async function setEffort(ctx: any) {
  const level = String((ctx.request.body || {}).level || '').trim().toLowerCase()
  if (!isEffortLevel(level)) {
    ctx.status = 400
    ctx.body = { error: `level must be one of ${CC_EFFORT_LEVELS.join(', ')}` }
    return
  }
  const path = settingsPath()
  const settings = (await readJson(path)) || {}
  try {
    await copyFile(path, `${path}.ccbak`)
  } catch {
    /* first run may have no settings.json yet */
  }
  if (level === 'auto') {
    if (settings.env && typeof settings.env === 'object') delete settings.env.CLAUDE_CODE_EFFORT_LEVEL
    delete settings.effortLevel
  } else {
    if (!settings.env || typeof settings.env !== 'object') settings.env = {}
    settings.env.CLAUDE_CODE_EFFORT_LEVEL = level
    settings.effortLevel = level
  }
  await mkdir(claudeDir(), { recursive: true })
  await writeJsonAtomic(path, settings)
  ctx.body = { level: effortFromSettings(settings), levels: CC_EFFORT_LEVELS }
}

// hermes-v051:C Claude compression settings ("压缩设置"). compression.json is owned by the Coding Agents
// module (reached through the Studio port wired in bootstrap); main values come from the request profile's
// config.yaml `compression` section, resolved exactly like Hermes chat compression.
function requestedProfile(ctx: any): string {
  const headerProfile = typeof ctx.get === 'function' ? ctx.get('x-hermes-profile') : ''
  const queryProfile = typeof ctx.query?.profile === 'string' ? ctx.query.profile : ''
  const bodyProfile = typeof ctx.request?.body?.profile === 'string' ? ctx.request.body.profile : ''
  return ctx.state?.profile?.name ||
    headerProfile.trim() ||
    queryProfile.trim() ||
    bodyProfile.trim() ||
    getActiveProfileName() ||
    'default'
}

export async function getCompression(ctx: any) {
  ctx.body = await readClaudeCompressionSettings(requestedProfile(ctx))
}

export async function setCompression(ctx: any) {
  const result = await updateClaudeCompressionSettings(requestedProfile(ctx), ctx.request.body)
  if (!result.ok) {
    ctx.status = 400
    ctx.body = { error: result.error }
    return
  }
  ctx.body = result.settings
}
