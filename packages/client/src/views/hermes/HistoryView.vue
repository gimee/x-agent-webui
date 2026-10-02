<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { type Session } from '@/stores/hermes/chat'
import { useAppStore } from '@/stores/hermes/app'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSessionBrowserPrefsStore } from '@/stores/hermes/session-browser-prefs'
import { NButton, NDropdown, NTooltip, useMessage, type DropdownOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { getSourceLabel } from '@/shared/session-display'
import { copyToClipboard } from '@/utils/clipboard'
import HistoryMessageList from '@/components/hermes/chat/HistoryMessageList.vue'
import SessionListItem from '@/components/hermes/chat/SessionListItem.vue'
import SessionListTabs from '@/components/hermes/chat/SessionListTabs.vue'
import OutlinePanel from '@/components/hermes/chat/OutlinePanel.vue'
import PageSidebarNav from '@/components/layout/PageSidebarNav.vue'
import PageSidebarFooter from '@/components/layout/PageSidebarFooter.vue'
import { deleteSession, fetchHermesSessionGroups, fetchHermesSessionPage, fetchHermesSession, fetchSessionMessagesPage, importHermesSession, unarchiveSession, type HermesMessage, type SessionSummary } from '@/api/studio/sessions'

const appStore = useAppStore()
const profilesStore = useProfilesStore()
const sessionBrowserPrefsStore = useSessionBrowserPrefsStore()
const message = useMessage()
const { t } = useI18n()
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

const effectiveHistoryProfile = computed(() => profilesStore.activeProfileName || routeProfile.value || null)

// Flat history across sources, ordered by last activity.
const hermesSessions = ref<SessionSummary[]>([])
const hermesSessionsLoading = ref(false)
const hermesSessionsLoaded = ref(false)
// History page's own selected session (independent from chatStore)
const historySessionId = ref<string | null>(null)
const historySession = ref<Session | null>(null)
const showOutline = ref(false)
const historyMessageListRef = ref<InstanceType<typeof HistoryMessageList> | null>(null)
const sessionTab = ref<'all' | 'starred'>('all')
const contextSessionId = ref<string | null>(null)
const showContextMenu = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
let hermesSessionsRequestId = 0
let historySessionRequestId = 0
const HISTORY_PAGE_SIZE = 150
const HISTORY_LIST_PAGE_SIZE = 50
// The existing groups controller accepts at most 100 include IDs per request.
const HISTORY_INCLUDE_LIMIT = 100
const listHasMore = ref(false)
const listLoadingMore = ref(false)
const listOffset = ref(0)
const pagedSessionIds = new Set<string>()


function handleOutlineNavigate(target: { messageId: string; anchorId: string }) {
  historyMessageListRef.value?.scrollToAnchor(target.messageId, target.anchorId)
  if (isMobile.value) showOutline.value = false
}

function openNewChatPage() {
  void router.push({ name: 'hermes.chat' })
}

async function loadHermesSessions() {
  const requestId = ++hermesSessionsRequestId
  hermesSessionsLoading.value = true
  try {
    const profile = effectiveHistoryProfile.value
    const includedIds = [...new Set([
      ...(routeSessionId.value ? [routeSessionId.value] : []),
      ...sessionBrowserPrefsStore.starredIds,
    ])]
    const page = await fetchHermesSessionPage('', 0, HISTORY_LIST_PAGE_SIZE, profile)
    if (requestId !== hermesSessionsRequestId) return
    const sessionsByKey = new Map<string, SessionSummary>()
    for (const session of page.sessions) {
      sessionsByKey.set(session.id, session)
    }
    // Fetch old stars and deep links without moving the global list cursor.
    const missingIds = includedIds.filter(id => !sessionsByKey.has(id))
    for (let offset = 0; offset < missingIds.length; offset += HISTORY_INCLUDE_LIMIT) {
      const supplement = await fetchHermesSessionGroups(1, profile, missingIds.slice(offset, offset + HISTORY_INCLUDE_LIMIT))
      if (requestId !== hermesSessionsRequestId) return
      for (const session of supplement.included) sessionsByKey.set(session.id, session)
    }
    hermesSessions.value = [...sessionsByKey.values()]
    pagedSessionIds.clear()
    for (const session of page.sessions) pagedSessionIds.add(session.id)
    listOffset.value = page.sessions.length
    listHasMore.value = page.hasMore
    listLoadingMore.value = false
    hermesSessionsLoaded.value = true
  } catch (err) {
    console.error('Failed to load Hermes sessions:', err)
  } finally {
    if (requestId === hermesSessionsRequestId) {
      hermesSessionsLoading.value = false
    }
  }
}

// Initialize synchronously from the media query so first paint is correct.
const showSessions = ref(
  typeof window === 'undefined' || !window.matchMedia('(max-width: 768px)').matches,
)
watch(
  showSessions,
  expanded => appStore.setPageSidebarExpanded(expanded),
  { immediate: true },
)
let mobileQuery: MediaQueryList | null = null
const isMobile = ref(false)

function findHistorySession(sessionId: string): SessionSummary | undefined {
  return hermesSessions.value.find(session => session.id === sessionId)
}

const contextSessionSummary = computed(() =>
  contextSessionId.value ? findHistorySession(contextSessionId.value) || null : null,
)


const contextMenuOptions = computed<DropdownOption[]>(() => {
  const options: DropdownOption[] = [
    {
      label: t('chat.importToWebUi'),
      key: 'import-webui',
      disabled: Boolean(contextSessionSummary.value?.webui_imported),
    },

    ...(contextSessionSummary.value?.is_archived ? [{ label: t('chat.unarchiveSession'), key: 'unarchive' }] : []),
    { label: t('chat.copySessionLink'), key: 'copy-link' },
    { label: t('chat.copySessionId'), key: 'copy-id' },
  ]
  return options
})

function isHistoryMoaToolDisplay(message: HermesMessage): boolean {
  return (message.role === 'moa' || message.display_role === 'tool')
    && (message.tool_name === 'moa_reference' || message.tool_name === 'moa_aggregating')
}

function parseHistoryMoaToolPayload(toolName: string | null, value: unknown): { preview?: string; result?: unknown } | null {
  if (toolName !== 'moa_reference' && toolName !== 'moa_aggregating') return null
  const payload = typeof value === 'string'
    ? (() => {
        try {
          return JSON.parse(value)
        } catch {
          return null
        }
      })()
    : value
  if (!payload || typeof payload !== 'object') return null
  const data = payload as Record<string, unknown>
  const preview = typeof data.preview === 'string'
    ? data.preview
    : typeof data.label === 'string'
      ? data.label
      : typeof data.aggregator === 'string'
        ? data.aggregator
        : undefined
  const result = data.text ?? data.result
  return { preview, result }
}

function mapHistoryMessages(messages: HermesMessage[]): Session['messages'] {
  return messages.map(m => {
    const displayRole = isHistoryMoaToolDisplay(m) ? 'tool' : (m.display_role || m.role)
    const msg: Session['messages'][number] = {
      id: String(m.id),
      role: displayRole === 'moa' ? 'system' : displayRole,
      content: m.content || '',
      timestamp: m.timestamp * 1000,
      reasoning: m.reasoning || undefined,
      systemType: displayRole === 'command' ? 'command' : undefined,
      runMarker: m.run_marker,
    }

    if (m.role === 'tool' || isHistoryMoaToolDisplay(m)) {
      const moaPayload = parseHistoryMoaToolPayload(m.tool_name, m.content)
      msg.toolName = m.tool_name || undefined
      msg.toolCallId = m.tool_call_id || undefined
      msg.toolArgs = m.tool_calls?.[0]?.function?.arguments
        ? JSON.stringify(m.tool_calls[0].function.arguments)
        : undefined
      msg.toolPreview = moaPayload?.preview
      msg.toolStatus = m.finish_reason === 'error' ? 'error' : 'done'
      msg.toolResult = moaPayload ? moaPayload.result : (m.content || undefined)
      msg.content = ''
    }

    return msg
  })
}

function codingAgentFields(summary: SessionSummary): Pick<Session, 'agent' | 'agentSessionId' | 'agentNativeSessionId' | 'codingAgentId' | 'codingAgentMode'> {
  const isCodingAgentSession = summary.source === 'coding_agent' || summary.agent === 'claude' || summary.agent === 'codex' || summary.agent === 'pi'
  return {
    agent: summary.agent || undefined,
    agentSessionId: summary.agent_session_id || undefined,
    agentNativeSessionId: summary.agent_native_session_id || undefined,
    codingAgentId: summary.agent === 'codex' ? 'codex' : summary.agent === 'pi' ? 'pi' : summary.agent === 'claude' ? 'claude-code' : undefined,
    codingAgentMode: isCodingAgentSession
      ? (summary.agent_mode === 'global' || summary.agent_mode === 'scoped'
          ? summary.agent_mode
          : summary.provider === 'global' ? 'global' : 'scoped')
      : undefined,
  }
}

function sessionFromSummary(summary: SessionSummary, messages: Session['messages'] = []): Session {
  return {
    id: summary.id,
    profile: summary.profile || undefined,
    title: summary.title || '',
    source: summary.source,
    ...codingAgentFields(summary),
    createdAt: summary.started_at * 1000,
    updatedAt: (summary.last_active || summary.ended_at || summary.started_at) * 1000,
    model: summary.model,
    provider: summary.provider,
    messageCount: summary.message_count,
    messageTotal: summary.message_count,
    loadedMessageCount: messages.length,
    hasMoreBefore: false,
    inputTokens: summary.input_tokens,
    outputTokens: summary.output_tokens,
    endedAt: summary.ended_at ? summary.ended_at * 1000 : undefined,
    lastActiveAt: summary.last_active ? summary.last_active * 1000 : undefined,
    isArchived: Boolean(summary.is_archived),
    pushEnabled: Boolean(summary.push_enabled),
    workspace: summary.workspace || undefined,
    messages,
  }
}

async function loadHistorySession(sessionId: string, profile?: string | null) {
  const requestId = ++historySessionRequestId
  const summary = findHistorySession(sessionId)
  const sessionProfile = profile || summary?.profile || null
  const page = await fetchSessionMessagesPage(sessionId, 0, HISTORY_PAGE_SIZE, sessionProfile)
  if (requestId !== historySessionRequestId) return
  let sessionData: Session | null = null

  if (page) {
    // A deep link may select another profile while the sidebar still has its old summary.
    const base = summary && (!sessionProfile || (summary.profile || 'default') === sessionProfile)
      ? summary : page.session
    sessionData = sessionFromSummary(base, mapHistoryMessages(page.messages))
    sessionData.profile = sessionProfile || base.profile || undefined
    sessionData.messageCount = page.total
    sessionData.messageTotal = page.total
    sessionData.loadedMessageCount = page.messages.length
    sessionData.hasMoreBefore = page.hasMore
  } else {
    // Some imported/legacy Hermes sessions may only exist in Hermes state.db.
    // Keep the old full-detail path as a compatibility fallback.
    const sessionDetail = await fetchHermesSession(sessionId, sessionProfile)
    if (requestId !== historySessionRequestId) return
    if (!sessionDetail) {
      message.error(t('chat.sessionNotFound'))
      return
    }

    sessionData = {
      id: sessionDetail.id,
      profile: sessionDetail.profile || sessionProfile || undefined,
      title: sessionDetail.title || '',
      source: sessionDetail.source,
      createdAt: sessionDetail.started_at * 1000,
      updatedAt: (sessionDetail.last_active || sessionDetail.started_at) * 1000,
      model: sessionDetail.model,
      provider: sessionDetail.provider,
      messageCount: sessionDetail.message_count,
      messageTotal: sessionDetail.message_count,
      loadedMessageCount: sessionDetail.messages.length,
      hasMoreBefore: false,
      inputTokens: sessionDetail.input_tokens,
      outputTokens: sessionDetail.output_tokens,
      endedAt: sessionDetail.ended_at ? sessionDetail.ended_at * 1000 : undefined,
      lastActiveAt: sessionDetail.last_active ? sessionDetail.last_active * 1000 : undefined,
      workspace: sessionDetail.workspace || undefined,
      messages: mapHistoryMessages(sessionDetail.messages),
    }
  }

  // Set history page's own session state (independent from chatStore)
  if (requestId !== historySessionRequestId) return
  historySessionId.value = sessionData.id
  historySession.value = sessionData

  if (mobileQuery?.matches) showSessions.value = false
}

async function loadOlderHistoryMessages(sessionId: string): Promise<boolean> {
  const target = historySession.value
  if (!target || target.id !== sessionId || target.isLoadingOlderMessages || !target.hasMoreBefore) return false
  const offset = target.loadedMessageCount || 0
  target.isLoadingOlderMessages = true
  try {
    const page = await fetchSessionMessagesPage(sessionId, offset, HISTORY_PAGE_SIZE, target.profile)
    if (target !== historySession.value || target.id !== sessionId) return false
    if (!page) return false // Request failure is retryable, not the end of history.
    if (page.messages.length === 0) {
      target.hasMoreBefore = page.hasMore
      return false
    }

    const existingIds = new Set(target.messages.map(message => message.id))
    const olderMessages = mapHistoryMessages(page.messages).filter(message => !existingIds.has(message.id))
    target.messages = [...olderMessages, ...target.messages]
    target.loadedMessageCount = offset + page.messages.length
    target.messageTotal = page.total
    target.messageCount = page.total
    target.hasMoreBefore = page.hasMore
    return true // The raw paging cursor advanced even if this page only contained duplicates.
  } catch (err) {
    console.error('Failed to load older history messages:', err)
    return false
  } finally {
    target.isLoadingOlderMessages = false
  }
}

async function handleSessionClick(sessionId: string, profile?: string | null) {
  await router.push({
    name: 'hermes.historySession',
    params: { sessionId },
    query: profile ? { profile } : undefined,
  })
}

async function openDefaultHistorySession(replace = false) {
  const firstSession = historySessions.value[0]
  if (!firstSession) {
    historySessionId.value = null
    historySession.value = null
    if (routeSessionId.value) await router.replace({ name: 'hermes.history' })
    return
  }

  const location = {
    name: 'hermes.historySession',
    params: { sessionId: firstSession.id },
    query: firstSession.profile ? { profile: firstSession.profile } : undefined,
  }
  if (replace) await router.replace(location)
  else await router.push(location)
}

async function syncRouteSession() {
  const sessionId = routeSessionId.value
  if (!sessionId) return

  const summary = findHistorySession(sessionId)
  if (!summary) {
    historySessionId.value = null
    historySession.value = null
    await router.replace({ name: 'hermes.history' })
    return
  }

  const sessionProfile = routeProfile.value || summary.profile || null
  const currentProfile = historySession.value?.profile || null
  if (historySessionId.value !== sessionId || currentProfile !== sessionProfile) {
    historySessionId.value = sessionId
    historySession.value = null
    await loadHistorySession(sessionId, sessionProfile)
  }
}

function handleMobileChange(e: MediaQueryListEvent | MediaQueryList) {
  isMobile.value = e.matches
  if (e.matches && showSessions.value) {
    showSessions.value = false
  }
}

function openPageSidebar() {
  showSessions.value = true
}

onMounted(async () => {
  appStore.loadModels()
  await profilesStore.fetchProfiles()
  await loadHermesSessions()
  await syncRouteSession()

  mobileQuery = window.matchMedia('(max-width: 768px)')
  handleMobileChange(mobileQuery)
  mobileQuery.addEventListener('change', handleMobileChange)
  window.addEventListener('hermes:open-page-sidebar', openPageSidebar)
})

onUnmounted(() => {
  historySessionRequestId += 1
  historySession.value = null
  mobileQuery?.removeEventListener('change', handleMobileChange)
  window.removeEventListener('hermes:open-page-sidebar', openPageSidebar)
})

watch(
  [routeSessionId, routeProfile],
  async ([sessionId]) => {
    if (!sessionId) {
      historySessionRequestId += 1
      historySessionId.value = null
      historySession.value = null
      return
    }
    if (!hermesSessionsLoaded.value) return
    if (routeProfile.value && !hermesSessions.value.some(s => s.profile === routeProfile.value)) {
      await loadHermesSessions()
    }
    await syncRouteSession()
  },
)

watch(() => profilesStore.activeProfileName, async () => {
  if (!hermesSessionsLoaded.value) return
  if (profilesStore.switching) return
  historySessionId.value = null
  historySession.value = null
  historySessionRequestId += 1
  await loadHermesSessions()
  await openDefaultHistorySession(true)
})

// Convert SessionSummary to Session format
function sessionSummaryToSession(summary: SessionSummary): Session {
  return {
    id: summary.id,
    profile: summary.profile || undefined,
    title: summary.title || '',
    source: summary.source,
    ...codingAgentFields(summary),
    createdAt: summary.started_at * 1000,
    updatedAt: (summary.last_active || summary.started_at) * 1000,
    model: summary.model,
    provider: summary.provider,
    messageCount: summary.message_count,
    inputTokens: summary.input_tokens,
    outputTokens: summary.output_tokens,
    endedAt: summary.ended_at ? summary.ended_at * 1000 : undefined,
    lastActiveAt: summary.last_active ? summary.last_active * 1000 : undefined,
    isArchived: Boolean(summary.is_archived),
    pushEnabled: Boolean(summary.push_enabled),
    workspace: summary.workspace || undefined,
    messages: [],
  }
}

// Computed sessions from Hermes API
const historySessions = computed<Session[]>(() =>
  hermesSessions.value.map(sessionSummaryToSession).sort((a, b) =>
    (b.updatedAt || 0) - (a.updatedAt || 0) || a.id.localeCompare(b.id),
  )
)


const visibleHistorySessions = computed(() =>
  historySessions.value.filter(session =>
    (session.profile || 'default') === (effectiveHistoryProfile.value || 'default')
    && (sessionTab.value === 'all' || sessionBrowserPrefsStore.isStarred(session.id)),
  ),
)

async function loadMoreSessions() {
  if (sessionTab.value !== 'all' || listLoadingMore.value || !listHasMore.value) return
  const requestId = hermesSessionsRequestId
  const offset = listOffset.value
  listLoadingMore.value = true
  try {
    const page = await fetchHermesSessionPage('', offset, HISTORY_LIST_PAGE_SIZE, effectiveHistoryProfile.value)
    if (requestId !== hermesSessionsRequestId) return
    const sessionsById = new Map(hermesSessions.value.map(session => [session.id, session]))
    for (const session of page.sessions) {
      sessionsById.set(session.id, session)
      pagedSessionIds.add(session.id)
    }
    hermesSessions.value = [...sessionsById.values()]
    listOffset.value = offset + page.sessions.length
    listHasMore.value = page.sessions.length > 0 && page.hasMore
  } catch (err) {
    console.error('Failed to load more history sessions:', err)
    message.error(t('chat.searchFailed'))
  } finally {
    if (requestId === hermesSessionsRequestId) listLoadingMore.value = false
  }
}

// Open the newest session only when no explicit route was requested.
watch(hermesSessionsLoaded, (loaded) => {
  if (loaded && hermesSessions.value.length > 0 && !routeSessionId.value) {
    void openDefaultHistorySession(false)
  }
}, { once: true })

const activeSessionTitle = computed(() =>
  historySession.value?.title || t('chat.newChat'),
)

const activeSessionSource = computed(() =>
  historySession.value?.source || '',
)

async function copySessionId(id?: string) {
  const sessionId = id || historySessionId.value
  if (sessionId) {
    const ok = await copyToClipboard(sessionId)
    if (ok) message.success(t('common.copied'))
    else message.error(t('common.copied') + ' ✗')
  }
}

function historySessionProfile(sessionId: string): string | null {
  return historySession.value?.id === sessionId
    ? historySession.value.profile || null
    : findHistorySession(sessionId)?.profile || null
}

function buildHistorySessionUrl(sessionId: string, profile?: string | null) {
  const href = router.resolve({
    name: 'hermes.historySession',
    params: { sessionId },
    query: profile ? { profile } : undefined,
  }).href
  return `${window.location.origin}${window.location.pathname}${href}`
}

async function copySessionLink(id?: string) {
  const sessionId = id || historySessionId.value
  if (sessionId) {
    const ok = await copyToClipboard(buildHistorySessionUrl(sessionId, historySessionProfile(sessionId)))
    if (ok) message.success(t('common.copied'))
    else message.error(t('common.copied') + ' ✗')
  }
}

function handleContextMenu(e: MouseEvent, sessionId: string) {
  e.preventDefault()
  contextSessionId.value = sessionId
  showContextMenu.value = true
  contextMenuX.value = e.clientX
  contextMenuY.value = e.clientY
}

function handleClickOutside() {
  showContextMenu.value = false
}

async function handleImportToWebUi(sessionId: string) {
  const summary = findHistorySession(sessionId)
  try {
    const result = await importHermesSession(sessionId, summary?.profile || null)
    if (result.ok) {
      message.success(t(result.imported ? 'chat.importSessionSuccess' : 'chat.importSessionAlreadyExists'))
      await loadHermesSessions()
      return
    }
  } catch {
    // Fall through to the shared failure message.
  }
  message.error(t('chat.importSessionFailed'))
}

async function handleContextMenuSelect(key: string) {
  showContextMenu.value = false
  if (!contextSessionId.value) return
  if (key === 'copy-link') {
    await copySessionLink(contextSessionId.value)
  } else if (key === 'copy-id') {
    await copySessionId(contextSessionId.value)
  } else if (key === 'import-webui') {
    await handleImportToWebUi(contextSessionId.value)
  } else if (key === 'unarchive') {
    const summary = contextSessionSummary.value
    if (!summary?.is_archived) return
    const ok = await unarchiveSession(contextSessionId.value)
    if (!ok) {
      message.error(t('chat.unarchiveSessionFailed'))
      return
    }
    message.success(t('chat.sessionUnarchived'))
    await loadHermesSessions()
    if (!findHistorySession(contextSessionId.value)) {
      historySessionId.value = null
      historySession.value = null
      await router.replace({ name: 'hermes.history' })
      await openDefaultHistorySession(true)
    }
  }
}

async function handleDeleteSession(id: string, profile?: string | null) {
  const summary = findHistorySession(id)
  const sessionProfile = profile || summary?.profile || null
  const ok = await deleteSession(id, sessionProfile)
  if (!ok) {
    message.error(t('common.deleteFailed'))
    return
  }

  sessionBrowserPrefsStore.removeStarred(id)
  hermesSessions.value = hermesSessions.value.filter(s => s.id !== id)
  if (pagedSessionIds.delete(id)) listOffset.value = Math.max(0, listOffset.value - 1)

  if (historySessionId.value === id) {
    historySessionId.value = null
    historySession.value = null
    const next = historySessions.value[0]
    if (next) await handleSessionClick(next.id, next.profile)
    else await router.replace({ name: 'hermes.history' })
  }

  message.success(t('chat.sessionDeleted'))
}


</script>

<template>
  <div class="history-panel">
    <div class="session-backdrop" :class="{ active: showSessions }" @click="showSessions = false" />
    <aside class="session-list" :class="{ collapsed: !showSessions }">
      <div v-if="showSessions" class="page-sidebar-top">
        <PageSidebarNav
          active="history"
          :primary-label="t('chat.newChat')"
          @primary="openNewChatPage"
        />
        <div class="session-list-toolbar">
          <SessionListTabs v-model="sessionTab" />
          <div class="session-list-actions">
            <button class="session-close-btn" @click="showSessions = false">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>
      </div>
      <div v-if="showSessions" class="session-items">
        <div v-if="hermesSessionsLoading && hermesSessions.length === 0" class="session-loading">{{ t('common.loading') }}</div>
        <div v-else-if="visibleHistorySessions.length === 0" class="session-empty">{{ sessionTab === 'starred' ? t('chat.noStarredSessions') : t('chat.noSessions') }}</div>

        <SessionListItem
          v-for="s in visibleHistorySessions"
          :key="s.id"
          :session="s"
          :active="s.id === historySessionId"
          :starred="sessionBrowserPrefsStore.isStarred(s.id)"
          :can-delete="true"
          :streaming="false"
          @select="handleSessionClick(s.id, s.profile)"
          @contextmenu="handleContextMenu($event, s.id)"
          @delete="handleDeleteSession(s.id, s.profile)"
          @toggle-star="sessionBrowserPrefsStore.toggleStarred(s.id)"
        />
        <NButton
          v-if="sessionTab === 'all' && listHasMore"
          class="session-list-load-more"
          quaternary
          block
          size="small"
          :loading="listLoadingMore"
          :disabled="listLoadingMore"
          @click="loadMoreSessions"
        >{{ t('chat.loadMoreSessions') }}</NButton>
      </div>
      <PageSidebarFooter v-if="showSessions" />
    </aside>

    <NDropdown
      placement="bottom-start"
      trigger="manual"
      :x="contextMenuX"
      :y="contextMenuY"
      :options="contextMenuOptions"
      :show="showContextMenu"
      @select="handleContextMenuSelect"
      @clickoutside="handleClickOutside"
    />

    <div
      class="chat-main"
      :class="{ 'chat-main--sidebar-collapsed': !showSessions }"
    >
      <header class="chat-header">
        <div class="header-left">
          <NButton class="history-sidebar-toggle" quaternary size="small" @click="showSessions = !showSessions" circle>
            <template #icon>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
            </template>
          </NButton>
          <span class="header-session-title">{{ activeSessionTitle }}</span>
          <!-- hermes-v050:U8 source name via i18n; folder icon copied from ChatPanel.vue header workspace badge -->
          <span v-if="activeSessionSource" class="source-badge">{{ getSourceLabel(activeSessionSource, t) }}</span>
          <span v-if="historySession?.workspace" class="workspace-badge" :title="historySession.workspace">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            <span>{{ historySession.workspace.split('/').pop() || historySession.workspace }}</span>
          </span>
        </div>
        <div class="header-actions">
          <NTooltip trigger="hover">
            <template #trigger>
              <NButton quaternary size="small" @click="showOutline = !showOutline" circle>
                <template #icon>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
                </template>
              </NButton>
            </template>
            {{ t('chat.outlineTitle') }}
          </NTooltip>
          <NTooltip trigger="hover">
            <template #trigger>
              <NButton quaternary size="small" @click="copySessionId()" circle>
                <template #icon>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </template>
              </NButton>
            </template>
            {{ t('chat.copySessionId') }}
          </NTooltip>
        </div>
      </header>

      <div class="history-content-wrapper">
        <div class="history-main-content">
          <HistoryMessageList
            :key="historySession?.id || 'history-empty'"
            ref="historyMessageListRef"
            :session="historySession"
            :load-older="loadOlderHistoryMessages"
            scroll-scope="history"
          />
        </div>
        <OutlinePanel
          v-if="showOutline && historySession"
          :messages="historySession.messages || []"
          @navigate="handleOutlineNavigate"
        />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.history-panel {
  display: flex;
  height: 100%;
  position: relative;
  overflow: hidden;
  background: $bg-card;
}

.history-content-wrapper {
  flex: 1;
  display: flex;
  overflow: hidden;
  position: relative;
}

.history-main-content {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.session-list {
  width: $sidebar-width;
  min-height: 0;
  align-self: stretch;
  margin: 10px;
  background: $bg-sidebar-surface;
  border: 1px solid $border-color;
  border-radius: 14px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  transition: width $transition-normal, opacity $transition-normal;
  overflow: hidden;

  &.collapsed {
    width: 0;
    margin-inline-start: 0;
    margin-inline-end: 0;
    border: none;
    box-shadow: none;
    opacity: 0;
    pointer-events: none;
  }

  @media (max-width: $breakpoint-mobile) {
    position: absolute;
    left: 10px;
    top: 10px;
    bottom: 10px;
    height: auto;
    margin: 0;
    z-index: 120;
    width: $sidebar-width;

    &.collapsed {
      transform: translateX(calc(-100% - 10px));
      opacity: 0;
    }
  }
}

@media (max-width: $breakpoint-mobile) {
  .session-list .session-close-btn {
    display: flex;
  }

  .session-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 110;
    opacity: 0;
    pointer-events: none;
    transition: opacity $transition-fast;

    &.active {
      opacity: 1;
      pointer-events: auto;
    }
  }
}

.page-sidebar-top {
  flex-shrink: 0;
  padding: 12px 12px 0;
  border-bottom: 1px solid $border-color;
}

.session-list-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 12px;
  // Align the tab bottoms with the header divider, without a second line.
  margin-bottom: -1px;
}

