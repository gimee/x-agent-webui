// hermes-v050:F-18 HERMES_WEB_UI_EXTERNAL_GATEWAY_PROFILES describes the WebUI process PID1
// started, not its children: a WebUI started from a PTY (or anything else the WebUI spawns) must
// not believe PID1 supervises its default gateway. The WebUI's own restart must keep it.
import { EventEmitter } from 'events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalEnv = { ...process.env }
const NAME = 'HERMES_WEB_UI_EXTERNAL_GATEWAY_PROFILES'

class FakeChild extends EventEmitter {
  pid: number
  constructor(pid: number) {
    super()
    this.pid = pid
  }
  unref() { /* no-op */ }
  kill() { return true }
}

const state = vi.hoisted(() => ({
  execEnvs: [] as Array<{ args: string[]; env: Record<string, string | undefined> }>,
  spawnEnvs: [] as Array<{ args: string[]; env: Record<string, string | undefined> }>,
  onStop: null as null | (() => void),
}))

vi.mock('../../packages/server/src/modules/hermes/services/runtime/process', () => ({
  execHermesWithBin: vi.fn(async (_bin: string, args: string[], options: any = {}) => {
    state.execEnvs.push({ args, env: { ...(options?.env || {}) } })
    if (args[0] === 'profile' && args[1] === 'list') {
      // `work` reports running once its gateway was spawned (waitForGatewayRunning).
      const work = state.spawnEnvs.length > 0 ? 'running' : 'stopped'
      return { stdout: ` Profile          Model                        Gateway      Alias        Distribution\n  work             model-x                      ${work}      —            —\n`, stderr: '' }
    }
    if (args[0] === 'gateway' && args[1] === 'stop') state.onStop?.()
    return { stdout: '', stderr: '' }
  }),
  spawnHermesWithBin: vi.fn((_bin: string, args: string[], options: any = {}) => {
    state.spawnEnvs.push({ args, env: { ...(options?.env || {}) } })
    return new FakeChild(60000 + state.spawnEnvs.length)
  }),
}))

vi.mock('../../packages/server/src/modules/studio/public/app-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../packages/server/src/modules/studio/public/app-config')>()),
  readAppConfig: vi.fn(async () => ({})),
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bridgeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

let home = ''

beforeEach(() => {
  vi.resetModules()
  home = mkdtempSync(join(tmpdir(), 'wui-gateway-env-scope-'))
  process.env.HERMES_HOME = home
  process.env.HERMES_BIN = '/usr/bin/hermes'
  process.env[NAME] = 'default'
  state.execEnvs.length = 0
  state.spawnEnvs.length = 0
  state.onStop = null
})

afterEach(() => {
  vi.useRealTimers()
  process.env = { ...originalEnv }
  rmSync(home, { recursive: true, force: true })
})

// What bootstrap does first (http.ts); a no-op on builds without the adoption.
async function adoptLikeBootstrap() {
  const config: any = await import('../../packages/server/src/modules/studio/public/config')
  config.adoptExternalGatewayProfilesEnv?.()
}

describe('hermes-v050:F-18 PID1 supervision announcement stays with this WebUI process', () => {
  it('is read once and removed from process.env, while this WebUI still leaves default to PID1', async () => {
    await adoptLikeBootstrap()
    const { externallySupervisedGatewayProfiles, ensureProfileGatewaysRunning } = await import('../../packages/server/src/modules/hermes/services/gateway/autostart')

    expect(process.env[NAME]).toBeUndefined()
    expect([...externallySupervisedGatewayProfiles()]).toEqual(['default'])
    // An explicit env keeps meaning exactly that env.
    expect([...externallySupervisedGatewayProfiles({})]).toEqual([])
    await ensureProfileGatewaysRunning()
    expect(state.spawnEnvs).toEqual([])
  })

  it('is not inherited by the gateways and CLI calls the WebUI spawns', async () => {
    await adoptLikeBootstrap()
    mkdirSync(join(home, 'profiles', 'work'), { recursive: true })
    writeFileSync(join(home, 'gateway.pid'), JSON.stringify({ pid: process.ppid }), 'utf-8')
    state.onStop = () => { setTimeout(() => writeFileSync(join(home, 'gateway.pid'), JSON.stringify({ pid: process.pid }), 'utf-8'), 20) }
    const { ensureProfileGatewaysRunning, restartGatewayForProfile } = await import('../../packages/server/src/modules/hermes/services/gateway/autostart')

    await ensureProfileGatewaysRunning()
    await restartGatewayForProfile('default')

    expect(state.spawnEnvs.map(call => call.args.join(' '))).toEqual(['gateway run --replace'])
    expect(state.execEnvs.some(call => call.args.join(' ') === 'gateway stop')).toBe(true)
    for (const call of [...state.spawnEnvs, ...state.execEnvs]) expect(call.env[NAME]).toBeUndefined()
  })

  it('is adopted in bootstrap before anything else runs', () => {
    const http = readFileSync(resolve(__dirname, '../../packages/server/src/bootstrap/http.ts'), 'utf-8')
    const body = http.slice(http.indexOf('export async function bootstrap()'))
    const adopt = body.indexOf('adoptExternalGatewayProfilesEnv()')
    expect(adopt).toBeGreaterThan(0)
    expect(adopt).toBeLessThan(body.indexOf('configurePreferredHermesRuntime()'))
    expect(adopt).toBeLessThan(body.indexOf('ensureStartupDirectory('))
  })
})

describe('hermes-v050:F-18 WebUI self-restart keeps the announcement', () => {
  afterEach(() => {
    vi.doUnmock('child_process')
  })

  it('passes it back to the restarted WebUI although process.env no longer has it', async () => {
    const spawn = vi.fn(() => ({ unref: vi.fn() }))
    vi.doMock('child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('child_process')>()), spawn }))
    process.env.NODE_ENV = 'production'
    process.env.HERMES_DESKTOP = ''
    process.env.HERMES_WEB_UI_CLI_BIN = resolve(__dirname, '../../bin/hermes-web-ui.mjs')
    process.env.SOME_OTHER_SETTING = 'kept'
    await adoptLikeBootstrap()
    const { scheduleWebUiRestart, resetWebUiRestartForTests } = await import('../../packages/server/src/modules/studio/public/web-ui-restart')
    resetWebUiRestartForTests()
    vi.useFakeTimers()

    scheduleWebUiRestart()
    vi.advanceTimersByTime(250)

    expect(spawn).toHaveBeenCalledTimes(1)
    const options = (spawn.mock.calls[0] as any[])[2]
    expect(options.env[NAME]).toBe('default')
    expect(options.env.SOME_OTHER_SETTING).toBe('kept')
    expect(options.env.HERMES_HOME).toBe(home)
    expect(process.env[NAME]).toBeUndefined()
  })
})
