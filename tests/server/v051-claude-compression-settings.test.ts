// hermes-v051:C Claude 压缩设置 — storage, resolution and PUT validation of
// <WebUI home>/coding-agent/claude-context/compression.json (Agent 管理 → Claude → 压缩设置).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const readConfigYamlForProfile = vi.hoisted(() => vi.fn())
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({ readConfigYamlForProfile }))

import {
  CLAUDE_COMPRESSION_DEFAULTS,
  claudeCompressionSettingsPath,
  readClaudeCompressionDocument,
  resolveClaudeCompressionSettings,
  updateClaudeCompressionDocument,
} from '../../packages/server/src/modules/coding-agents/services/claude-compression-settings'
import { normalizeCompressionSection } from '../../packages/server/src/modules/studio/public/compression-config'

const HERMES_MAIN_DEFAULTS = { enabled: true, threshold: 0.5, targetRatio: 0.2, protectLastN: 20, protectFirstN: 3 }
let home = ''
const file = () => join(home, 'coding-agent', 'claude-context', 'compression.json')
const readFile = async () => JSON.parse(await fs.readFile(file(), 'utf8'))
const writeRaw = async (text: string) => {
  await fs.mkdir(join(home, 'coding-agent', 'claude-context'), { recursive: true, mode: 0o700 })
  await fs.writeFile(file(), text)
}

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'v051-cc-compression-'))
  readConfigYamlForProfile.mockReset()
  readConfigYamlForProfile.mockResolvedValue({})
})

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true })
})