.session-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  flex-shrink: 0;
}

.session-list-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.session-close-btn {
  display: none;
  border: none;
  background: none;
  cursor: pointer;
  color: $text-secondary;
  padding: 4px;
  border-radius: $radius-sm;

  &:hover {
    background: rgba($accent-primary, 0.06);
  }
}

.session-list-load-more { margin-top: 8px; }

.session-items {
  flex: 1;
  overflow-y: auto;
  /* hermes-v050:U12 same as ChatPanel.vue .session-items */
  padding: 10px 6px 12px;
}

.session-loading,
.session-empty {
  padding: 16px 10px;
  font-size: 12px;
  color: $text-muted;
  text-align: center;
}

.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
  margin: 10px 10px 10px 0;
  background: $bg-main-surface;
  border: 1px solid $border-color;
  border-radius: 14px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);

  &--sidebar-collapsed {
    margin-inline-start: 10px;
  }
}

.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 21px 20px;
  border-bottom: 1px solid $border-color;
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
  flex: 1;
  min-width: 0;
}

.header-left :deep(.n-button) {
  flex: 0 0 auto;
}

.header-session-title {
  font-size: 16px;
  font-weight: 600;
  color: $text-primary;
  line-height: 28px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.source-badge {
  display: inline-flex;
  align-items: center;
  font-size: 10px;
  color: $text-muted;
  /* hermes-v050:E-08 same valid 12% muted tint as .workspace-badge (U9); the Sass rgba() of $text-muted compiled to an invalid value */
  background: rgba(var(--text-muted-rgb), 0.12);
  padding: 1px 7px;
  border-radius: 8px;
  flex-shrink: 0;
  white-space: nowrap;
  height: 18px;
  line-height: 16px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

@media (max-width: $breakpoint-mobile) {
  .chat-main {
    margin: 0;
    border: none;
    border-radius: 0;
    box-shadow: none;
  }

  .chat-header {
    padding: 16px 12px 16px 52px;
  }

  .history-sidebar-toggle {
    display: none;
  }

  /* hermes-v050:U13 mobile header keeps title + workspace badge (as ChatPanel.vue mobile header) */
  .source-badge {
    display: none;
  }

  .workspace-badge {
    flex-shrink: 0;
  }
}

.workspace-badge {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  color: $text-muted;
  /* hermes-v050:U9 12% muted tint of .source-badge; rgb-var form as .context-bar so it is valid CSS */
  background: rgba(var(--text-muted-rgb), 0.12);
  padding: 2px 8px;
  border-radius: 4px;
  height: 20px;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: default;
  /* hermes-v050:U8 icon + text layout copied from ChatPanel.vue .workspace-badge */
  gap: 4px;

  svg {
    flex: 0 0 auto;
  }

  span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>
