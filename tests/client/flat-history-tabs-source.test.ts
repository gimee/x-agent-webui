import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
const history = readFileSync('packages/client/src/views/hermes/HistoryView.vue', 'utf8')
const tabs = readFileSync('packages/client/src/components/hermes/chat/SessionListTabs.vue', 'utf8')
describe('flat history and raised tabs', () => {
  it('uses a flat newest-activity list with a global page cursor', () => {
    expect(history).toContain('v-for="s in visibleHistorySessions"')
    expect(history).not.toMatch(/groupedSessions|collapsedGroups|sourceOffsets|sourceSortKey/)
    expect(history).toContain('loadMoreSessions')
    expect(history).toContain('listOffset')
    expect(history).toContain('(b.updatedAt || 0) - (a.updatedAt || 0)')
  })
  it('uses bordered card tabs with reserved height', () => {
    expect(tabs).toContain('type="card"')
    expect(tabs).toContain('height: 34px')
    expect(tabs).toContain('height: 30px')
    expect(tabs).toContain('n-tabs-tab--active')
    expect(tabs).toContain('gap: 0;')
    expect(tabs).toContain('border-radius: 0;')
    expect(tabs).toContain('box-shadow: none;')
    expect(tabs).not.toContain('box-shadow: inset')
    for (const path of ['packages/client/src/components/hermes/chat/ChatPanel.vue', 'packages/client/src/views/hermes/HistoryView.vue']) {
      const owner = readFileSync(path, 'utf8')
      expect(owner).toContain('padding: 12px 12px 0;')
      expect(owner).toContain('margin-bottom: -1px;')
    }
  })
})
