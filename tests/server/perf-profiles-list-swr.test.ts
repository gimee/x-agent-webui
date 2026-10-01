import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const agentStatusMocks = vi.hoisted(() => ({ hermesAvailable: true }))

vi.mock('../../packages/server/src/modules/hermes/services/runtime/cli', () => ({
  listProfiles: vi.fn(),
  getProfile: vi.fn(),
  createProfile: vi.fn(),
  deleteProfile: vi.fn(),
  renameProfile: vi.fn(),
  useProfile: vi.fn(),
  stopGateway: vi.fn(),
  startGateway: vi.fn(),
  startGatewayBackground: vi.fn(),
  setupReset: vi.fn(),
  exportProfile: vi.fn(),
  importProfile: vi.fn(),
  ARCHIVE_TIMEOUT_CODE: 'archive_timeout',
}))

vi.mock('../../packages/server/src/modules/hermes/services/bridge', () => ({
  AgentBridgeClient: vi.fn(() => ({ destroyAll: vi.fn(), destroyProfile: vi.fn() })),
}))

vi.mock('../../packages/server/src/modules/hermes/services/skills/injector', () => {
  const HermesSkillInjector = vi.fn(() => ({ injectMissingSkills: vi.fn() })) as any
  HermesSkillInjector.resolveTargetDirForProfile = vi.fn()
  return { HermesSkillInjector }
})

vi.mock('../../packages/server/src/modules/hermes/services/history/session-deleter', () => ({
  SessionDeleter: { getInstance: vi.fn(() => ({ switchProfile: vi.fn() })) },
}))

vi.mock('../../packages/server/src/modules/hermes/services/gateway/autostart', () => ({
  getGatewayRuntimeStatusForProfile: vi.fn(),
  prepareGatewayForProfileDelete: vi.fn(),
  restartGatewayForProfile: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/agent-status-registry', () => ({
  isHermesAgentAvailable: vi.fn(() => agentStatusMocks.hermesAvailable),
}))

