// hermes-v050:F-01 撤掉 C7 的 KeepAlive（源码形状）：App 回到普通 <router-view />，聊天子树不再注册
// activated/deactivated 钩子；C1 虚拟列表、C12 锚点二分、C3 按 id 签名这些与缓存无关的优化保留。
// 行为见 v050-f01-leave-chat-unmounts.test.ts（真实 App.vue + vue-router）。
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(`packages/client/src/${path}`, 'utf8')

describe('chat view is no longer kept alive (F-01)', () => {
  it('App renders a plain router-view without KeepAlive', () => {
    const app = read('App.vue')
    expect(app).toMatch(/<router-view\s*\/>/)
    expect(app).not.toContain('KeepAlive')
    expect(app).not.toContain('keptAliveViews')
    expect(app).not.toContain('keep-alive')
    expect(existsSync('packages/client/src/router/keep-alive.ts')).toBe(false)
  })

  it('no chat component registers activated/deactivated hooks any more', () => {
    for (const file of [
      'views/hermes/ChatView.vue',
      'components/hermes/chat/ChatPanel.vue',
      'components/hermes/chat/MessageList.vue',
      'components/hermes/chat/VirtualMessageList.vue',
      'components/hermes/chat/VirtualSessionList.vue',
      'components/hermes/chat/MessageItem.vue',
      'components/hermes/chat/ChatInput.vue',
      'components/hermes/chat/ConversationMonitorPane.vue',
    ]) {
      const source = read(file)
      expect(source, file).not.toMatch(/\bon(Activated|Deactivated)\b/)
      expect(source, file).not.toContain('hermes-v050:C7')
    }
  })

  it('ChatView mounts straight into the v0.4.6 flow (no activation gating)', () => {
    const view = read('views/hermes/ChatView.vue')
    expect(view).not.toContain('chatViewActive')
    expect(view).toMatch(/onMounted\(async \(\) => \{\n\s+chatStore\.setRuntimeMode\('default'\)/)
  })

  it('keeps the non-cache optimisations (C1, C12, C3)', () => {
    const panel = read('components/hermes/chat/ChatPanel.vue')
    expect(panel).toContain('<VirtualSessionList v-if="showSessions" class="session-items" :items="visibleSessions">')
    const list = read('components/hermes/chat/VirtualMessageList.vue')
    expect(list).toContain('hermes-v050:C12')
    expect(list).toContain(':data-virtual-inactive="active ? undefined : \'\'"')
    expect(list).toContain('const messageKeySignature = computed(')
  })
})
