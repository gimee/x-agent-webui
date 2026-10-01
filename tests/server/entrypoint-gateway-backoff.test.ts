import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// hermes-v050:S1 behavior of the PID1 restart policy, executed by the real Python module.
const supervisorPath = resolve(__dirname, '../..', '../hermes-entrypoint.py')
const hasPython = spawnSync('python3', ['--version']).status === 0

function delays(exits: Array<[rc: number, ranFor: number]>): number[] {
  const script = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("hermes_entrypoint", sys.argv[1])',
    'mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)',
    'delay, out = 0.0, []',
    'for rc, ran in json.loads(sys.argv[2]):',
    '    delay = mod.next_gateway_restart_delay(rc, ran, delay); out.append(delay)',
    'print(json.dumps(out))',
  ].join('\n')
  return JSON.parse(execFileSync('python3', ['-c', script, supervisorPath, JSON.stringify(exits)], { encoding: 'utf8' }))
}

describe.skipIf(!existsSync(supervisorPath) || !hasPython)('PID1 gateway restart backoff', () => {
  it('doubles 3s to 60s while the gateway keeps exiting cleanly within seconds ("nothing to start")', () => {
    expect(delays(Array.from({ length: 7 }, () => [0, 3.5] as [number, number]))).toEqual([3, 6, 12, 24, 48, 60, 60])
  })

  it('restarts crashes and long-running exits after the original 3s', () => {
    expect(delays([[0, 3.5], [0, 3.5], [1, 2], [0, 3.5], [0, 3600]])).toEqual([3, 6, 3, 6, 3])
    expect(delays([[143, 0.5], [2, 1]])).toEqual([3, 3])
  })
})
