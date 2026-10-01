import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildClaudeMemoryContent,
  claudeMemoryPath,
  syncMemoryToClaude,
} from '../../packages/server/src/modules/hermes/controllers/memory'

describe('Claude memory sync', () => {
  let configDir = ''

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'hermes-claude-sync-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
  })

  afterEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR
    rmSync(configDir, { recursive: true, force: true })
  })

  it('completely replaces CLAUDE.md with MEMORY.md content', async () => {
    const target = claudeMemoryPath()
    writeFileSync(target, 'stale prompt\n')

    const result = await syncMemoryToClaude('current memory\n')

    expect(result.path).toBe(target)
    expect(readFileSync(target, 'utf8')).toBe('current memory\n')
    expect(readFileSync(target, 'utf8')).not.toContain('stale prompt')
  })

  it('adds the exact SOUL.md pointer as the final line only when requested', () => {
    expect(buildClaudeMemoryContent('current memory\n', '/home/agent/.hermes/SOUL.md'))
      .toBe('current memory\nHermes SOUL.md: /home/agent/.hermes/SOUL.md\n')
    expect(buildClaudeMemoryContent('current memory\n')).toBe('current memory\n')
  })
})