import * as hermesCli from '../../packages/server/src/modules/hermes/services/runtime/cli'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function makeCtx(profileName = 'default'): any {
  return { state: { profile: { name: profileName } }, get: vi.fn(), status: 200, body: undefined }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('GET /api/hermes/profiles stale-while-revalidate', () => {
  const tempHomes: string[] = []
  const originalHermesHome = process.env.HERMES_HOME
  const originalWebUiHome = process.env.HERMES_WEB_UI_HOME

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()
    agentStatusMocks.hermesAvailable = true
    const hermesHome = await mkdtemp(join(tmpdir(), 'perf-profiles-swr-'))
    const webUiHome = await mkdtemp(join(tmpdir(), 'perf-profiles-swr-webui-'))
    tempHomes.push(hermesHome, webUiHome)
    process.env.HERMES_HOME = hermesHome
    process.env.HERMES_WEB_UI_HOME = webUiHome
    await mkdir(join(hermesHome, 'profiles', 'work'), { recursive: true })
    await writeFile(join(hermesHome, 'profiles', 'work', 'config.yaml'), 'model:\n  default: disk-model\n', 'utf-8')
    await writeFile(join(hermesHome, 'config.yaml'), 'model: root-model\n', 'utf-8')
    await writeFile(join(hermesHome, 'active_profile'), 'default\n', 'utf-8')
  })

  afterEach(async () => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (originalWebUiHome === undefined) delete process.env.HERMES_WEB_UI_HOME
    else process.env.HERMES_WEB_UI_HOME = originalWebUiHome
    await Promise.all(tempHomes.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  it('responds from disk immediately, dedupes the CLI refresh, then merges CLI-only fields once cached', async () => {
    const cli = deferred<any[]>()
    vi.mocked(hermesCli.listProfiles).mockReturnValue(cli.promise)
    const { list } = await import('../../packages/server/src/modules/hermes/controllers/profiles')

    const ctx1 = makeCtx('work')
    const ctx2 = makeCtx('work')
    const startedAt = Date.now()
    await Promise.all([list(ctx1), list(ctx2)])
    const elapsed = Date.now() - startedAt

    // Both responses returned without waiting for the (still pending) CLI.
    expect(elapsed).toBeLessThan(500)
    expect(ctx1.status).toBe(200)
    expect(ctx1.body.profiles.map((p: any) => p.name)).toEqual(['default', 'work'])
    // Disk result carries the model read from config.yaml, not the '—' placeholder.
    expect(ctx1.body.profiles.find((p: any) => p.name === 'work').model).toBe('disk-model')
    expect(ctx1.body.profiles.find((p: any) => p.name === 'default').model).toBe('root-model')
    expect(ctx1.body.profiles.find((p: any) => p.name === 'work').active).toBe(true)
    expect(ctx1.body.profiles.find((p: any) => p.name === 'work').alias).toBe('')
    expect(ctx2.body.profiles.map((p: any) => p.name)).toEqual(['default', 'work'])
    // Two concurrent requests share a single in-flight CLI call.
    expect(hermesCli.listProfiles).toHaveBeenCalledTimes(1)

    cli.resolve([
      { name: 'default', active: true, model: 'cli-default', gatewayStatus: undefined, alias: '' },
      { name: 'work', active: false, model: 'cli-work', gatewayStatus: 'running', alias: 'Work Alias' },
    ])
    await flush()

    const ctx3 = makeCtx('default')
    await list(ctx3)
    const work = ctx3.body.profiles.find((p: any) => p.name === 'work')
    expect(work.gatewayStatus).toBe('running')
    expect(work.alias).toBe('Work Alias')
    expect(work.active).toBe(false)
    expect(ctx3.body.profiles.find((p: any) => p.name === 'default').active).toBe(true)
    // Fresh cache (inside TTL): no new CLI exec.
    expect(hermesCli.listProfiles).toHaveBeenCalledTimes(1)
  })

  it('re-runs the CLI refresh after the TTL expires', async () => {
    vi.mocked(hermesCli.listProfiles).mockResolvedValue([
      { name: 'default', active: true, model: 'cli-default', alias: '' },
    ] as any)
    const mod = await import('../../packages/server/src/modules/hermes/controllers/profiles')
    await mod.list(makeCtx())
    await flush()
    expect(hermesCli.listProfiles).toHaveBeenCalledTimes(1)

    await mod.list(makeCtx())
    await flush()
    expect(hermesCli.listProfiles).toHaveBeenCalledTimes(1)

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 60_000)
      await mod.list(makeCtx())
    } finally {
      vi.useRealTimers()
    }
    await flush()
    expect(hermesCli.listProfiles).toHaveBeenCalledTimes(2)
  })

  it('still resets a forbidden active_profile to default when the CLI refresh fails', async () => {
    const hermesHome = process.env.HERMES_HOME!
    await writeFile(join(hermesHome, 'active_profile'), 'hermes\n', 'utf-8')
    vi.mocked(hermesCli.listProfiles).mockRejectedValue(new Error('profile list failed'))
    const { list } = await import('../../packages/server/src/modules/hermes/controllers/profiles')

    const ctx = makeCtx('default')
    await list(ctx)
    await flush()

    expect(ctx.status).toBe(200)
    expect(ctx.body.profiles.map((p: any) => p.name)).toEqual(['default', 'work'])
    expect(await readFile(join(hermesHome, 'active_profile'), 'utf-8')).toBe('default\n')
  })

  it('never execs the CLI when Hermes is unavailable', async () => {
    agentStatusMocks.hermesAvailable = false
    const { list } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
    const ctx = makeCtx('work')
    await list(ctx)
    await flush()
    expect(ctx.body.profiles.map((p: any) => p.name)).toEqual(['default', 'work'])
    expect(hermesCli.listProfiles).not.toHaveBeenCalled()
  })
})
