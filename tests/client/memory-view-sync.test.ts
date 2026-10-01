import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

describe('MemoryView Claude sync', () => {
  const source = readFileSync('packages/client/src/views/hermes/MemoryView.vue', 'utf8')

  it('places Claude sync immediately before the memory lock button', () => {
    const sync = source.indexOf('data-testid="memory-sync-claude"')
    const lock = source.indexOf('data-testid="memory-lock-toggle"')
    expect(sync).toBeGreaterThan(-1)
    expect(lock).toBeGreaterThan(sync)
  })

  it('exposes exactly three confirmation actions', () => {
    expect(source).toContain("@click=\"showSyncDialog = false\"")
    expect(source).toContain("@click=\"syncClaude(false)\"")
    expect(source).toContain("@click=\"syncClaude(true)\"")
    expect(source).toContain("width: 'min(560px, calc(100vw - 32px))'")
  })
})
