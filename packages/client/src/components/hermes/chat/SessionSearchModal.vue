<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NInput, NModal, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchSessionContext, fetchSessions, searchSessions, type SessionContextMessage, type SessionSearchResult, type SessionSummary } from '@/api/studio/sessions'
import { useChatStore } from '@/stores/hermes/chat'
import { useSessionSearch } from '@/composables/useSessionSearch'
import { getSourceLabel } from '@/shared/session-display'
import type { Session } from '@/stores/hermes/chat'
import MessageItem from './MessageItem.vue'
import type { Message } from '@/stores/hermes/chat'

const { t } = useI18n()
const message = useMessage()
const router = useRouter()
const chatStore = useChatStore()
const { sessionSearchOpen } = useSessionSearch()

const query = ref('')
const loading = ref(false)
const recentSessions = ref<SessionSummary[]>([])
const searchResults = ref<SessionSearchResult[]>([])
const activeIndex = ref(0)
const selectedItem = ref<SearchItem | null>(null)
const previewMessages = ref<Message[]>([])
const previewLoading = ref(false)
const previewError = ref(false)
const inputRef = ref<InstanceType<typeof NInput> | null>(null)
const profileFilter = computed(() => chatStore.sessionProfileFilter || undefined)
const runtimeSource = computed(() => chatStore.runtimeMode === 'global_agent' ? 'global_agent' : undefined)

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let requestSeq = 0
// hermes-v050:S9: the in-flight search request, aborted once it is superseded.
let searchAbort: AbortController | null = null

function abortPendingSearch() {
  searchAbort?.abort()
  searchAbort = null
}

type SearchItem = SessionSearchResult | (SessionSummary & {
  snippet?: string
  matched_message_id: number | null
  rank: number
})

const hasQuery = computed(() => query.value.trim().length > 0)

const items = computed<SearchItem[]>(() => {
  if (hasQuery.value) return searchResults.value
  return recentSessions.value.map(session => ({
    ...session,
    matched_message_id: null,
    snippet: session.preview || '',
    rank: 0,
  }))
})

// hermes-v050:U6 one shared source-label table (same as HistoryView), not a local copy.
function formatSource(source: string): string {
  return getSourceLabel(source, t)
}

