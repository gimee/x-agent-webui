import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { prepareClaudeContextLaunch } from '../../packages/server/src/modules/coding-agents/services/claude-context-launch'
import { resolveClaudeCompressionSettings } from '../../packages/server/src/modules/coding-agents/services/claude-compression-settings'

// hermes-v051:C the frozen resolver is wrapped so single tests can supply effective values.
vi.mock('../../packages/server/src/modules/coding-agents/services/claude-compression-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/server/src/modules/coding-agents/services/claude-compression-settings')>()
  return { ...actual, resolveClaudeCompressionSettings: vi.fn(actual.resolveClaudeCompressionSettings) }
})
const DEFAULT_COMPRESSION_ENV = {
  HERMES_CC_COMPACT_ENABLED: '1', HERMES_CC_COMPACT_THRESHOLD: '0.4', HERMES_CC_COMPACT_TARGET_RATIO: '0.08',
  HERMES_CC_COMPACT_PROTECT_LAST_N: '20', HERMES_CC_COMPACT_PROTECT_FIRST_N: '3',
}

let root: string
let input: Parameters<typeof prepareClaudeContextLaunch>[0]

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'claude-launch-'))
  input = {
    mode: 'global', model: 'claude-opus-5-5', profile: 'default', sessionId: 'studio-one',
    workspaceDir: join(root, 'workspace'), configDir: join(root, 'user', '.claude'),
    webUiHome: join(root, 'web'), realCommand: join(root, 'claude'),
    nodeCommand: process.execPath, wrapperPath: join(root, 'wrapper.mjs'),
    args: ['-p', '--resume', 'native-one'], env: { KEEP: 'original' },
  }
  await fs.mkdir(input.workspaceDir)
  await fs.mkdir(input.configDir, { recursive: true })
  await fs.writeFile(input.realCommand, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await fs.writeFile(input.wrapperPath, '// isolated launch fixture\n')
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  // Never depend on or change the host's home/enterprise policy files.
  const lstat = fs.lstat.bind(fs)
  vi.spyOn(fs, 'lstat').mockImplementation(((path: string, ...args: []) => {
    if (!String(path).startsWith(`${root}/`) && /(?:\.claude\/settings(?:\.local)?\.json|\/etc\/claude-code\/managed-settings\.json)$/.test(String(path))) {
      return Promise.reject(Object.assign(new Error('fixture: absent policy'), { code: 'ENOENT' }))
    }
    return lstat(path, ...args)
  }) as typeof fs.lstat)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

async function expectNative(reason: string) {
  const result = await prepareClaudeContextLaunch(input)
  expect(result).toEqual({ command: input.realCommand, args: input.args, env: input.env, managed: false, unsupportedReason: reason })
  expect(result.args).toBe(input.args)
  expect(result.env).toBe(input.env)
  await expect(fs.stat(input.webUiHome)).rejects.toMatchObject({ code: 'ENOENT' })
}

describe('prepareClaudeContextLaunch', () => {
  it('launches the wrapper with explicit child-only environment without changing user settings', async () => {
    const settings = join(input.configDir, 'settings.json')
    await fs.writeFile(settings, '{"permissions":{"deny":["Read(secret)"]},"env":{"CUSTOM":"kept"}}\n', { mode: 0o644 })
    const before = await fs.readFile(settings)
    const modeBefore = (await fs.stat(settings)).mode
    const processBefore = { ...process.env }
    const argsBefore = [...input.args]
    const envBefore = { ...input.env }
    Object.freeze(input.args)
    Object.freeze(input.env)
    const result = await prepareClaudeContextLaunch(input)
    const stateRoot = join(input.webUiHome, 'coding-agent', 'claude-context')
    expect(result).toEqual({
      command: input.nodeCommand, args: [input.wrapperPath, ...input.args, '--setting-sources', 'user'], managed: true,
      env: { ...input.env, HERMES_CC_REAL_BIN: input.realCommand, HERMES_CC_STATE_DIR: stateRoot,
        CLAUDE_CONFIG_DIR: input.configDir, HERMES_CC_PROFILE_ID: input.profile,
        HERMES_STUDIO_SESSION_ID: input.sessionId, HERMES_WEB_UI_HOME: input.webUiHome,
        HERMES_WEBUI_STATE_DIR: input.webUiHome, ELECTRON_RUN_AS_NODE: '1', ...DEFAULT_COMPRESSION_ENV },
    })
    expect(input.args).toEqual(argsBefore)
    expect(input.env).toEqual(envBefore)
    expect(process.env).toEqual(processBefore)
    expect(createHash('sha256').update(await fs.readFile(settings)).digest('hex')).toBe(createHash('sha256').update(before).digest('hex'))
    expect((await fs.stat(settings)).mode).toBe(modeBefore)
    for (const path of [input.webUiHome, dirname(stateRoot), stateRoot]) expect((await fs.stat(path)).mode & 0o777).toBe(0o700)
  })

  // hermes-v051:A/C internal summary endpoint + token and the effective compression settings reach managed launches only.
  it('adds the summary endpoint, its token and the effective compression settings to managed launches', async () => {
    vi.mocked(resolveClaudeCompressionSettings).mockResolvedValueOnce({
      followMain: true, own: { enabled: true, threshold: 0.4, targetRatio: 0.08, protectLastN: 20, protectFirstN: 3 },
      main: { enabled: false, threshold: 0.8, targetRatio: 0.5, protectLastN: 30, protectFirstN: 1 },
      effective: { enabled: false, threshold: 0.8, targetRatio: 0.5, protectLastN: 30, protectFirstN: 1 },
    })
    input.profile = 'work'
    const summary = { url: 'http://127.0.0.1:8648/api/coding-agents/claude-context/summary', token: 'launch-token' }
    const result = await prepareClaudeContextLaunch({ ...input, summary })
    expect(resolveClaudeCompressionSettings).toHaveBeenCalledWith(input.webUiHome, 'work')
    expect(result.env).toMatchObject({
      HERMES_CC_SUMMARY_URL: summary.url, HERMES_CC_SUMMARY_TOKEN: 'launch-token',
      HERMES_CC_COMPACT_ENABLED: '0', HERMES_CC_COMPACT_THRESHOLD: '0.8', HERMES_CC_COMPACT_TARGET_RATIO: '0.5',
      HERMES_CC_COMPACT_PROTECT_LAST_N: '30', HERMES_CC_COMPACT_PROTECT_FIRST_N: '1',
    })
    expect(input.env).not.toHaveProperty('HERMES_CC_SUMMARY_TOKEN')
  })

  it('keeps the wrapper defaults when settings resolution fails and never adds the endpoint to native launches', async () => {
    vi.mocked(resolveClaudeCompressionSettings).mockRejectedValueOnce(new Error('unreadable settings'))
    const summary = { url: 'http://127.0.0.1:8648/api/coding-agents/claude-context/summary', token: 'launch-token' }
    const managed = await prepareClaudeContextLaunch({ ...input, summary })
    expect(managed.managed).toBe(true)
    expect(Object.keys(managed.env).filter(k => k.startsWith('HERMES_CC_COMPACT_'))).toEqual([])
    expect(managed.env.HERMES_CC_SUMMARY_TOKEN).toBe('launch-token')
    const native = await prepareClaudeContextLaunch({ ...input, summary, model: 'unknown' })
    expect(native.managed).toBe(false)
    expect(native.env).toBe(input.env)
  })

  it.each(['opus', 'claude-opus-5-5-latest', 'claude-opus-5-5 ', 'CLAUDE-OPUS-5-5', '', undefined, '[1m]', 'opus[1m]extra', 'opus[1M]'])('leaves unverified model %s native without creating directories', async (model) => {
    input.model = model
    await expectNative('unsupported-model')
  })

  it.each(['opus[1m]', 'claude-sonnet-4-6[1m]', 'claude-opus-5-5[1m]'])('accepts the explicit 1m annotation %s', async (model) => {
    input.model = model
    expect((await prepareClaudeContextLaunch(input)).managed).toBe(true)
  })

  it.each(['darwin', 'win32', 'freebsd'] as const)('keeps %s native', async (platform) => {
    vi.mocked(Reflect.getOwnPropertyDescriptor(process, 'platform')!.get!).mockReturnValue(platform)
    await expectNative('unsupported-platform')
  })

  it.each(['', undefined])('requires a Studio session identity (%s)', async (sessionId) => {
    input.sessionId = sessionId
    await expectNative('missing-session-id')
  })

  it('does not claim ownership of an existing fork native session', async () => {
    input.parentSessionId = 'studio-parent'
    await expectNative('forked-session')
  })

  it('supports first native sessions and shares ownership root across profiles', async () => {
    input.args = ['-p', '--model', 'claude-opus-5-5']
    const first = await prepareClaudeContextLaunch(input)
    const second = await prepareClaudeContextLaunch({ ...input, sessionId: 'studio-two', profile: 'other' })
    expect(first.managed).toBe(true)
    expect(second.managed).toBe(true)
    expect(first.env.HERMES_CC_STATE_DIR).toBe(second.env.HERMES_CC_STATE_DIR)
    expect(second.env.HERMES_STUDIO_SESSION_ID).toBe('studio-two')
    expect(second.env.HERMES_CC_PROFILE_ID).toBe('other')
    expect(first.env.HERMES_CC_PROFILE_ID).toBe('default')
    expect(first.env.HERMES_CC_PROJECT_DIR).toBeUndefined()
  })

  it.each([
    ['--setting-sources', 'project'], ['--setting-sources=user,project'], ['--setting-sources', 'local'],
    ['--setting-sources', ''], ['--setting-sources'], ['--setting-sources=user', '--setting-sources', 'user'], ['--'],
  ])('preserves unsupported settings source arguments %j', async (...args) => {
    input.args.push(...args)
    await expectNative('unsupported-setting-sources')
  })

  it.each([['--setting-sources', 'user'], ['--setting-sources=user']])('does not duplicate user-only sources %j', async (...args) => {
    input.args.push(...args)
    const result = await prepareClaudeContextLaunch(input)
    expect(result.managed).toBe(true)
    expect(result.args).toEqual([input.wrapperPath, ...input.args])
  })

  it.each(['settings.json', 'settings.local.json'])('does not disable project policy %s, even with user-only source args', async (name) => {
    await fs.mkdir(join(input.workspaceDir, '.claude'))
    const file = join(input.workspaceDir, '.claude', name)
    await fs.writeFile(file, '{"permissions":{"deny":["Bash(*)"]}}', { mode: 0o640 })
    const before = await fs.readFile(file)
    input.args.push('--setting-sources', 'user')
    await expectNative('project-settings')
    expect(await fs.readFile(file)).toEqual(before)
    expect((await fs.stat(file)).mode & 0o777).toBe(0o640)
  })

  it('checks ancestors above the repository root', async () => {
    await fs.mkdir(join(input.workspaceDir, '.git'))
    await fs.mkdir(join(root, '.claude'))
    await fs.writeFile(join(root, '.claude', 'settings.json'), '{}')
    await expectNative('project-settings')
  })

  it('checks real ancestors when the workspace is a symlink', async () => {
    const realParent = join(root, 'real-parent')
    await fs.mkdir(join(realParent, '.claude'), { recursive: true })
    await fs.mkdir(join(realParent, 'workspace'))
    await fs.writeFile(join(realParent, '.claude', 'settings.local.json'), '{}')
    input.workspaceDir = join(root, 'workspace-link')
    await fs.symlink(join(realParent, 'workspace'), input.workspaceDir)
    await expectNative('project-settings')
  })

  it.each(['direct', 'symlink', 'hardlink'])('does not mistake the same user settings file for project policy (%s)', async (kind) => {
    const userSettings = join(input.configDir, 'settings.json')
    await fs.writeFile(userSettings, '{}', { mode: 0o644 })
    if (kind === 'direct') input.workspaceDir = dirname(input.configDir)
    else {
      await fs.mkdir(join(input.workspaceDir, '.claude'))
      const projectSettings = join(input.workspaceDir, '.claude', 'settings.json')
      if (kind === 'symlink') await fs.symlink(userSettings, projectSettings)
      else await fs.link(userSettings, projectSettings)
    }
    expect((await prepareClaudeContextLaunch(input)).managed).toBe(true)
    expect((await fs.stat(userSettings)).mode & 0o777).toBe(0o644)
  })

  it('treats dangling project policy links as policy, not absence', async () => {
    await fs.mkdir(join(input.workspaceDir, '.claude'))
    await fs.symlink(join(root, 'missing'), join(input.workspaceDir, '.claude', 'settings.local.json'))
    await expectNative('project-settings')
  })

  it('preserves enterprise policy without touching /etc', async () => {
    const lstat = vi.mocked(fs.lstat).getMockImplementation()!
    const fixture = await fs.lstat(input.wrapperPath)
    vi.mocked(fs.lstat).mockImplementation(((path: string) => path === '/etc/claude-code/managed-settings.json' ? Promise.resolve(fixture) : lstat(path)) as typeof fs.lstat)
    await expectNative('managed-settings')
  })

  it('does not enable managed launch when policy discovery is unreadable', async () => {
    const lstat = vi.mocked(fs.lstat).getMockImplementation()!
    vi.mocked(fs.lstat).mockImplementation(((path: string) => path === join(input.workspaceDir, '.claude', 'settings.json')
      ? Promise.reject(Object.assign(new Error('fixture: denied'), { code: 'EACCES' })) : lstat(path)) as typeof fs.lstat)
    await expectNative('policy-inspection-failed')
  })

  it.each(['realCommand', 'nodeCommand', 'wrapperPath'] as const)('throws explicitly for a missing supported launch asset: %s', async (key) => {
    input[key] = join(root, `missing-${key}`)
    await expect(prepareClaudeContextLaunch(input)).rejects.toThrow(key)
    await expect(fs.stat(input.webUiHome)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['realCommand', 'nodeCommand', 'wrapperPath'] as const)('rejects a directory as %s', async (key) => {
    input[key] = input.workspaceDir
    await expect(prepareClaudeContextLaunch(input)).rejects.toThrow(key)
  })

  it.each(['realCommand', 'nodeCommand'] as const)('requires executable permission for %s', async (key) => {
    input[key] = join(root, 'not-executable')
    await fs.writeFile(input[key], '#!/bin/sh\n', { mode: 0o644 })
    await expect(prepareClaudeContextLaunch(input)).rejects.toThrow(key)
  })

  it.each(['realCommand', 'nodeCommand', 'wrapperPath', 'workspaceDir', 'configDir', 'webUiHome'] as const)('requires absolute %s without silently resolving relative caller paths', async (key) => {
    input[key] = relative(process.cwd(), join(root, `relative-${key}`))
    await expect(prepareClaudeContextLaunch(input)).rejects.toThrow(key)
  })

  it('keeps unsupported launches native even when managed assets are missing', async () => {
    input.model = 'unknown'
    input.wrapperPath = join(root, 'missing-wrapper')
    await expectNative('unsupported-model')
  })

  it('does not chmod pre-existing shared state parents', async () => {
    await fs.mkdir(join(input.webUiHome, 'coding-agent'), { recursive: true, mode: 0o755 })
    const parents = [input.webUiHome, join(input.webUiHome, 'coding-agent')]
    const before = await Promise.all(parents.map(async (path) => (await fs.stat(path)).mode))
    await prepareClaudeContextLaunch(input)
    expect(await Promise.all(parents.map(async (path) => (await fs.stat(path)).mode))).toEqual(before)
    expect((await fs.stat(join(input.webUiHome, 'coding-agent', 'claude-context'))).mode & 0o777).toBe(0o700)
  })

  it.each(['coding-agent', 'claude-context'])('refuses private state redirection through a %s symlink', async (name) => {
    const outside = join(root, 'outside')
    await fs.mkdir(outside)
    const link = name === 'coding-agent' ? join(input.webUiHome, name) : join(input.webUiHome, 'coding-agent', name)
    await fs.mkdir(dirname(link), { recursive: true })
    await fs.symlink(outside, link)
    await expect(prepareClaudeContextLaunch(input)).rejects.toThrow('state directory')
    expect(await fs.readdir(outside)).toEqual([])
  })

  it('rejects an existing public private-state root rather than changing its mode', async () => {
    const state = join(input.webUiHome, 'coding-agent', 'claude-context')
    await fs.mkdir(state, { recursive: true, mode: 0o755 })
    await fs.chmod(state, 0o755)
    await expect(prepareClaudeContextLaunch(input)).rejects.toThrow('state directory')
    expect((await fs.stat(state)).mode & 0o777).toBe(0o755)
  })

  it.each(['claude-opus-5-6', 'claude-opus-6', 'claude-sonnet-5-5', 'claude-fable-5-1', 'proxy-model[1m]'])('manages future and sibling 1M Claude model %s without a release', async (model) => {
    input.model = model
    expect((await prepareClaudeContextLaunch(input)).managed).toBe(true)
  })

  it.each(['claude-opus-4-8', 'claude-haiku-5-0', 'claude-opus-5-5-preview', ''])('keeps non-1M or unknown model %s native', async (model) => {
    input.model = model
    await expectNative('unsupported-model')
  })

  it('honours operator models.json include/exclude and ignores a malformed file', async () => {
    const state = join(input.webUiHome, 'coding-agent', 'claude-context')
    await fs.mkdir(state, { recursive: true, mode: 0o700 })
    await fs.writeFile(join(state, 'models.json'), JSON.stringify({ include: ['my-proxy'], exclude: ['claude-opus-5-5'] }))
    expect((await prepareClaudeContextLaunch(input)).unsupportedReason).toBe('unsupported-model')
    input.model = 'my-proxy'
    expect((await prepareClaudeContextLaunch(input)).managed).toBe(true)
    await fs.writeFile(join(state, 'models.json'), '{broken')
    input.model = 'claude-opus-5-5'
    expect((await prepareClaudeContextLaunch(input)).managed).toBe(true)
  })

  it('DISABLED file returns every launch to native immediately', async () => {
    const state = join(input.webUiHome, 'coding-agent', 'claude-context')
    await fs.mkdir(state, { recursive: true, mode: 0o700 })
    await fs.writeFile(join(state, 'DISABLED'), '')
    const result = await prepareClaudeContextLaunch(input)
    expect(result).toEqual({ command: input.realCommand, args: input.args, env: input.env, managed: false, unsupportedReason: 'disabled' })
  })

  it('preserves the native launch for scoped mode without writing state', async () => {
    input.mode = 'scoped'
    await expectNative('unsupported-mode')
  })
})
