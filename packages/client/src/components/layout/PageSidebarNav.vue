<script setup lang="ts">
import { computed } from 'vue'
import { NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { isStoredSuperAdmin } from '@/api/client'
import { useSessionSearch } from '@/composables/useSessionSearch'
import QuickPhraseBadge from '@/components/layout/QuickPhraseBadge.vue'

// community-restored-main-nav-section-types
type ActiveSection = 'chat' | 'history' | 'connections' | 'skills' | 'memory' | 'agents' | 'models' | 'global'

const props = defineProps<{
  active: ActiveSection
  primaryLabel?: string
}>()

const emit = defineEmits<{
  primary: []
}>()

const { t } = useI18n()
const router = useRouter()
const { openSessionSearch } = useSessionSearch()
const canManageAgents = computed(() => isStoredSuperAdmin())

const primaryText = computed(() => props.primaryLabel || t('chat.newChat'))

function openChat() {
  if (props.active === 'chat') return
  void router.push({ name: 'hermes.chat' })
}

function openHistory() {
  if (props.active === 'history') return
  void router.push({ name: 'hermes.history' })
}

// community-restored-main-nav-route-functions
function openSkills() {
  if (props.active === 'skills') return
  void router.push({ name: 'hermes.mainSkills' })
}

function openMemory() {
  if (props.active === 'memory') return
  void router.push({ name: 'hermes.mainMemory' })
}

function openAgentManager() {
  if (props.active === 'agents') return
  void router.push({ name: 'hermes.agentManager' })
}

function openModels() {
  if (props.active === 'models') return
  void router.push({ name: 'hermes.models' })
}


// community-restored-main-nav-no-api-relay
</script>

<template>
  <div class="page-sidebar-nav">
    <!-- hermes-v050:U16-T30 -->
    <div class="page-sidebar-tabs" role="tablist" :aria-label="t('sidebar.a11y.chatActions')">
      <button
        class="page-sidebar-tab"
        type="button"
        @click="emit('primary')"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <span>{{ primaryText }}</span>
      </button>
      <!-- community-restored-main-nav-skills -->
      <button
        class="page-sidebar-tab"
        :class="{ active: active === 'skills' }"
        type="button"
        :aria-current="active === 'skills' ? 'page' : undefined"
        @click="openSkills"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="m12 2 9 5-9 5-9-5 9-5Z" />
          <path d="m3 12 9 5 9-5M3 17l9 5 9-5" />
        </svg>
        <span>{{ t('sidebar.skills') }}</span>
      </button>
      <button
        v-if="canManageAgents"
        class="page-sidebar-tab"
        :class="{ active: active === 'agents' }"
        type="button"
        :aria-current="active === 'agents' ? 'page' : undefined"
        @click="openAgentManager"
      >
        <!-- hermes-v050:U14 15px like the other nav icons -->
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M12 8V4H8" />
          <rect x="4" y="8" width="16" height="12" rx="3" />
          <path d="M2 14h2M20 14h2M9 13v2M15 13v2" />
        </svg>
        <span>{{ t('sidebar.agentManager') }}</span>
      </button>
      <button
        class="page-sidebar-tab"
        :class="{ active: active === 'models' }"
        type="button"
        :aria-current="active === 'models' ? 'page' : undefined"
        @click="openModels"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
        </svg>
        <span>{{ t('sidebar.models') }}</span>
      </button>
      <!-- community-restored-main-nav-memory -->
      <button
        class="page-sidebar-tab"
        :class="{ active: active === 'memory' }"
        type="button"
        :aria-current="active === 'memory' ? 'page' : undefined"
        @click="openMemory"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2Z" />
        </svg>
        <span>{{ t('sidebar.memory') }}</span>
      </button>
    </div>
    <div class="conversation-switch conversation-switch--four" role="tablist" :aria-label="t('sidebar.a11y.conversationType')">
      <NTooltip trigger="hover" placement="top">
        <template #trigger>
          <button
            class="conversation-switch-tab"
            :class="{ active: active === 'chat' }"
            type="button"
            role="tab"
            :aria-label="t('sidebar.singleChat')"
            :aria-selected="active === 'chat'"
            @click="openChat"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </button>
        </template>
        {{ t('sidebar.singleChat') }}
      </NTooltip>
      <!-- hermes-v0.1.2: 四联 = 对话 / 历史 / 搜索 / 短语（群聊、工作流已整体移除） -->
      <NTooltip trigger="hover" placement="top">
        <template #trigger>
          <button
            class="conversation-switch-tab"
            :class="{ active: active === 'history' }"
            type="button"
            role="tab"
            :aria-label="t('sidebar.history')"
            :aria-selected="active === 'history'"
            @click="openHistory"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          </button>
        </template>
        {{ t('sidebar.history') }}
      </NTooltip>
      <NTooltip trigger="hover" placement="top">
        <template #trigger>
          <button
            class="conversation-switch-tab"
            type="button"
            role="tab"
            data-testid="nav-search"
            :aria-label="t('sidebar.search')"
            aria-selected="false"
            @click="openSessionSearch"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </button>
        </template>
        {{ t('sidebar.search') }}
      </NTooltip>
      <QuickPhraseBadge>
        <template #trigger="{ open }">
          <NTooltip trigger="hover" placement="top">
            <template #trigger>
              <button
                class="conversation-switch-tab"
                type="button"
                role="tab"
                data-testid="nav-quick-phrases"
                :aria-label="t('quickPhrases.title')"
                aria-selected="false"
                @click="open"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M6 4h12v16l-6-3-6 3V4Z" />
                  <path d="M9 8h6M9 12h4" />
                </svg>
              </button>
            </template>
            {{ t('quickPhrases.title') }}
          </NTooltip>
        </template>
      </QuickPhraseBadge>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.page-sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.page-sidebar-tabs {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.page-sidebar-tab {
  width: 100%;
  min-width: 0;
  height: 34px;
  border: none;
  border-radius: $radius-sm;
  background: transparent;
  color: $text-secondary;
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  padding: 7px 10px;
  cursor: pointer;
  transition:
    background-color $transition-fast,
    color $transition-fast;

  svg {
    flex-shrink: 0;
  }

  span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    line-height: 18px;
  }

  &:hover,
  &.active {
    background: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;
  }
}

.conversation-switch {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px;
  padding: 2px;
  border-radius: $radius-sm;
  background: rgba(var(--accent-primary-rgb), 0.05);
}

.conversation-switch--four {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.conversation-switch-tab {
  width: 100%;
  min-width: 0;
  height: 30px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: $text-secondary;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition:
    background-color $transition-fast,
    color $transition-fast;

  svg {
    flex: 0 0 auto;
  }

  &:hover {
    color: $text-primary;
  }

  &.active {
    background: $bg-card;
    color: $text-primary;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
  }
}

:global(.dark .conversation-switch--four .conversation-switch-tab.active) {
  background: $bg-card-hover;
  color: $accent-primary;
  box-shadow:
    inset 0 0 0 1px $border-color,
    0 2px 5px rgba(0, 0, 0, 0.22);
}
</style>
