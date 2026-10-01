import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

describe('session pin retirement', () => {
  it('leaves no pin state or actions in session runtime owners', () => {
    for (const path of [
      'packages/client/src/stores/hermes/chat.ts',
      'packages/client/src/stores/hermes/session-browser-prefs.ts',
      'packages/client/src/components/hermes/chat/ChatPanel.vue',
      'packages/client/src/components/hermes/chat/SessionListItem.vue',
      'packages/client/src/components/hermes/chat/session-menu-options.ts',
      'packages/client/src/views/hermes/HistoryView.vue',
    ]) {
      const source = readFileSync(path, 'utf8')
      expect(source, path).not.toMatch(/hermes_session_pins|pinnedIds|isPinned|togglePinned|removePinned|chat\.pin|chat\.unpin|session-item-pin/)
    }
  })
  it('keeps independent skill pinning and the batch-delete compatibility API', () => {
    expect(readFileSync('packages/server/src/modules/hermes/controllers/skills.ts', 'utf8')).toContain('updatePinnedSkill')
    expect(readFileSync('packages/server/src/modules/studio/routes/sessions.ts', 'utf8')).toContain("'/api/studio/sessions/batch-delete'")
    const chat = readFileSync('packages/client/src/stores/hermes/chat.ts', 'utf8')
    const recovery = chat.slice(chat.indexOf('function recoverStorageQuota()'), chat.indexOf('function setItemBestEffort('))
    expect(recovery).not.toContain('hermes_session_stars')
  })
})
