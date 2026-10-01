import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// hermes-v050:F-02 PID1 tells a WebUI-requested restart ("planned-restart" marker written just
// before `gateway stop`) apart from a gateway that exits by itself ("nothing to start"). Driven
// through the real Python module, like entrypoint-gateway-backoff.test.ts.
const supervisorPath = resolve(__dirname, '../..', '../hermes-entrypoint.py')
const hasPython = spawnSync('python3', ['--version']).status === 0
const NOW = 1_900_000_000

let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wui-pid1-planned-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

type Step = [rc: number, ranFor: number, marker: number | 'garbage' | null]

// Each step optionally writes the marker (its age in seconds, or unparsable text), then asks
// PID1 what to do about a gateway exit. Returns [wait, carried backoff, marker still on disk].
function plan(steps: Step[]): Array<[number, number, boolean]> {
  const script = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("hermes_entrypoint", sys.argv[1])',
    'mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)',
    'marker = mod.GATEWAY_PLANNED_RESTART_MARKER',
    'now = float(sys.argv[3])',
    'delay, out = 0.0, []',
    'for rc, ran, age in json.loads(sys.argv[2]):',
    '    if age is not None:',
    '        marker.write_text("garbage" if age == "garbage" else repr(now - age), encoding="utf-8")',
    '    wait, delay = mod.gateway_exit_restart_plan(rc, ran, delay, now=now)',
    '    out.append([wait, delay, marker.exists()])',
    'print(json.dumps(out))',
  ].join('\n')
  return JSON.parse(execFileSync('python3', ['-c', script, supervisorPath, JSON.stringify(steps), String(NOW)], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1', HERMES_HOME: home },
  }).trim().split('\n').pop()!)
}

describe.skipIf(!existsSync(supervisorPath) || !hasPython)('hermes-v050:F-02 PID1 planned gateway restart', () => {
  it('keeps the marker next to the gateway it owns ($HERMES_HOME), under the name the WebUI writes', () => {
    const script = [
      'import importlib.util, sys',
      'spec = importlib.util.spec_from_file_location("hermes_entrypoint", sys.argv[1])',
      'mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)',
      'print(mod.GATEWAY_PLANNED_RESTART_MARKER)',
    ].join('\n')
    const markerPath = execFileSync('python3', ['-c', script, supervisorPath], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1', HERMES_HOME: home },
    }).trim().split('\n').pop()
    expect(markerPath).toBe(join(home, '.pid1-planned-gateway-restart'))
  })

  it('restarts a planned stop after 1s and clears the backoff, consuming the marker', () => {
    expect(plan([
      [0, 3.5, null],
      [0, 3.5, null],
      [0, 3.5, null],
      [0, 8, 2],
      [0, 3.5, null],
    ])).toEqual([
      [3, 3, false],
      [6, 6, false],
      [12, 12, false],
      [1, 0, false],
      [3, 3, false],
    ])
  })

  it('never backs off consecutive planned restarts (the WebUI 45s wait always suffices)', () => {
    const steps = Array.from({ length: 6 }, (): Step => [0, 8, 3])
    expect(plan(steps).map(([wait]) => wait)).toEqual([1, 1, 1, 1, 1, 1])
  })

  it('keeps the old backoff without a marker, and treats stale or unreadable markers as absent', () => {
    expect(plan(Array.from({ length: 7 }, (): Step => [0, 3.5, null])).map(([wait]) => wait)).toEqual([3, 6, 12, 24, 48, 60, 60])
    // 2 minutes old: left over from an earlier stop that never made the gateway exit.
    expect(plan([[0, 3.5, null], [0, 3.5, 120]])).toEqual([[3, 3, false], [6, 6, false]])
    expect(plan([[0, 3.5, null], [0, 3.5, 'garbage']])).toEqual([[3, 3, false], [6, 6, false]])
    // Crashes keep their fixed 3s even with no marker.
    expect(plan([[0, 3.5, null], [1, 2, null]])).toEqual([[3, 3, false], [3, 3, false]])
  })

  it('cuts a running backoff wait short when a restart is requested while the gateway is down', () => {
    const script = [
      'import importlib.util, json, sys, threading, time',
      'spec = importlib.util.spec_from_file_location("hermes_entrypoint", sys.argv[1])',
      'mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)',
      'marker = mod.GATEWAY_PLANNED_RESTART_MARKER',
      'threading.Timer(0.3, lambda: marker.write_text(repr(time.time()), encoding="utf-8")).start()',
      'started = time.monotonic()',
      'planned = mod.sleep_until_gateway_restart(60.0)',
      'print(json.dumps({"planned": planned, "elapsed": time.monotonic() - started, "marker": marker.exists()}))',
    ].join('\n')
    const result = JSON.parse(execFileSync('python3', ['-c', script, supervisorPath], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1', HERMES_HOME: home },
      timeout: 20_000,
    }).trim().split('\n').pop()!)
    expect(result.planned).toBe(true)
    expect(result.marker).toBe(false)
    expect(result.elapsed).toBeGreaterThan(1)
    expect(result.elapsed).toBeLessThan(3)
  })

  it('main loop: every gateway exit announced by the marker is respawned about 1s later', () => {
    // Real main(); only the two child commands are replaced (a short-lived gateway whose stop
    // the "WebUI" announced, a long-lived WebUI). Without the marker these would be 3s, 6s, 12s.
    const script = [
      'import importlib.util, json, subprocess, sys, time',
      'spec = importlib.util.spec_from_file_location("hermes_entrypoint", sys.argv[1])',
      'mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)',
      'real_popen = subprocess.Popen',
      'spawns = []',
      'def fake_gateway():',
      '    spawns.append(time.monotonic())',
      '    if len(spawns) >= 4:',
      '        mod.stopping = True',
      '    mod.GATEWAY_PLANNED_RESTART_MARKER.write_text(repr(time.time()), encoding="utf-8")',
      '    return real_popen([sys.executable, "-c", "import time; time.sleep(0.2)"], start_new_session=True)',
      'def fake_popen(args, **kwargs):',
      '    if args and args[0] == "node":',
      '        return real_popen([sys.executable, "-c", "import time; time.sleep(30)"], start_new_session=True)',
      '    return real_popen(args, **kwargs)',
      'mod.start_gateway = fake_gateway',
      'mod.subprocess.Popen = fake_popen',
      'rc = mod.main()',
      'print(json.dumps({"rc": rc, "gaps": [b - a for a, b in zip(spawns, spawns[1:])]}))',
    ].join('\n')
    const result = JSON.parse(execFileSync('python3', ['-c', script, supervisorPath], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1', HERMES_HOME: home, PORT: '0' },
      timeout: 30_000,
    }).trim().split('\n').pop()!)
    expect(result.rc).toBe(0)
    expect(result.gaps).toHaveLength(3)
    for (const gap of result.gaps) {
      expect(gap).toBeGreaterThan(1)
      expect(gap).toBeLessThan(2.5)
    }
  }, 40_000)
})
