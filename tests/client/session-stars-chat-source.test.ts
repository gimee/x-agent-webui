import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'packages/client/src/components/hermes/chat/ChatPanel.vue'), 'utf8')

describe('ChatPanel session stars source contract', () => {
  it('replaces profile and batch controls with shared all/starred tabs while retaining the mobile close button', () => {
    expect(source).toMatch(/const sessionListTab = ref<"all" \| "starred">\("all"\)/)
    expect(source).toContain('<SessionListTabs v-model="sessionListTab" />')
    expect(source).not.toMatch(/profileFilterOptions|handleProfileFilterChange|session-profile-filter|isBatchMode|selectedSessionKeys|toggle-select|batchDeleteSessions|NPopconfirm|pinnedSessions|isPinned|togglePinned|removePinned|pruneMissingSessions/)
    expect(source).toContain('chatStore.setSessionProfileFilter(null)')
    expect(source).toMatch(/class="session-close-btn"[^>]*@click="showSessions = false"/)
    expect(source).toMatch(/@media[^}]+\.session-close-btn\s*\{\s*display: flex;/)
  })
})
