<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ChatPanel from '@/components/hermes/chat/ChatPanel.vue'
import { useAppStore } from '@/stores/hermes/app'
import { useChatStore } from '@/stores/hermes/chat'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSettingsStore } from '@/stores/hermes/settings'

const appStore = useAppStore()
const chatStore = useChatStore()
const profilesStore = useProfilesStore()
const settingsStore = useSettingsStore()
const route = useRoute()
const router = useRouter()

const routeSessionId = computed(() => {
  const value = route.params.sessionId
  return typeof value === 'string' && value.trim() ? value : null
})

const routeProfile = computed(() => {
  const value = route.query.profile
  return typeof value === 'string' && value.trim() ? value : null
})

const isStandaloneChat = computed(() => route.meta?.standaloneChat === true)
// community-restored-content-mode-types
type ChatContentMode = 'chat' | 'connections' | 'agents' | 'models' | 'skills' | 'memory'

const contentMode = computed<ChatContentMode>(() => {
  if (route.name === 'hermes.connections') return 'connections'
  if (route.name === 'hermes.agentManager') return 'agents'
// community-restored-content-mode-routes
  if (route.name === 'hermes.models') return 'models'
  if (route.name === 'hermes.mainSkills') return 'skills'
  if (route.name === 'hermes.mainMemory') return 'memory'
  return 'chat'
})
const productTitle = 'X-Agent-Webui'
const tabTitle = computed(() => {
  if (route.name !== 'hermes.session' && route.name !== 'desktop.chat') return productTitle
  return chatStore.activeSession?.title?.trim() || productTitle
})

watch(tabTitle, (value) => {
  document.title = value
}, { immediate: true })

onUnmounted(() => {
  document.title = productTitle
})

async function loadRouteSession() {
  await chatStore.loadSessions(chatStore.sessionProfileFilter, routeSessionId.value)
  if (routeSessionId.value && chatStore.activeSessionId !== routeSessionId.value) {
    await router.replace({ name: 'hermes.chat' })
  }
}

async function applyRouteProfile() {
  const profile = routeProfile.value
  if (!profile || profile === profilesStore.activeProfileName) return
  if (!profilesStore.profiles.some(item => item.name === profile)) return
  await profilesStore.switchProfile(profile)
  chatStore.setSessionProfileFilter(profile)
}

function profileNames(): string[] {
  return profilesStore.profiles.map(profile => profile.name)
}

// profiles 晚于 sessions 到达时的对账：localStorage 里残留的 profile 过滤器若已失效，
// 或首次访问时 activeProfileName 由 null 变为真实 profile，则重新拉一次会话列表。
async function reconcileSessionsAfterProfilesLoaded(activeProfileBefore: string | null) {
  const filterBefore = chatStore.sessionProfileFilter
  chatStore.validateSessionProfileFilter(profileNames())
  const filterChanged = chatStore.sessionProfileFilter !== filterBefore
  const activeChanged = profilesStore.activeProfileName !== activeProfileBefore
  if (!filterChanged && !activeChanged) return
  if (!chatStore.sessionsLoaded && !chatStore.isLoadingSessions) return
  await chatStore.loadSessions(chatStore.sessionProfileFilter, routeSessionId.value)
}

onMounted(async () => {
  chatStore.setRuntimeMode('default')
  appStore.loadModels()
  // profiles 与 sessions 并行：会话列表不再等 GET /api/hermes/profiles。
  // 显示设置只是预取（聊天完成提示音），同样不阻塞列表。
  const activeProfileBefore = profilesStore.activeProfileName
  const profilesReady = profilesStore.fetchProfiles()
  const settingsReady = settingsStore.fetchSettings()
  if (routeProfile.value) {
    // 路由显式带 ?profile= 时需要 profiles 列表来校验并切换，只有这条路径才等。
    await profilesReady
    chatStore.validateSessionProfileFilter(profileNames())
    await applyRouteProfile()
  } else {
    void profilesReady.then(() => reconcileSessionsAfterProfilesLoaded(activeProfileBefore))
  }
  await loadRouteSession()
  await settingsReady
})

watch([routeSessionId, routeProfile], async ([sessionId]) => {
  if (!chatStore.sessionsLoaded) return
  await applyRouteProfile()
  if (!sessionId) {
    await chatStore.loadSessions(chatStore.sessionProfileFilter)
    return
  }
  if (chatStore.activeSessionId === sessionId) return

  const exists = chatStore.sessions.some(session => session.id === sessionId)
  if (!exists) {
    await loadRouteSession()
    return
  }

  await chatStore.switchSession(sessionId)
})
</script>

<template>
  <div class="chat-view" :class="{ 'chat-view--standalone': isStandaloneChat }">
    <ChatPanel
      :standalone="isStandaloneChat"
      :content-mode="contentMode"
    />
  </div>
</template>

<style scoped lang="scss">
.chat-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;

  &--standalone {
    height: 100%;
  }
}
</style>
