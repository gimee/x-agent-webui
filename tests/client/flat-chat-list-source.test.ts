import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
describe('flat chat list contract', () => {
  it('renders each session once without recent or categories', () => {
    const s=readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue','utf8')
    // hermes-v050:C1 侧栏改为虚拟列表，仍是对 visibleSessions 的单层平铺
    expect(s.includes('<VirtualSessionList v-if="showSessions" class="session-items" :items="visibleSessions">')).toBe(true)
    expect(/sessionCategor|newChatCategory|categorizedSessions|recentSessionPartition|showRecentSessions/.test(s)).toBe(false)
    const sort=s.slice(s.indexOf('function sortSessionsForSidebar'),s.indexOf('const visibleSessions'))
    expect(sort.includes('isSessionLive')).toBe(false)
    expect(sort.includes('(b.updatedAt || 0) - (a.updatedAt || 0)')).toBe(true)
    expect(sort.includes('a.id.localeCompare(b.id)')).toBe(true)
  })
})
