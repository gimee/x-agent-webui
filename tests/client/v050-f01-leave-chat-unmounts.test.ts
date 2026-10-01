// @vitest-environment jsdom
// hermes-v050:F-01 真实 App.vue + vue-router：离开聊天页时聊天视图照 v0.4.6 卸载，它对全局 store 的 watcher
// 不再在别的页面上运行（C7 的 KeepAlive 让被缓存的 ChatPanel 在文件页劫持 filesStore 的预览与目录）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, onMounted, onUnmounted, reactive, watch } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

const sharedStore = reactive({ previewFile: null as string | null })
const chatViewEvents = { mounted: 0, unmounted: 0, previewReactions: 0 }

vi.mock('vue-i18n', async () => {
  const { ref: vueRef } = await import('vue')
  return { useI18n: () => ({ t: (key: string) => key, locale: vueRef('zh') }) }
})
vi.mock('@/composables/useTheme', async () => {
  const { ref: vueRef } = await import('vue')
  return {
    useTheme: () => ({
      isDark: vueRef(false),
      isComic: vueRef(false),
      customization: vueRef({}),
      hasBackgroundImage: vueRef(false),
      syncThemeFromServer: () => Promise.resolve(),
    }),
  }
})
vi.mock('@/styles/theme', () => ({ getThemeOverrides: () => ({}) }))
vi.mock('@/composables/useKeyboard', () => ({ useKeyboard: () => undefined }))
vi.mock('@/composables/useSessionSearch', async () => {
  const { ref: vueRef } = await import('vue')
  return { useSessionSearch: () => ({ sessionSearchOpen: vueRef(false) }) }
})
vi.mock('@/composables/useTtsSettingsHydration', () => ({ watchServerTtsSettingsHydration: () => undefined }))
vi.mock('@/stores/hermes/app', async () => {
  const { reactive: vueReactive } = await import('vue')
  const store = vueReactive({
    nodeVersion: '24.0.0',
    sidebarCollapsed: false,
    sidebarOpen: false,
    pageSidebarExpanded: true,
    loadModels: () => undefined,
    startHealthPolling: () => undefined,
    stopHealthPolling: () => undefined,
    closeSidebar: () => undefined,
    toggleSidebar: () => undefined,
  })
  return { useAppStore: () => store }
})
vi.mock('@/stores/hermes/profiles', () => ({ useProfilesStore: () => ({ activeProfileName: 'default' }) }))
vi.mock('@/api/client', () => ({ isStoredSuperAdmin: () => false }))
vi.mock('@/utils/desktop-bridge', () => ({ desktopBridge: () => undefined }))

const stub = vi.hoisted(() => async (name: string) => {
  const vue = await import('vue')
  return { default: vue.defineComponent({ name, render: () => vue.h('div', { class: `stub-${name}` }) }) }
})
vi.mock('@/components/auth/AuthEventListener.vue', () => stub('AuthEventListener'))
vi.mock('@/components/layout/AppSidebar.vue', () => stub('AppSidebar'))
vi.mock('@/components/layout/HermesConfigSidebar.vue', () => stub('HermesConfigSidebar'))
vi.mock('@/components/layout/CodingAgentConfigSidebar.vue', () => stub('CodingAgentConfigSidebar'))
vi.mock('@/components/layout/DesktopTitleBar.vue', () => stub('DesktopTitleBar'))
vi.mock('@/components/hermes/chat/SessionSearchModal.vue', () => stub('SessionSearchModal'))
vi.mock('@/components/auth/DefaultCredentialPrompt.vue', () => stub('DefaultCredentialPrompt'))
vi.mock('@/components/hermes/models/ProviderConfigurationPrompt.vue', () => stub('ProviderConfigurationPrompt'))
vi.mock('@/components/layout/GlobalPendingActions.vue', () => stub('GlobalPendingActions'))
vi.mock('@/components/layout/RuntimeRestartPrompt.vue', () => stub('RuntimeRestartPrompt'))

// 与真实聊天视图同名（KeepAlive 的 include 按组件名匹配）
const ChatView = defineComponent({
  name: 'ChatView',
  setup() {
    onMounted(() => { chatViewEvents.mounted += 1 })
    onUnmounted(() => { chatViewEvents.unmounted += 1 })
    watch(() => sharedStore.previewFile, () => { chatViewEvents.previewReactions += 1 })
    return () => h('div', { class: 'chat-view-stub' })
  },
})
const FilesView = defineComponent({ name: 'FilesView', render: () => h('div', { class: 'files-view-stub' }) })

import App from '@/App.vue'

async function mountApp() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/hermes/session/:sessionId', name: 'hermes.session', component: ChatView },
      { path: '/hermes/files', name: 'hermes.files', component: FilesView },
    ],
  })
  await router.push('/hermes/session/s1')
  await router.isReady()
  const wrapper = mount(App, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return { wrapper, router }
}

describe('leaving the chat page unmounts the chat view (F-01)', () => {
  afterEach(() => {
    chatViewEvents.mounted = 0
    chatViewEvents.unmounted = 0
    chatViewEvents.previewReactions = 0
    sharedStore.previewFile = null
    document.body.innerHTML = ''
  })

  it('does not keep chat-view watchers running on the files page', async () => {
    const { wrapper, router } = await mountApp()
    expect(wrapper.find('.chat-view-stub').exists()).toBe(true)
    expect(chatViewEvents.mounted).toBe(1)

    await router.push('/hermes/files')
    await flushPromises()
    expect(wrapper.find('.files-view-stub').exists()).toBe(true)
    expect(chatViewEvents.unmounted).toBe(1)

    // 文件页打开预览：聊天视图已经不在，不能再有人响应
    sharedStore.previewFile = 'docs/x.png'
    await flushPromises()
    expect(chatViewEvents.previewReactions).toBe(0)

    // 回到聊天页：重新挂载（v0.4.6 行为）
    await router.push('/hermes/session/s1')
    await flushPromises()
    expect(chatViewEvents.mounted).toBe(2)
    expect(document.querySelectorAll('.chat-view-stub')).toHaveLength(1)
    wrapper.unmount()
  })
})