describe('hermes-v051:C resolveClaudeCompressionSettings', () => {
  it('stores the file at <webUiHome>/coding-agent/claude-context/compression.json', () => {
    expect(claudeCompressionSettingsPath(home)).toBe(file())
  })

  it('missing file → follow off, Claude defaults, Hermes main defaults', async () => {
    const view = await resolveClaudeCompressionSettings(home, 'default')
    expect(view).toEqual({
      followMain: false,
      own: { ...CLAUDE_COMPRESSION_DEFAULTS },
      main: HERMES_MAIN_DEFAULTS,
      effective: { ...CLAUDE_COMPRESSION_DEFAULTS },
    })
    await expect(fs.stat(file())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('corrupt or wrongly typed files fall back to defaults and never throw', async () => {
    for (const text of ['{not json', '', 'null', '[]', '"x"', '{"follow_main":"yes","own":"all"}']) {
      await writeRaw(text)
      const view = await resolveClaudeCompressionSettings(home, 'default')
      expect(view.followMain, text).toBe(false)
      expect(view.own, text).toEqual({ ...CLAUDE_COMPRESSION_DEFAULTS })
      expect(view.effective, text).toEqual({ ...CLAUDE_COMPRESSION_DEFAULTS })
    }
    // Field by field: a bad field falls back alone, out-of-range values clamp to the dialog limits.
    await writeRaw(JSON.stringify({ follow_main: false, own: { enabled: 'no', threshold: 0.99, target_ratio: 0.3, protect_last_n: 12.9, protect_first_n: null } }))
    expect((await resolveClaudeCompressionSettings(home, 'default')).own)
      .toEqual({ enabled: true, threshold: 0.95, targetRatio: 0.3, protectLastN: 12, protectFirstN: 3 })
  })

  it('an unreadable profile config gives main defaults instead of throwing', async () => {
    readConfigYamlForProfile.mockRejectedValue(new Error('boom'))
    const view = await resolveClaudeCompressionSettings(home, 'work')
    expect(view.main).toEqual(HERMES_MAIN_DEFAULTS)
    expect(readConfigYamlForProfile).toHaveBeenCalledWith('work')
  })

  it('follow_main=true → effective is the profile main settings, re-read on every call', async () => {
    await writeRaw(JSON.stringify({ follow_main: true, own: { enabled: true, threshold: 0.3, target_ratio: 0.1, protect_last_n: 8, protect_first_n: 1 } }))
    readConfigYamlForProfile.mockResolvedValue({ compression: { enabled: false, threshold: 0.8, target_ratio: 0.5, protect_last_n: 30, protect_first_n: 4 } })
    const first = await resolveClaudeCompressionSettings(home, 'default')
    expect(first.followMain).toBe(true)
    expect(first.own).toEqual({ enabled: true, threshold: 0.3, targetRatio: 0.1, protectLastN: 8, protectFirstN: 1 })
    expect(first.effective).toEqual({ enabled: false, threshold: 0.8, targetRatio: 0.5, protectLastN: 30, protectFirstN: 4 })
    // Main settings change → the next resolution (next Claude message) uses the new value.
    readConfigYamlForProfile.mockResolvedValue({ compression: { threshold: 0.6 } })
    expect((await resolveClaudeCompressionSettings(home, 'default')).effective)
      .toEqual({ ...HERMES_MAIN_DEFAULTS, threshold: 0.6 })
  })

  it('main values use exactly the Hermes getRunChatCompressionConfig ranges and defaults', async () => {
    const cases: Array<[unknown, typeof HERMES_MAIN_DEFAULTS]> = [
      [undefined, HERMES_MAIN_DEFAULTS],
      ['oops', HERMES_MAIN_DEFAULTS],
      [{ threshold: 0.01, target_ratio: 0.001, protect_last_n: -4, protect_first_n: -1 }, { enabled: true, threshold: 0.05, targetRatio: 0.01, protectLastN: 0, protectFirstN: 0 }],
      [{ threshold: 1.5, target_ratio: 0.95, protect_last_n: 9999.9, protect_first_n: 101.2 }, { enabled: true, threshold: 0.95, targetRatio: 0.8, protectLastN: 500, protectFirstN: 100 }],
      [{ threshold: '0.7', target_ratio: null, protect_last_n: '5', protect_first_n: Number.NaN, enabled: 0 }, HERMES_MAIN_DEFAULTS],
      [{ enabled: false, protect_last_n: 7.8 }, { ...HERMES_MAIN_DEFAULTS, enabled: false, protectLastN: 7 }],
    ]
    for (const [section, expected] of cases) {
      expect(normalizeCompressionSection(section), JSON.stringify(section)).toEqual(expected)
      readConfigYamlForProfile.mockResolvedValue({ compression: section })
      expect((await resolveClaudeCompressionSettings(home, 'default')).main, JSON.stringify(section)).toEqual(expected)
    }
  })
})

describe('hermes-v051:C compression.json writes', () => {
  it('writes the documented shape with 0600 file / 0700 directory permissions', async () => {
    const result = await updateClaudeCompressionDocument(home, 'default', { follow_main: true })
    expect(result.ok).toBe(true)
    expect(await readFile()).toEqual({
      follow_main: true,
      own: { enabled: true, threshold: 0.4, target_ratio: 0.08, protect_last_n: 20, protect_first_n: 3 },
    })
    expect((await fs.stat(file())).mode & 0o777).toBe(0o600)
    expect((await fs.stat(join(home, 'coding-agent', 'claude-context'))).mode & 0o777).toBe(0o700)
  })

  it('is atomic: temp file + rename, no leftovers, never writes through a symlink', async () => {
    const outside = join(home, 'outside.json')
    await fs.writeFile(outside, 'keep')
    await fs.mkdir(join(home, 'coding-agent', 'claude-context'), { recursive: true, mode: 0o700 })
    await fs.symlink(outside, file())
    await updateClaudeCompressionDocument(home, 'default', { own: { threshold: 0.6 } })
    expect(await fs.readFile(outside, 'utf8')).toBe('keep')
    expect((await fs.lstat(file())).isFile()).toBe(true)
    const before = (await fs.stat(file())).ino
    await updateClaudeCompressionDocument(home, 'default', { own: { threshold: 0.65 } })
    expect((await fs.stat(file())).ino).not.toBe(before)
    expect(await fs.readdir(join(home, 'coding-agent', 'claude-context'))).toEqual(['compression.json'])
  })

  it('PUT accepts partial fields and keeps the others', async () => {
    await updateClaudeCompressionDocument(home, 'default', { own: { threshold: 0.3, protect_last_n: 40 } })
    const result = await updateClaudeCompressionDocument(home, 'default', { own: { enabled: false } })
    expect(result).toEqual({
      ok: true,
      settings: {
        follow_main: false,
        own: { enabled: false, threshold: 0.3, target_ratio: 0.08, protect_last_n: 40, protect_first_n: 3 },
        main: { enabled: true, threshold: 0.5, target_ratio: 0.2, protect_last_n: 20, protect_first_n: 3 },
        effective: { enabled: false, threshold: 0.3, target_ratio: 0.08, protect_last_n: 40, protect_first_n: 3 },
      },
    })
  })

  it('serializes concurrent updates so no field is lost', async () => {
    await Promise.all([
      updateClaudeCompressionDocument(home, 'default', { own: { threshold: 0.7 } }),
      updateClaudeCompressionDocument(home, 'default', { own: { target_ratio: 0.3 } }),
      updateClaudeCompressionDocument(home, 'default', { follow_main: true }),
      updateClaudeCompressionDocument(home, 'default', { own: { protect_first_n: 9 } }),
    ])
    expect(await readFile()).toEqual({
      follow_main: true,
      own: { enabled: true, threshold: 0.7, target_ratio: 0.3, protect_last_n: 20, protect_first_n: 9 },
    })
  })

  it('PUT rejects values outside the dialog number-box limits without touching the file', async () => {
    await updateClaudeCompressionDocument(home, 'default', { own: { threshold: 0.3 } })
    const snapshot = await fs.readFile(file(), 'utf8')
    const bad: unknown[] = [
      undefined, null, [], 'x', {}, { profile: 'default' },
      { follow_main: 'true' }, { own: 'x' }, { own: {} }, { own: { enabled: 1 } },
      { own: { threshold: 0.09 } }, { own: { threshold: 0.96 } }, { own: { threshold: '0.5' } },
      { own: { target_ratio: 0.04 } }, { own: { target_ratio: 0.81 } },
      { own: { protect_last_n: -1 } }, { own: { protect_last_n: 201 } }, { own: { protect_first_n: -0.5 } },
      { own: { protect_first_n: 51 } }, { own: { protect_first_n: Number.NaN } },
      { follow_main: true, own: { threshold: 2 } },
    ]
    for (const body of bad) {
      const result = await updateClaudeCompressionDocument(home, 'default', body)
      expect(result.ok, JSON.stringify(body)).toBe(false)
      expect(typeof (result as { error?: unknown }).error).toBe('string')
    }
    expect(await fs.readFile(file(), 'utf8')).toBe(snapshot)
    // Inclusive bounds are accepted.
    for (const own of [{ threshold: 0.1 }, { threshold: 0.95 }, { target_ratio: 0.05 }, { target_ratio: 0.8 }, { protect_last_n: 0 }, { protect_last_n: 200 }, { protect_first_n: 0 }, { protect_first_n: 50 }]) {
      expect((await updateClaudeCompressionDocument(home, 'default', { own })).ok, JSON.stringify(own)).toBe(true)
    }
    // hermes-v051:C message counts are floored like the main settings (clampInt), not rejected.
    const floored = await updateClaudeCompressionDocument(home, 'default', { own: { protect_last_n: 2.5, protect_first_n: 50.9 } })
    expect(floored.ok).toBe(true)
    expect(JSON.parse(await fs.readFile(file(), 'utf8')).own).toMatchObject({ protect_last_n: 2, protect_first_n: 50 })
  })

  it('GET document reports follow_main, own, main and effective in snake_case', async () => {
    readConfigYamlForProfile.mockResolvedValue({ compression: { threshold: 0.8, target_ratio: 0.5 } })
    await updateClaudeCompressionDocument(home, 'default', { follow_main: true })
    expect(await readClaudeCompressionDocument(home, 'default')).toEqual({
      follow_main: true,
      own: { enabled: true, threshold: 0.4, target_ratio: 0.08, protect_last_n: 20, protect_first_n: 3 },
      main: { enabled: true, threshold: 0.8, target_ratio: 0.5, protect_last_n: 20, protect_first_n: 3 },
      effective: { enabled: true, threshold: 0.8, target_ratio: 0.5, protect_last_n: 20, protect_first_n: 3 },
    })
  })
})

describe('hermes-v051:C compression.json write-side directory checks (R2-08)', () => {
  it('refuses to write through a symlinked or group-accessible claude-context directory', async () => {
    const { mkdtemp, mkdir, symlink, chmod, rm, readdir } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { updateClaudeCompressionDocument } = await import('../../packages/server/src/modules/coding-agents/services/claude-compression-settings')
    const root = await mkdtemp(join(tmpdir(), 'v051-r208-'))
    try {
      const outside = join(root, 'outside'); await mkdir(outside, { mode: 0o700 })
      const linked = join(root, 'linked'); await mkdir(join(linked, 'coding-agent'), { recursive: true, mode: 0o700 })
      await symlink(outside, join(linked, 'coding-agent', 'claude-context'))
      await expect(updateClaudeCompressionDocument(linked, 'default', { follow_main: true })).rejects.toThrow(/unsafe state directory/)
      expect(await readdir(outside)).toEqual([])
      const loose = join(root, 'loose'); await mkdir(join(loose, 'coding-agent', 'claude-context'), { recursive: true, mode: 0o700 })
      await chmod(join(loose, 'coding-agent', 'claude-context'), 0o755)
      await expect(updateClaudeCompressionDocument(loose, 'default', { follow_main: true })).rejects.toThrow(/unsafe state directory/)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
