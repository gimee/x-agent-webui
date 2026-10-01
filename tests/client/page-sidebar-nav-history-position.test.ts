import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const navSource = readFileSync(
  'packages/client/src/components/layout/PageSidebarNav.vue',
  'utf8',
)
const historyViewSource = readFileSync(
  'packages/client/src/views/hermes/HistoryView.vue',
  'utf8',
)

describe('page sidebar conversation switch', () => {
  it('orders the four-way switch as chat, history, search, quick phrases (v0.1.2)', () => {
    const switchStart = navSource.indexOf('conversation-switch conversation-switch--four')
    const switchSource = navSource.slice(switchStart)

    expect(switchStart).toBeGreaterThan(-1)
    expect(switchSource.indexOf('@click="openChat"')).toBeLessThan(switchSource.indexOf('@click="openHistory"'))
    expect(switchSource.indexOf('@click="openHistory"')).toBeLessThan(switchSource.indexOf('@click="openSessionSearch"'))
    expect(switchSource.indexOf('@click="openSessionSearch"')).toBeLessThan(switchSource.indexOf('data-testid="nav-quick-phrases"'))
    expect(navSource).not.toContain('openGroupChat')
    expect(navSource).not.toContain('openWorkflow')
    expect(navSource).not.toContain('class="quick-actions"')
    expect(navSource.match(/@click="openHistory"/g)).toHaveLength(1)
  })

  it('shows the conversation switch on the history page', () => {
    const historyNav = historyViewSource.match(/<PageSidebarNav[\s\S]*?\/>/)?.[0] || ''

    expect(historyNav).toContain('active="history"')
    expect(historyNav).not.toContain('hide-mode-switch')
  })
})
