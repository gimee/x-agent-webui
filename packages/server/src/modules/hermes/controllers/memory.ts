import { mkdir, rename, writeFile, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { safeReadFile, safeStat } from '../../studio/public/files'
import { getActiveProfileName, getProfileDir } from '../services/profiles/profile'

function requestedProfile(ctx: any): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

function requestProfileDir(ctx: any): string {
  return getProfileDir(requestedProfile(ctx))
}

export async function get(ctx: any) {
  const hd = requestProfileDir(ctx)
  const memoryPath = join(hd, 'memories', 'MEMORY.md')
  const userPath = join(hd, 'memories', 'USER.md')
  const soulPath = join(hd, 'SOUL.md')
  const [memory, user, soul, memoryStat, userStat, soulStat] = await Promise.all([
    safeReadFile(memoryPath), safeReadFile(userPath), safeReadFile(soulPath),
    safeStat(memoryPath), safeStat(userPath), safeStat(soulPath),
  ])
  ctx.body = {
    memory: memory || '', user: user || '', soul: soul || '',
    memory_mtime: memoryStat?.mtime || null, user_mtime: userStat?.mtime || null, soul_mtime: soulStat?.mtime || null,
  }
}

export async function save(ctx: any) {
  const { section, content } = ctx.request.body as { section: string; content: string }
  if (!section || content === undefined || content === null) {
    ctx.status = 400
    ctx.body = { error: 'Missing section or content' }
    return
  }
  if (section !== 'memory' && section !== 'user' && section !== 'soul') {
    ctx.status = 400
    ctx.body = { error: 'Section must be "memory", "user", or "soul"' }
    return
  }
  let filePath: string
  const hd = requestProfileDir(ctx)
  if (section === 'soul') {
    filePath = join(hd, 'SOUL.md')
  } else {
    const fileName = section === 'memory' ? 'MEMORY.md' : 'USER.md'
    await mkdir(join(hd, 'memories'), { recursive: true })
    filePath = join(hd, 'memories', fileName)
  }
  try {
    await writeFile(filePath, content, 'utf-8')
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

// hermes-v0.2.9: replace the user-owned Claude global memory file with the
// current Hermes MEMORY.md, optionally ending with an explicit SOUL.md pointer.
export function claudeMemoryPath(): string {
  const configDir = (process.env.CLAUDE_CONFIG_DIR || '').trim() || join(homedir(), '.claude')
  return join(configDir, 'CLAUDE.md')
}

export function buildClaudeMemoryContent(memory: string, soulPath?: string): string {
  const base = String(memory || '').replace(/(?:\r?\n)+$/, '')
  if (!soulPath) return memory || ''
  const pointer = `Hermes SOUL.md: ${soulPath}`
  return `${base}${base ? '\n' : ''}${pointer}\n`
}

export async function syncMemoryToClaude(memory: string, soulPath?: string): Promise<{ path: string; content: string }> {
  const path = claudeMemoryPath()
  const content = buildClaudeMemoryContent(memory, soulPath)
  const directory = join(path, '..')
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`
  await mkdir(directory, { recursive: true })
  try {
    await writeFile(tempPath, content, { encoding: 'utf-8', mode: 0o600 })
    await rename(tempPath, path)
  } catch (err) {
    await unlink(tempPath).catch(() => undefined)
    throw err
  }
  return { path, content }
}

export async function syncClaude(ctx: any) {
  const { includeSoul } = (ctx.request.body || {}) as { includeSoul?: unknown }
  if (includeSoul !== undefined && typeof includeSoul !== 'boolean') {
    ctx.status = 400
    ctx.body = { error: 'includeSoul must be a boolean' }
    return
  }
  const hd = requestProfileDir(ctx)
  const memoryPath = join(hd, 'memories', 'MEMORY.md')
  const soulPath = join(hd, 'SOUL.md')
  try {
    const memory = await safeReadFile(memoryPath)
    const result = await syncMemoryToClaude(memory || '', includeSoul ? soulPath : undefined)
    ctx.body = { success: true, path: result.path, bytes: Buffer.byteLength(result.content) }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

// ---------------------------------------------------------------------------
// hermes-v0.1.2: agent write lock for global memory.
// The Hermes runtime patch (patch-memory-policy.sh v3) rejects every agent
// memory_tool write while `${HERMES_HOME}/.agent-memory-readonly` exists. The
// user toggles the file from the Memory page; the WebUI editor is never
// affected by the lock.
// ---------------------------------------------------------------------------
export const MEMORY_LOCK_FILE = '.agent-memory-readonly'

export function memoryLockPath(): string {
  const hermesHome = (process.env.HERMES_HOME || '').trim() || join(homedir(), '.hermes')
  return join(hermesHome, MEMORY_LOCK_FILE)
}

export function isMemoryLocked(): boolean {
  return existsSync(memoryLockPath())
}

export async function getLock(ctx: any) {
  ctx.body = { locked: isMemoryLocked(), path: memoryLockPath() }
}

export async function setLock(ctx: any) {
  const { locked } = (ctx.request.body || {}) as { locked?: unknown }
  if (typeof locked !== 'boolean') {
    ctx.status = 400
    ctx.body = { error: 'locked must be a boolean' }
    return
  }
  const path = memoryLockPath()
  try {
    if (locked) {
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, `locked by user via X-Agent at ${new Date().toISOString()}\n`, 'utf-8')
    } else if (existsSync(path)) {
      await unlink(path)
    }
    ctx.body = { success: true, locked: isMemoryLocked(), path }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}