function formatTime(ts?: number): string {
  if (!ts) return ''
  const date = new Date(ts * 1000)
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function getItemTitle(item: SearchItem): string {
  const title = item.title?.trim()
  if (title) return title
  if (item.preview?.trim()) return item.preview.trim()
  return item.id
}

async function loadRecentSessions() {
  const seq = ++requestSeq
  abortPendingSearch()
  loading.value = true
  try {
    const sessions = profileFilter.value
      ? await fetchSessions(runtimeSource.value, 8, profileFilter.value)
      : await fetchSessions(runtimeSource.value, 8)
    if (seq !== requestSeq) return
    recentSessions.value = sessions
    searchResults.value = []
    activeIndex.value = 0
  } catch (err) {
    if (seq !== requestSeq) return
    message.error(err instanceof Error ? err.message : t('chat.searchFailed'))
  } finally {
    if (seq === requestSeq) {
      loading.value = false
    }
  }
}

async function runSearch(text: string) {
  const seq = ++requestSeq
  abortPendingSearch()
  const abort = text.trim() ? new AbortController() : null
  searchAbort = abort
  loading.value = true
  try {
    // hermes-v050:E-02 no limit: every match comes back, as in v0.4.6 (the S3 cap of 50
    // hid coding-agent sessions; since S9 the scan runs off the main thread).
    const results = abort
      ? await searchSessions(text.trim(), runtimeSource.value, undefined, profileFilter.value, { signal: abort.signal })
      : []
    if (seq !== requestSeq) return
    searchResults.value = results
    activeIndex.value = 0
  } catch (err) {
    if (seq !== requestSeq || abort?.signal.aborted) return
    message.error(err instanceof Error ? err.message : t('chat.searchFailed'))
  } finally {
    if (seq === requestSeq) {
      loading.value = false
    }
    if (searchAbort === abort) searchAbort = null
  }
}

async function ensureChatSessionsLoaded() {
  if (chatStore.sessions.length === 0) {
    await chatStore.loadSessions(chatStore.sessionProfileFilter)
  }
}

async function previewItem(item: SearchItem) {
  selectedItem.value = item
  previewMessages.value = []
  previewError.value = false
  previewLoading.value = true
  const context = await fetchSessionContext(item.id, item.profile)
  if (selectedItem.value?.id !== item.id) return
  previewLoading.value = false
  if (!context) {
    previewError.value = true
    return
  }
  previewMessages.value = context.messages.map(mapContextMessage)
}

function mapContextMessage(message: SessionContextMessage): Message {
  return {
    id: String(message.id),
    role: message.role,
    content: message.content,
    timestamp: message.timestamp * 1000,
    reasoning: message.reasoning || message.reasoning_content || undefined,
  }
}

function closePreview() {
  selectedItem.value = null
  previewMessages.value = []
  previewLoading.value = false
  previewError.value = false
}

async function enterItem(item: SearchItem) {
  const messageId = item.matched_message_id != null ? String(item.matched_message_id) : null
  selectedItem.value = null
  sessionSearchOpen.value = false

  await ensureChatSessionsLoaded()
  if (!chatStore.sessions.some(session => session.id === item.id) && typeof chatStore.addOrUpdateSession === 'function') {
    const isCodingAgentSession = item.source === 'coding_agent' || item.agent === 'claude' || item.agent === 'codex' || item.agent === 'pi'
    const codingAgentId: Session['codingAgentId'] = item.agent === 'codex'
      ? 'codex'
      : item.agent === 'pi'
        ? 'pi'
      : item.agent === 'claude'
          ? 'claude-code'
          : undefined
    chatStore.addOrUpdateSession({
      id: item.id,
      profile: item.profile || 'default',
      title: item.title || '',
      source: item.source,
      messages: [],
      createdAt: Math.round(item.started_at * 1000),
      updatedAt: Math.round((item.last_active || item.ended_at || item.started_at) * 1000),
      model: item.model,
      provider: item.provider || item.billing_provider || '',
      messageCount: item.message_count,
      endedAt: item.ended_at != null ? Math.round(item.ended_at * 1000) : null,
      lastActiveAt: item.last_active != null ? Math.round(item.last_active * 1000) : undefined,
      workspace: item.workspace || null,
      agent: item.agent || undefined,
      agentSessionId: item.agent_session_id || undefined,
      agentNativeSessionId: item.agent_native_session_id || undefined,
      codingAgentId,
      codingAgentMode: isCodingAgentSession
        ? (item.agent_mode === 'global' || item.agent_mode === 'scoped'
            ? item.agent_mode
            : item.provider === 'global' ? 'global' : 'scoped')
        : undefined,
    })
  }
  await chatStore.switchSession(item.id, messageId)
  const routeName = chatStore.runtimeMode === 'global_agent' ? 'hermes.globalAgentSession' : 'hermes.session'
  if (router.currentRoute.value.name !== routeName || router.currentRoute.value.params.sessionId !== item.id) {
    await router.push({ name: routeName, params: { sessionId: item.id } })
  }
}

function closeModal() {
  sessionSearchOpen.value = false
}

function moveSelection(delta: number) {
  const list = items.value
  if (list.length === 0) return
  const next = activeIndex.value + delta
  activeIndex.value = (next + list.length) % list.length
}

async function handleKeydown(e: KeyboardEvent) {
  if (!sessionSearchOpen.value) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    moveSelection(1)
    return
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    moveSelection(-1)
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    if (selectedItem.value) {
      await enterItem(selectedItem.value)
    } else {
      const item = items.value[activeIndex.value]
      if (item) {
        previewItem(item)
      }
    }
    return
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    if (selectedItem.value) {
      closePreview()
    } else {
      closeModal()
    }
  }
}

