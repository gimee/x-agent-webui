import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')

describe('approval system notification click targets', () => {
  it('routes a safe internal target through Service Worker and Electron notification clicks', () => {
    const serviceWorker = read('packages/client/public/notification-sw.js')
    const desktopMain = read('packages/desktop/src/main/index.ts')
    const desktopPreload = read('packages/desktop/src/preload/index.ts')
    const desktopBridge = read('packages/client/src/utils/desktop-bridge.ts')

    expect(serviceWorker).toContain('safeClickUrl(event.notification.data?.clickUrl)')
    expect(serviceWorker).toContain("value.startsWith('/hermes/')")
    expect(serviceWorker).toContain('client.navigate')
    expect(desktopMain).toContain('safeNotificationClickUrl')
    expect(desktopMain).toContain('webUiHashUrl(clickUrl)')
    expect(desktopPreload).toContain('clickUrl?: string')
    expect(desktopBridge).toContain('clickUrl?: string')
  })

  it('switches profile before consuming a pending-action target', () => {
    const globalPending = read('packages/client/src/components/layout/GlobalPendingActions.vue')
    const chatView = read('packages/client/src/views/hermes/ChatView.vue')
    const globalAgentView = read('packages/client/src/views/hermes/GlobalAgentView.vue')
    expect(globalPending).toContain('const profileQuery = `?profile=${encodeURIComponent(action.profile)}`')
    expect(chatView).toContain('await profilesStore.switchProfile(profile)')
    expect(globalAgentView).toContain('await profilesStore.switchProfile(profile)')
  })
})
