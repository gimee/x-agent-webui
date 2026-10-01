// hermes-v050:S11 /health asks for the Hermes version every 30s per tab; the Python import
// probe behind it must run once per installation state, not once per request.
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalEnv = { ...process.env }
let root = ''
let counter = ''

// Same layout as the image: <root>/{run_agent.py, hermes_cli/__init__.py, .venv/bin/{hermes,python3}}
function writeInstall(version: string): string {
  const agentRoot = join(root, 'hermes')
  const bin = join(agentRoot, '.venv', 'bin')
  mkdirSync(join(agentRoot, 'hermes_cli'), { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(agentRoot, 'run_agent.py'), '')
  writeFileSync(join(agentRoot, 'hermes_cli', '__init__.py'), `__version__ = "${version}"\n`)
  writeFileSync(join(bin, 'python3'), `#!/bin/sh\necho probe >> '${counter}'\nprintf '${version}\\n'\n`)
  chmodSync(join(bin, 'python3'), 0o755)
  writeFileSync(join(bin, 'hermes'), '#!/bin/sh\nexit 97\n')
  chmodSync(join(bin, 'hermes'), 0o755)
  return join(bin, 'hermes')
}

function probes(): number {
  try {
    return readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

function bumpMtime(path: string, secondsAhead: number) {
  const when = new Date(Date.now() + secondsAhead * 1000)
  utimesSync(path, when, when)
}

beforeEach(() => {
  vi.resetModules()
  root = mkdtempSync(join(tmpdir(), 'hermes-version-cache-'))
  counter = join(root, 'probes.log')
  appendFileSync(counter, '')
  process.env.HERMES_HOME = join(root, 'home')
})

afterEach(() => {
  vi.useRealTimers()
  process.env = { ...originalEnv }
  rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('Hermes version cache behind /health', () => {
  it('probes the installation once for repeated and concurrent version reads', async () => {
    process.env.HERMES_BIN = writeInstall('0.21.5')
    const cli = await import('../../packages/server/src/modules/hermes/services/runtime/cli')

    const [a, b] = await Promise.all([cli.getVersion(), cli.getVersion()])
    const c = await cli.getVersion()

    expect([a, b, c]).toEqual(['0.21.5', '0.21.5', '0.21.5'])
    expect(probes()).toBe(1)
  })

  it('re-probes after an in-place upgrade rewrites hermes_cli', async () => {
    process.env.HERMES_BIN = writeInstall('0.21.5')
    const cli = await import('../../packages/server/src/modules/hermes/services/runtime/cli')
    expect(await cli.getVersion()).toBe('0.21.5')

    writeInstall('0.22.0')
    bumpMtime(join(root, 'hermes', 'hermes_cli', '__init__.py'), 5)

    expect(await cli.getVersion()).toBe('0.22.0')
    expect(await cli.getVersion()).toBe('0.22.0')
    expect(probes()).toBe(2)
  })

  it('retries a failed probe after a short delay instead of caching the failure', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    process.env.HERMES_BIN = writeInstall('0.21.6')
    // The probe fails until an external condition clears; nothing in the installation changes.
    const ready = join(root, 'ready')
    const python = join(root, 'hermes', '.venv', 'bin', 'python3')
    writeFileSync(python, `#!/bin/sh\necho probe >> '${counter}'\n[ -f '${ready}' ] || exit 1\nprintf '0.21.6\\n'\n`)
    const cli = await import('../../packages/server/src/modules/hermes/services/runtime/cli')
    expect(await cli.getVersion()).toBe('')
    expect(await cli.getVersion()).toBe('')
    expect(probes()).toBe(1)

    writeFileSync(ready, '')
    expect(await cli.getVersion()).toBe('')
    vi.setSystemTime(Date.now() + 31_000)
    expect(await cli.getVersion()).toBe('0.21.6')
    expect(probes()).toBe(2)
  })
})