watch(
  () => sessionSearchOpen.value,
  async (open) => {
    if (!open) {
      abortPendingSearch()
      query.value = ''
      searchResults.value = []
      recentSessions.value = []
      activeIndex.value = 0
      selectedItem.value = null
      previewMessages.value = []
      previewLoading.value = false
      previewError.value = false
      return
    }

    query.value = ''
    searchResults.value = []
    activeIndex.value = 0
    selectedItem.value = null
    previewMessages.value = []
    previewLoading.value = false
    previewError.value = false
    await loadRecentSessions()
    await nextTick()
    inputRef.value?.focus?.()
  },
  { immediate: true },
)

watch(query, (value) => {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  debounceTimer = setTimeout(() => {
    if (!sessionSearchOpen.value) return
    void runSearch(value)
  }, 160)
})

watch(items, () => {
  if (activeIndex.value >= items.value.length) {
    activeIndex.value = 0
  }
})

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  if (debounceTimer) {
    clearTimeout(debounceTimer)
  }
  abortPendingSearch()
})
</script>

<template>
  <NModal
    v-model:show="sessionSearchOpen"
    preset="card"
    :title="selectedItem ? t('chat.searchPreviewTitle') : t('chat.searchTitle')"
    :style="{ width: 'min(760px, calc(100vw - 24px))' }"
    :mask-closable="true"
    :auto-focus="false"
  >
    <div class="session-search-modal">
      <template v-if="selectedItem">
        <div class="preview-header">
          <div class="search-title" dir="auto">{{ getItemTitle(selectedItem) }}</div>
          <div class="search-hint">{{ formatSource(selectedItem.source) }}</div>
        </div>
        <div class="preview-content">
          <div class="preview-field">
            <span class="preview-label">{{ t('chat.searchPreviewTime') }}</span>
            <span>{{ formatTime(selectedItem.last_active || selectedItem.started_at) }}</span>
          </div>
          <div class="preview-field">
            <span class="preview-label">{{ t('chat.searchPreviewMessages') }}</span>
            <span>{{ selectedItem.message_count }}</span>
          </div>
          <div v-if="selectedItem.matched_message_id != null" class="preview-field">
            <span class="preview-label">{{ t('chat.searchPreviewMatch') }}</span>
            <span class="result-match">#{{ selectedItem.matched_message_id }}</span>
          </div>
          <div v-if="previewLoading" class="preview-state">
            <NSpin size="small" />
            <span>{{ t('common.loading') }}</span>
          </div>
          <div v-else-if="previewError" class="preview-state preview-error">
            {{ t('chat.searchFailed') }}
          </div>
          <div v-else-if="previewMessages.length > 0" class="preview-conversation">
            <MessageItem
              v-for="message in previewMessages"
              :key="message.id"
              :message="message"
            />
          </div>
          <div v-else class="preview-state">
            {{ t('chat.searchNoSnippet') }}
          </div>
        </div>
        <div class="preview-actions">
          <NButton quaternary class="preview-close" @click="closePreview">{{ t('chat.searchPreviewClose') }}</NButton>
          <NButton type="primary" class="preview-enter" @click="enterItem(selectedItem)">
            {{ t('chat.searchPreviewEnter') }}
          </NButton>
        </div>
      </template>
      <template v-else>
        <div class="search-header">
          <div class="search-title">{{ t('chat.searchSubtitle') }}</div>
          <div class="search-hint">{{ t('chat.searchHint') }}</div>
        </div>
        <div class="search-scope">{{ t('chat.searchScope') }}</div>

        <NInput
          ref="inputRef"
          v-model:value="query"
          :placeholder="t('chat.searchPlaceholder')"
          clearable
          size="large"
        />

        <div class="search-body">
          <NSpin :show="loading">
            <div v-if="items.length === 0" class="search-empty">
              {{ hasQuery ? t('chat.searchNoResults') : t('chat.searchEmpty') }}
            </div>
            <div v-else class="result-list">
              <button
                v-for="(item, idx) in items"
                :key="item.id"
                class="result-item"
                :class="{ active: idx === activeIndex }"
                @click="previewItem(item)"
                @mouseenter="activeIndex = idx"
              >
                <div class="result-main">
                  <div class="result-title-row">
                    <span class="result-title" dir="auto">{{ getItemTitle(item) }}</span>
                    <span class="result-source">{{ formatSource(item.source) }}</span>
                  </div>
                  <div class="result-snippet" dir="auto">
                    {{ hasQuery ? item.snippet || t('chat.searchNoSnippet') : item.preview || t('chat.searchRecent') }}
                  </div>
                </div>
                <div class="result-meta">
                  <span class="result-time">{{ formatTime(item.last_active || item.started_at) }}</span>
                  <span v-if="hasQuery && item.matched_message_id != null" class="result-match">
                    #{{ item.matched_message_id }}
                  </span>
                </div>
              </button>
            </div>
          </NSpin>
        </div>

        <div class="search-footer">
          <span>{{ t('chat.searchEnterHint') }}</span>
          <NButton quaternary size="small" @click="closeModal">{{ t('common.cancel') }}</NButton>
        </div>
      </template>
    </div>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.session-search-modal {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.preview-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.preview-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.preview-field {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  font-size: 13px;
  color: $text-secondary;
}

.preview-label {
  color: $text-muted;
}

.preview-snippet {
  padding: 12px 14px;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  color: $text-secondary;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.preview-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 120px;
  padding: 20px;
  color: $text-muted;
  font-size: 13px;
}

.preview-error {
  color: $error;
}

.preview-conversation {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: min(52vh, 480px);
  overflow-y: auto;
  padding: 10px 10px 8px 10px;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  background: rgba(var(--bg-main-surface-rgb), 0.35);

  :deep(.message) {
    max-width: 100%;
  }

  :deep(.message.user .msg-body),
  :deep(.message.assistant .msg-body) {
    max-width: 90%;
  }

  :deep(.message-bubble) {
    padding: 7px 10px;
    font-size: 13px;
    line-height: 1.5;
  }

  :deep(.message-author) {
    margin-bottom: 3px;
    font-size: 11px;
  }

  :deep(.message-meta) {
    display: none;
  }
}

.preview-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.search-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.search-title {
  font-size: 14px;
  font-weight: 600;
  color: $text-primary;
}

.search-hint {
  font-size: 12px;
  color: $text-muted;
}

.search-scope {
  font-size: 12px;
  color: $text-muted;
  line-height: 1.5;
}

.search-body {
  max-height: min(60vh, 540px);
  overflow: hidden;
}

.search-empty {
  padding: 28px 0;
  text-align: center;
  color: $text-muted;
  font-size: 13px;
}

.result-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: min(60vh, 540px);
  overflow-y: auto;
  padding-inline-end: 2px;
}

.result-item {
  width: 100%;
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 14px;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  background: $bg-card;
  color: $text-primary;
  text-align: start;
  cursor: pointer;
  transition: border-color $transition-fast, background-color $transition-fast, transform $transition-fast;

  &:hover,
  &.active {
    border-color: $accent-muted;
    background: rgba(var(--accent-primary-rgb), 0.04);
  }
}

.result-main {
  flex: 1;
  min-width: 0;
}

.result-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.result-title {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.result-source {
  flex-shrink: 0;
  font-size: 11px;
  color: $text-muted;
}

.result-snippet {
  margin-top: 4px;
  font-size: 12px;
  color: $text-secondary;
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.result-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  font-size: 11px;
  color: $text-muted;
  flex-shrink: 0;
}

.result-match {
  font-family: $font-code;
}

.search-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: $text-muted;
}

@media (max-width: $breakpoint-mobile) {
  :deep(.n-modal-body-wrapper) {
    width: calc(100vw - 24px);
  }

  .search-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .result-item {
    flex-direction: column;
    align-items: flex-start;
  }

  .result-meta {
    align-items: flex-start;
    flex-direction: row;
    flex-wrap: wrap;
  }
}
</style>
