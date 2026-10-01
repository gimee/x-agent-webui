import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('packages/client/src/views/hermes/HistoryView.vue', 'utf8')

describe('History session stars source contract', () => {
  it('uses the shared tabs and star row actions without pins or batch selection', () => {
    expect(source).toContain('<SessionListTabs v-model="sessionTab"')
    expect(source).toContain("ref<'all' | 'starred'>('all')")
    expect(source).toContain(':starred="sessionBrowserPrefsStore.isStarred(s.id)"')
    expect(source).toContain('@toggle-star="sessionBrowserPrefsStore.toggleStarred(s.id)"')
    expect(source).toContain("t('chat.noStarredSessions')")
    expect(source).not.toMatch(/pinned|isPinned|togglePinned|removePinned|chat\.pin|chat\.unpin/i)
    expect(source).not.toMatch(/batchDelete|BatchMode|BatchDeleting|selectedSessionKeys|toggleSessionSelection|toggle-select|:selectable|:selected|pruneMissingSessions/)
    expect(source).toContain('class="session-close-btn"')
    expect(source).toContain('HistoryMessageList')
    expect(source).toContain("key: 'unarchive'")
  })
})
