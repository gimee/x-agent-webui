// hermes-v050:S1 In Docker the PID1 supervisor (hermes-entrypoint.py) owns the default
// profile's gateway. The WebUI must never start a competing `gateway run --replace` for it,
// while every other profile keeps WebUI autostart exactly as before.
import { EventEmitter } from 'events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalEnv = { ...process.env }

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
  execCalls: [] as Array<{ args: string[]; home: string }>,
  spawnCalls: [] as Array<{ args: string[]; home: string }>,
  running: new Set<string>(),
  onStop: null as null | ((home: string) => void),
}))

vi.mock('../../packages/server/src/modules/hermes/services/runtime/process', () => ({
  execHermesWithBin: vi.fn(async (_bin: string, args: string[], options: any = {}) => {
    const home = String(options?.env?.HERMES_HOME || '')
    state.execCalls.push({ args, home })
    if (args[0] === 'profile' && args[1] === 'list') {
      const rows = ['default', 'work'].map(name =>
        `  ${name.padEnd(16)}model-x                      ${state.running.has(name) ? 'running' : 'stopped'}      —            —`)
      return { stdout: ` Profile          Model                        Gateway      Alias        Distribution\n${rows.join('\n')}\n`, stderr: '' }
    }
    if (args[0] === 'gateway' && args[1] === 'stop') state.onStop?.(home)
    return { stdout: '', stderr: '' }
  }),
  spawnHermesWithBin: vi.fn((_bin: string, args: string[], options: any = {}) => {
    const home = String(options?.env?.HERMES_HOME || '')
    state.spawnCalls.push({ args, home })
    state.running.add(home.includes('/profiles/') ? home.split('/profiles/')[1] : 'default')
    return new FakeChild(40000 + state.spawnCalls.length)
  }),
}))

vi.mock('../../packages/server/src/modules/studio/public/app-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../packages/server/src/modules/studio/public/app-config')>()),
  readAppConfig: vi.fn(async () => ({})),
}))

let home = ''

beforeEach(() => {
  vi.resetModules()
  home = mkdtempSync(join(tmpdir(), 'wui-gateway-supervised-'))
  process.env.HERMES_HOME = home
  process.env.HERMES_BIN = '/usr/bin/hermes'
  delete process.env.HERMES_WEB_UI_EXTERNAL_GATEWAY_PROFILES
  state.execCalls.length = 0
  state.spawnCalls.length = 0
  state.running.clear()
  state.onStop = null
})

afterEach(() => {
  vi.useRealTimers()
  process.env = { ...originalEnv }
  rmSync(home, { recursive: true, force: true })
})

async function loadAutostart() {
  return import('../../packages/server/src/modules/hermes/services/gateway/autostart')
}

describe('gateway ownership shared with an external PID1 supervisor', () => {
  it('parses the supervised profile list announced by the entrypoint', async () => {
    const { externallySupervisedGatewayProfiles } = await loadAutostart()
    expect([...externallySupervisedGatewayProfiles({ HERMES_WEB_UI_EXTERNAL_GATEWAY_PROFILES: 'default' })]).toEqual(['default'])
    expect([...externallySupervisedGatewayProfiles({ HERMES_WEB_UI_EXTERNAL_GATEWAY_PROFILES: ' default , work ,' })]).toEqual(['default', 'work'])
    expect([...externallySupervisedGatewayProfiles({})]).toEqual([])
  })

  it('does not probe or start the supervised default gateway at startup', async () => {
    process.env.HERMES_WEB_UI_EXTERNAL_GATEWAY_PROFILES = 'default'
    const { ensureProfileGatewaysRunning } = await loadAutostart()

    await ensureProfileGatewaysRunning()

    expect(state.spawnCalls).toEqual([])
    // No `hermes profile list` / `gateway status` either: this is the 10-25s pre-listen wait.
    expect(state.execCalls).toEqual([])
  })

  it('keeps autostarting the other profiles that PID1 does not supervise', async () => {
    process.env.HERMES_WEB_UI_EXTERNAL_GATEWAY_PROFILES = 'default'
    mkdirSync(join(home, 'profiles', 'work'), { recursive: true })
    const { ensureProfileGatewaysRunning } = await loadAutostart()

    await ensureProfileGatewaysRunning()

    expect(state.spawnCalls).toEqual([
      { args: ['gateway', 'run', '--replace'], home: join(home, 'profiles', 'work') },
    ])
    expect(state.spawnCalls.some(call => call.home === home)).toBe(false)
  })

  it('still starts the default gateway when nobody else supervises it', async () => {
    const { ensureProfileGatewaysRunning } = await loadAutostart()

    await ensureProfileGatewaysRunning()

    expect(state.spawnCalls).toEqual([{ args: ['gateway', 'run', '--replace'], home }])
  })

  it('restarts a supervised gateway by stopping it and waiting for the supervisor respawn', async () => {
    process.env.HERMES_WEB_UI_EXTERNAL_GATEWAY_PROFILES = 'default'
    // The running supervisor child (a live pid that is not this test process).
    writeFileSync(join(home, 'gateway.pid'), JSON.stringify({ pid: process.ppid }), 'utf-8')
    state.onStop = () => {
      // PID1 notices the exit and starts a fresh child a moment later.
      setTimeout(() => writeFileSync(join(home, 'gateway.pid'), JSON.stringify({ pid: process.pid }), 'utf-8'), 50)
    }
    const { restartGatewayForProfile } = await loadAutostart()

    await expect(restartGatewayForProfile('default')).resolves.toMatchObject({
      running: true,
      profile: 'default',
      targetProfile: 'default',
    })

    expect(state.execCalls.map(call => call.args.join(' '))).toEqual(['gateway stop'])
    expect(state.spawnCalls).toEqual([])
  })

  it('reports a supervised restart that never comes back instead of claiming success', async () => {
    vi.useFakeTimers()
    process.env.HERMES_WEB_UI_EXTERNAL_GATEWAY_PROFILES = 'default'
    writeFileSync(join(home, 'gateway.pid'), JSON.stringify({ pid: process.pid }), 'utf-8')
    const { restartGatewayForProfile } = await loadAutostart()

    const restart = restartGatewayForProfile('default')
    const outcome = expect(restart).rejects.toThrow(/supervisor/i)
    await vi.advanceTimersByTimeAsync(61_000)
    await outcome
    expect(state.spawnCalls).toEqual([])
  })

  it('leaves the supervised gateway to PID1 during a management transition', async () => {
    process.env.HERMES_WEB_UI_EXTERNAL_GATEWAY_PROFILES = 'default'
    const events: string[] = []
    const { reconcileGatewayManagementTransition } = await loadAutostart()

    const result = await reconcileGatewayManagementTransition(
      { management: 'per_profile' },
      { management: 'unified' },
      {
        profiles: ['default', 'work'],
        stopGateway: async profile => { events.push(`stop:${profile}`) },
        startGateway: async profile => { events.push(`start:${profile}`) },
        waitForGateway: async profile => { events.push(`wait:${profile}`); return true },
      },
    )

    expect(events).toEqual(['stop:default', 'stop:work', 'wait:default'])
    expect(result.startedProfiles).toEqual(['default'])
  })
})
