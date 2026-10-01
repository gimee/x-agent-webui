import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readCodingAgentConfigFile,
  writeCodingAgentConfigFile,
} from '../../packages/server/src/modules/coding-agents/services/index'

describe('Community Claude CLAUDE.md config file', () => {
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'community-claude-config-'))
    process.env.HERMES_CODING_AGENT_GLOBAL_HOME = home
  })

  afterEach(() => {
    delete process.env.HERMES_CODING_AGENT_GLOBAL_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('reads and writes the user-owned ~/.claude/CLAUDE.md without using hermes-rules.md', async () => {
    const first = await readCodingAgentConfigFile('claude-code', 'memory')
    expect(first.path).toBe('~/.claude/CLAUDE.md')
    expect(first.exists).toBe(false)

    const written = await writeCodingAgentConfigFile('claude-code', 'memory', '# User rules\n')
    expect(written.exists).toBe(true)
    expect(written.absolutePath).toBe(join(home, '.claude', 'CLAUDE.md'))
    expect(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe('# User rules\n')

    const reread = await readCodingAgentConfigFile('claude-code', 'memory')
    expect(reread.content).toBe('# User rules\n')
    expect(reread.path).toBe('~/.claude/CLAUDE.md')
  })

  it('reads and writes the user-owned ~/.claude/settings.json', async () => {
    const first = await readCodingAgentConfigFile('claude-code', 'settings')
    expect(first.path).toBe('~/.claude/settings.json')
    expect(first.exists).toBe(false)

    const settings = '{\n  \"model\": \"claude-test\",\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \"https://example.invalid\"\n  }\n}\n'
    const written = await writeCodingAgentConfigFile('claude-code', 'settings', settings)
    expect(written.exists).toBe(true)
    expect(written.absolutePath).toBe(join(home, '.claude', 'settings.json'))
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toBe(settings)

    const reread = await readCodingAgentConfigFile('claude-code', 'settings')
    expect(reread.content).toBe(settings)
    expect(reread.path).toBe('~/.claude/settings.json')
  })
})
