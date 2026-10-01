// hermes-v050:F-02 A WebUI restart of the gateway PID1 supervises must not feed PID1's
// "nothing to start" backoff: the WebUI announces it with a planned-restart marker right before
// `gateway stop`, and PID1 (the real hermes-entrypoint.py policy, run through python3 here)
// respawns it after 1s. Before this, the 5th quick restart waited 48s and answered 500.
import { EventEmitter } from 'events'
import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalEnv = { ...process.env }
const supervisorPath = resolve(__dirname, '../..', '../hermes-entrypoint.py')
const hasPython = spawnSync('python3', ['--version']).status === 0
const MARKER = '.pid1-planned-gateway-restart'

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
  onStop: null as null | ((home: string) => void),
}))

vi.mock('../../packages/server/src/modules/hermes/services/runtime/process', () => ({
  execHermesWithBin: vi.fn(async (_bin: string, args: string[], options: any = {}) => {
    const home = String(options?.env?.HERMES_HOME || '')
    state.execCalls.push({ args, home })
    if (args[0] === 'gateway' && args[1] === 'stop') state.onStop?.(home)
    return { stdout: '', stderr: '' }
  }),
  spawnHermesWithBin: vi.fn((_bin: string, args: string[], options: any = {}) => {
    state.spawnCalls.push({ args, home: String(options?.env?.HERMES_HOME || '') })
    return new FakeChild(50000 + state.spawnCalls.length)
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
  home = mkdtempSync(join(tmpdir(), 'wui-gateway-planned-'))
  process.env.HERMES_HOME = home
  process.env.HERMES_BIN = '/usr/bin/hermes'
  process.env.HERMES_WEB_UI_EXTERNAL_GATEWAY_PROFILES = 'default'
  state.execCalls.length = 0
  state.spawnCalls.length = 0
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

function writeGatewayPid(pid: number) {
  writeFileSync(join(home, 'gateway.pid'), JSON.stringify({ pid }), 'utf-8')
}

// The real PID1 decision for one gateway exit (consumes the marker exactly like PID1 would).
function pid1Plan(rc: number, ranFor: number, previousDelay: number, now: number): [number, number] {
  const script = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("hermes_entrypoint", sys.argv[1])',
    'mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)',
    'rc, ran, delay, now = json.loads(sys.argv[2])',
    'print(json.dumps(mod.gateway_exit_restart_plan(rc, ran, delay, now=now)))',
  ].join('\n')
  const out = execFileSync('python3', ['-c', script, supervisorPath, JSON.stringify([rc, ranFor, previousDelay, now])], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1', HERMES_HOME: home },
  })
  return JSON.parse(out.trim().split('\n').pop()!)
}

async function settleWithFakeTimers<T>(promise: Promise<T>, limitMs: number) {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | null = null
  promise.then(value => { outcome = { ok: true, value } }, error => { outcome = { ok: false, error } })
  const started = Date.now()
  while (!outcome && Date.now() - started < limitMs) await vi.advanceTimersByTimeAsync(250)
  return { outcome: outcome as typeof outcome, elapsedMs: Date.now() - started }
}

describe('hermes-v050:F-02 WebUI restart of the PID1-supervised gateway', () => {
  it('writes a fresh planned-restart marker next to the gateway right before `gateway stop`', async () => {
    writeGatewayPid(process.ppid)
    const seenAtStop: Array<string | null> = []
    state.onStop = () => {
      const marker = join(home, MARKER)
      seenAtStop.push(existsSync(marker) ? readFileSync(marker, 'utf-8') : null)
      rmSync(marker, { force: true }) // PID1 consumes it
      setTimeout(() => writeGatewayPid(process.pid), 20)
    }
    const { restartGatewayForProfile } = await loadAutostart()

    const before = Date.now() / 1000
    await expect(restartGatewayForProfile('default')).resolves.toMatchObject({ running: true, targetProfile: 'default' })

    expect(state.execCalls.map(call => call.args.join(' '))).toEqual(['gateway stop'])
    expect(seenAtStop).toHaveLength(1)
    const writtenAt = Number(seenAtStop[0])
    expect(writtenAt).toBeGreaterThanOrEqual(before - 1)
    expect(writtenAt).toBeLessThanOrEqual(Date.now() / 1000 + 1)
  })

  it('announces the stop of a management transition too (PID1 brings that gateway back)', async () => {
    const markerAtStop: boolean[] = []
    state.onStop = stoppedHome => { if (stoppedHome === home) markerAtStop.push(existsSync(join(home, MARKER))) }
    const { reconcileGatewayManagementTransition } = await loadAutostart()

    await reconcileGatewayManagementTransition(
      { management: 'unified' },
      { management: 'per_profile' },
      { profiles: ['default'], waitForGateway: async () => true, startGateway: async () => undefined },
    )

    expect(markerAtStop).toEqual([true])
  })

  it('does not announce anything for gateways the WebUI owns itself', async () => {
    mkdirSync(join(home, 'profiles', 'work'), { recursive: true })
    const { restartGatewayForProfile } = await loadAutostart()
    vi.useFakeTimers()

    const restart = restartGatewayForProfile('work').catch(() => undefined)
    await vi.advanceTimersByTimeAsync(20_000)
    await restart

    expect(existsSync(join(home, MARKER))).toBe(false)
    expect(existsSync(join(home, 'profiles', 'work', MARKER))).toBe(false)
    expect(state.spawnCalls.map(call => call.home)).toEqual([join(home, 'profiles', 'work')])
  })

  it('removes its marker again when PID1 never brings the gateway back', async () => {
    writeGatewayPid(process.pid)
    const { restartGatewayForProfile } = await loadAutostart()
    vi.useFakeTimers()

    const restart = restartGatewayForProfile('default')
    const outcome = expect(restart).rejects.toThrow(/supervisor/i)
    await vi.advanceTimersByTimeAsync(61_000)
    await outcome
    expect(existsSync(join(home, MARKER))).toBe(false)
  })

  it.skipIf(!existsSync(supervisorPath) || !hasPython)('finishes 5 quick consecutive restarts well inside the 45s wait', async () => {
    vi.useFakeTimers()
    let livePids = [process.ppid, process.pid]
    writeGatewayPid(livePids[0])
    let lastSpawnAt = Date.now() - 3_600_000
    let backoff = 0
    const waits: number[] = []
    state.onStop = () => {
      // PID1: the gateway exits on this stop; decide with the real policy, then respawn.
      const [wait, carried] = pid1Plan(0, (Date.now() - lastSpawnAt) / 1000, backoff, Date.now() / 1000)
      backoff = carried
      waits.push(wait)
      setTimeout(() => {
        lastSpawnAt = Date.now()
        livePids = [livePids[1], livePids[0]]
        writeGatewayPid(livePids[0]) // `gateway run` publishes its pid ~3s after the spawn
      }, wait * 1000 + 3000)
    }
    const { restartGatewayForProfile } = await loadAutostart()

    const results: Array<{ ok: boolean; elapsedMs: number }> = []
    for (let i = 0; i < 5; i += 1) {
      const { outcome, elapsedMs } = await settleWithFakeTimers(restartGatewayForProfile('default'), 70_000)
      results.push({ ok: outcome?.ok === true, elapsedMs })
      // The user saves the channel config again ~5s later.
      await vi.advanceTimersByTimeAsync(5000)
    }

    expect(waits).toEqual([1, 1, 1, 1, 1])
    expect(results.map(result => result.ok)).toEqual([true, true, true, true, true])
    for (const result of results) expect(result.elapsedMs).toBeLessThan(10_000)
    expect(existsSync(join(home, MARKER))).toBe(false)
  }, 30_000)
})
