// hermes-v050:S7 /api/coding-agents status cache: `<cli> --version` (pi ~370ms) must not run on
// every request, yet an install/update/delete or an on-disk upgrade must show immediately.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execState = vi.hoisted(() => {
  const versionCalls: string[] = []
  const versions: Record<string, string> = {}
  // hermes-v050:F-16 CLIs whose next `--version` fails although they are installed (CPU contention at boot)
  const failNext = new Set<string>()
  const execFile = vi.fn()
  ;(execFile as any)[Symbol.for('nodejs.util.promisify.custom')] = async (command: string, args: string[]) => {
    const name = String(command).split('/').pop() || ''
    if (args[0] === '--version') {
      versionCalls.push(name)
      if (failNext.delete(name)) throw Object.assign(new Error(`Command failed: ${name} --version (timed out)`), { killed: true, signal: 'SIGTERM' })
      if (!versions[name]) throw Object.assign(new Error(`${name} not found`), { code: 'ENOENT' })
      return { stdout: `${versions[name]}\n`, stderr: '' }
    }
    // npm prefix -g / which: behave as if npm is unavailable
    throw Object.assign(new Error(`unexpected command: ${command} ${args.join(' ')}`), { code: 'ENOENT' })
  }
  return { execFile, versionCalls, versions, failNext }
})

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: execState.execFile,
}))

const originalEnv = { ...process.env }
const originalExecPath = process.execPath
let root = ''
let binDir = ''

beforeEach(() => {
  vi.resetModules()
  root = mkdtempSync(join(tmpdir(), 'hermes-coding-agent-status-'))
  binDir = join(root, 'bin')
  mkdirSync(binDir, { recursive: true })
  for (const command of ['claude', 'pi']) writeFileSync(join(binDir, command), '#!/bin/sh\n# v1\n', { mode: 0o755 })
  const adapter = join(root, 'web', 'coding-agent', 'pi-mcp-adapter', 'node_modules', 'pi-mcp-adapter')
  mkdirSync(adapter, { recursive: true })
  writeFileSync(join(adapter, 'index.ts'), 'export {}\n')
  process.env.HERMES_WEB_UI_HOME = join(root, 'web')
  process.env.HERMES_WEBUI_STATE_DIR = join(root, 'web')
  process.env.PATH = binDir
  // The service puts node's own bin dir first on PATH; keep the host's real CLIs out of it.
  Object.defineProperty(process, 'execPath', { value: join(binDir, 'node'), configurable: true, writable: true })
  delete process.env.HERMES_DESKTOP
  execState.versionCalls.length = 0
  execState.failNext.clear()
  for (const key of Object.keys(execState.versions)) delete execState.versions[key]
  Object.assign(execState.versions, { claude: '2.1.0 (Claude Code)', pi: '0.70.0' })
})

afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true, writable: true })
  process.env = { ...originalEnv }
  rmSync(root, { recursive: true, force: true })
})

async function service() {
  return import('../../packages/server/src/modules/coding-agents/services/index')
}

function versionsOf(status: { tools: Array<{ id: string; version: string; installed: boolean }> }) {
  return Object.fromEntries(status.tools.map(tool => [tool.id, tool.installed ? tool.version : 'missing']))
}

describe('coding agent status cache', () => {
  it('probes each CLI once for repeated and concurrent status requests', async () => {
    const { getCodingAgentsStatus } = await service()

    const [first, second] = await Promise.all([getCodingAgentsStatus(), getCodingAgentsStatus()])
    const third = await getCodingAgentsStatus()

    expect(versionsOf(first)).toEqual({ 'claude-code': '2.1.0', codex: 'missing', pi: '0.70.0' })
    expect(versionsOf(second)).toEqual(versionsOf(first))
    expect(versionsOf(third)).toEqual(versionsOf(first))
    expect(execState.versionCalls.sort()).toEqual(['claude', 'codex', 'pi'])
  })

  it('re-probes after the TTL expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { getCodingAgentsStatus } = await service()
    await getCodingAgentsStatus()
    execState.versions.claude = '2.2.0 (Claude Code)'

    vi.setSystemTime(Date.now() + 4 * 60_000)
    expect(versionsOf(await getCodingAgentsStatus())['claude-code']).toBe('2.1.0')
    vi.setSystemTime(Date.now() + 2 * 60_000)
    expect(versionsOf(await getCodingAgentsStatus())['claude-code']).toBe('2.2.0')
  })

  it('shows a fresh probe (install/update/delete path) in the next status request', async () => {
    const { getCodingAgentsStatus, getCodingAgentDefinition, getCodingAgentStatus } = await service()
    await getCodingAgentsStatus()
    execState.versions.pi = '0.71.0'

    await getCodingAgentStatus(getCodingAgentDefinition('pi')!)
    const calls = execState.versionCalls.length

    expect(versionsOf(await getCodingAgentsStatus()).pi).toBe('0.71.0')
    expect(execState.versionCalls.length).toBe(calls)
  })

  it('hermes-v050:F-16 keeps a failed probe only briefly, so a boot-time hiccup does not hide the CLI for 5 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    execState.failNext.add('claude')
    const { getCodingAgentsStatus } = await service()

    expect(versionsOf(await getCodingAgentsStatus())['claude-code']).toBe('missing')
    // Repeated requests right after still share that answer (no probe storm)...
    vi.setSystemTime(Date.now() + 5_000)
    expect(versionsOf(await getCodingAgentsStatus())['claude-code']).toBe('missing')
    expect(execState.versionCalls.filter(name => name === 'claude')).toHaveLength(1)
    // ...but a few seconds later the CLI is probed again and shows up.
    vi.setSystemTime(Date.now() + 6_000)
    expect(versionsOf(await getCodingAgentsStatus())['claude-code']).toBe('2.1.0')
    expect(execState.versionCalls.filter(name => name === 'claude')).toHaveLength(2)
    // The successful probe is cached for the full TTL again.
    vi.setSystemTime(Date.now() + 4 * 60_000)
    await getCodingAgentsStatus()
    expect(execState.versionCalls.filter(name => name === 'claude')).toHaveLength(2)
  })

  it('re-probes a CLI whose executable changed on disk before the TTL', async () => {
    const { getCodingAgentsStatus } = await service()
    await getCodingAgentsStatus()
    execState.versions.claude = '2.3.0 (Claude Code)'
    writeFileSync(join(binDir, 'claude'), '#!/bin/sh\n# v2 upgraded out of band\n', { mode: 0o755 })

    const status = await getCodingAgentsStatus()

    expect(versionsOf(status)['claude-code']).toBe('2.3.0')
    expect(execState.versionCalls.filter(name => name === 'claude')).toHaveLength(2)
    expect(execState.versionCalls.filter(name => name === 'pi')).toHaveLength(1)
  })

  it('re-probes Pi when its MCP adapter appears or disappears', async () => {
    const { getCodingAgentsStatus } = await service()
    await getCodingAgentsStatus()
    rmSync(join(root, 'web', 'coding-agent', 'pi-mcp-adapter'), { recursive: true, force: true })

    const status = await getCodingAgentsStatus()

    expect(status.tools.find(tool => tool.id === 'pi')).toMatchObject({ installed: false, error: 'Pi MCP Adapter is not installed' })
  })
})
