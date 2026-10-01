// hermes-v050:C1 源码形状：侧栏改为虚拟列表，SessionListItem 的弹层按需挂载。
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : ''
const chatPanel = read('packages/client/src/components/hermes/chat/ChatPanel.vue')
const sessionListItem = read('packages/client/src/components/hermes/chat/SessionListItem.vue')
const virtualList = read('packages/client/src/components/hermes/chat/VirtualSessionList.vue')

describe('C1 sidebar virtualization source contract', () => {
  it('renders visibleSessions through the virtual list instead of a full v-for', () => {
    expect(chatPanel).not.toContain('v-for="s in visibleSessions"')
    expect(chatPanel).toMatch(/<VirtualSessionList v-if="showSessions" class="session-items" :items="visibleSessions">/)
    const start = chatPanel.indexOf('<VirtualSessionList')
    const end = chatPanel.indexOf('</VirtualSessionList>', start)
    const block = chatPanel.slice(start, end)
    // 行内绑定与原来逐项一致
    for (const binding of [
      ':key="s.id"',
      ':session="s"',
      ':active="s.id === chatStore.activeSessionId"',
      ':starred="sessionBrowserPrefsStore.isStarred(s.id)"',
      ':streaming="chatStore.isSessionLive(s.id)"',
      ':completed-unread="chatStore.isSessionCompletedUnread(s.id)"',
      ':to="sessionHref(s.id)"',
      ':intercept-modified-navigation="desktopChatWindowAvailable"',
      '@select="handleSessionClick(s.id)"',
      '@open-new="openSessionInNewTab(s.id, s.profile || null)"',
      '@contextmenu="handleContextMenu($event, s.id)"',
      '@delete="handleDeleteSession(s.id)"',
      '@toggle-star="sessionBrowserPrefsStore.toggleStarred(s.id)"',
    ]) {
      expect(block).toContain(binding)
    }
    expect(block).toContain('class="session-loading"')
    expect(block).toContain('t("chat.noStarredSessions")')
  })

  // hermes-v050:F-07 RecycleScroller 在顺序变化时回收重挂全部可见行；改为按会话 id 作 key 的窗口切片
  it('renders a window of rows keyed by session id (no RecycleScroller view pool)', () => {
    expect(virtualList).not.toContain('import { RecycleScroller }')
    expect(virtualList).not.toContain('<RecycleScroller')
    expect(virtualList).toMatch(/v-for="\(item, offset\) in visibleRows"\s+:key="item\.id"/)
    expect(virtualList).toContain('class="virtual-session-list__spacer"')
  })

  it('mounts the original NTooltip / NPopconfirm lazily with unchanged slots and copy', () => {
    expect(sessionListItem).toContain('<component :is="popoversArmed ? NTooltip : PopoverTriggerShell">')
    expect(sessionListItem).toContain(':is="popoversArmed ? NPopconfirm : PopoverTriggerShell"')
    expect(sessionListItem).toContain('@positive-click="emit(\'delete\')"')
    expect(sessionListItem).toContain("{{ t('chat.deleteSession') }}")
    expect(sessionListItem).toContain("{{ t(starred ? 'chat.unstarSession' : 'chat.starSession') }}")
    expect(sessionListItem).not.toMatch(/<NTooltip>\s*<template #trigger>\s*<button\s+type="button"\s+class="session-item-star"/)
    expect(sessionListItem).not.toContain('<NPopconfirm v-if="canDelete"')
  })

  it('keeps the hover visibility rules for row actions, including touch', () => {
    expect(sessionListItem).toMatch(/\.session-item:hover \.session-item-star,\s*\.session-item:hover \.session-item-delete \{\s*opacity: 1;\s*pointer-events: auto;/)
    expect(sessionListItem).toMatch(/\.session-item:focus-within \.session-item-star,\s*\.session-item:focus-within \.session-item-delete \{\s*opacity: 1;\s*pointer-events: auto;/)
    expect(sessionListItem).toMatch(/@media \(hover: none\) \{\s*\.session-item-star,\s*\.session-item-delete \{\s*opacity: 0\.5;\s*pointer-events: auto;/)
  })
})
