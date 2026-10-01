<script setup lang="ts">
import { computed, defineComponent, nextTick, ref, onUnmounted } from 'vue'
import { NPopconfirm, NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { Session } from '@/stores/hermes/chat'
import { useAppStore } from '@/stores/hermes/app'
import { formatSessionListTimestamp } from '@/shared/session-display'
import { chatSessionAgentAvatar } from '@/utils/chat-agent-avatar'
import { resolveSessionNavigation } from './session-list-item-navigation'

const props = withDefaults(defineProps<{
  session: Session
  active: boolean
  starred?: boolean
  canDelete: boolean
  streaming?: boolean
  completedUnread?: boolean
  to?: string
  interceptModifiedNavigation?: boolean
}>(), {
  starred: false,
})

const emit = defineEmits<{
  select: []
  contextmenu: [event: MouseEvent]
  delete: []
  'toggle-star': []
  'open-new': []
}>()

const { t } = useI18n()
const appStore = useAppStore()
const profileName = computed(() => props.session.profile || 'default')
const profileHasModels = computed(() => {
  const profileModels = appStore.profileModelGroups.find(profile => profile.profile === profileName.value)
  return !!profileModels?.groups?.some(group => group.models.length > 0)
})
const profileModelsMissing = computed(() =>
  appStore.profileModelGroups.length > 0 && !profileHasModels.value,
)
const isGlobalAgentSession = computed(() => props.session.source === 'global_agent')
const sessionAgentLogo = computed(() => chatSessionAgentAvatar(props.session))

let longPressTimer: ReturnType<typeof setTimeout> | null = null
const longPressTriggered = ref(false)

function onTouchStart(e: TouchEvent) {
  longPressTriggered.value = false
  longPressTimer = setTimeout(() => {
    longPressTriggered.value = true
    const touch = e.touches[0]
    const syntheticEvent = new MouseEvent('contextmenu', {
      clientX: touch.clientX,
      clientY: touch.clientY,
      bubbles: true,
    })
    emit('contextmenu', syntheticEvent)
  }, 500)
}

function onTouchEnd() {
  if (longPressTimer) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
}

function onTouchMove() {
  if (longPressTimer) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
}

function onClick(event?: MouseEvent) {
  if (longPressTriggered.value) {
    longPressTriggered.value = false
    event?.preventDefault()
    return
  }
  if (clickLandsOnHiddenDeleteButton(event)) {
    event?.preventDefault()
    openDeleteConfirm()
    return
  }
  const navigationAction = resolveSessionNavigation(event, !!props.interceptModifiedNavigation)
  if (navigationAction === 'native') return
  if (navigationAction === 'open-new') {
    event?.preventDefault()
    emit('open-new')
    return
  }
  if (props.to) event?.preventDefault()
  emit('select')
}

onUnmounted(() => {
  if (longPressTimer) clearTimeout(longPressTimer)
})

// hermes-v050:C1 星标提示和删除确认按需挂载：鼠标进入本行或键盘聚焦本行前只渲染触发按钮本身，
// 挂载后仍是原来的 NTooltip / NPopconfirm（props、插槽、文案不变）。触屏不走悬停预挂载，
// 直接点删除时用 default-show 打开同一个 NPopconfirm。
const PopoverTriggerShell = defineComponent({
  name: 'PopoverTriggerShell',
  inheritAttrs: false,
  props: { defaultShow: Boolean },
  emits: ['positive-click'],
  setup(_props, { slots }) {
    return () => slots.trigger?.()
  },
})
const popoversArmed = ref(false)
const deleteConfirmOpenOnArm = ref(false)
const deleteConfirmRef = ref<{ setShow?: (show: boolean) => void } | null>(null)
let lastPointerType = ''

function armPopovers(focusTarget?: HTMLElement | null) {
  if (popoversArmed.value) return
  const refocusClass = focusTarget?.classList.contains('session-item-star')
    ? 'session-item-star'
    : focusTarget?.classList.contains('session-item-delete')
      ? 'session-item-delete'
      : ''
  const root = focusTarget?.closest('.session-item') as HTMLElement | null
  popoversArmed.value = true
  if (!refocusClass || !root) return
  void nextTick(() => {
    root.querySelector<HTMLElement>(`.${refocusClass}`)?.focus()
  })
}

function onRowPointerdown(event: PointerEvent) {
  lastPointerType = event.pointerType || ''
}

function onRowPointerenter(event: PointerEvent) {
  const pointerType = event.pointerType || 'mouse'
  if (pointerType === 'touch') return
  armPopovers()
}

function onRowFocusin(event: FocusEvent) {
  if (lastPointerType === 'touch') return
  armPopovers(event.target instanceof HTMLElement ? event.target : null)
}

// hermes-v050:Q-1 删除按钮只在行 :hover / :focus-within 时开放 pointer-events。侧栏刚滚到光标下的行
// （虚拟列表新挂载的行，或 v0.4.6 里滚过来的行）在浏览器补发悬停之前被按下时，命中测试穿过删除按钮落在
// 行本身，真 Chrome 里点击就打开了会话。真实鼠标的无修饰左键点击坐标落在删除按钮框内时，按点删除处理。
function clickLandsOnHiddenDeleteButton(event?: MouseEvent): boolean {
  if (!event || !props.canDelete || event.detail === 0 || event.button !== 0) return false
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false
  const target = event.target instanceof Element ? event.target : null
  const row = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  if (!row || !target || target.closest('.session-item-delete, .session-item-star, .session-item-warning')) return false
  const button = row.querySelector<HTMLElement>('.session-item-delete')
  if (!button) return false
  const rect = button.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false
  return event.clientX >= rect.left && event.clientX <= rect.right
    && event.clientY >= rect.top && event.clientY <= rect.bottom
}

function openDeleteConfirm() {
  if (!popoversArmed.value) {
    deleteConfirmOpenOnArm.value = true
    popoversArmed.value = true
    return
  }
  deleteConfirmRef.value?.setShow?.(true)
}

function onDeleteTriggerClick(event: MouseEvent) {
  const trigger = event.currentTarget
  if (popoversArmed.value && trigger instanceof HTMLElement && trigger.isConnected) return
  if (!popoversArmed.value) {
    const root = trigger instanceof HTMLElement ? trigger.closest('.session-item') as HTMLElement | null : null
    const hadFocus = trigger instanceof HTMLElement && document.activeElement === trigger
    deleteConfirmOpenOnArm.value = true
    popoversArmed.value = true
    if (hadFocus && root) {
      void nextTick(() => {
        root.querySelector<HTMLElement>('.session-item-delete')?.focus()
      })
    }
    return
  }
  // 预挂载发生在同一次点按手势中间时，点击会落在已被替换的旧按钮上。
  deleteConfirmRef.value?.setShow?.(true)
}
</script>

<template>
  <component
    :is="to ? 'a' : 'button'"
    class="session-item"
    :class="{ active, 'missing-models': profileModelsMissing }"
    :aria-current="active ? 'page' : undefined"
    :href="to"
    :type="!to ? 'button' : undefined"
    @click="onClick"
    @contextmenu="emit('contextmenu', $event)"
    @touchstart="onTouchStart"
    @touchend="onTouchEnd"
    @touchmove="onTouchMove"
    @pointerdown="onRowPointerdown"
    @pointerenter="onRowPointerenter"
    @focusin="onRowFocusin"
  >
    <div class="session-item-content">
      <span class="session-item-title-row">
        <span class="session-item-title-main">
          <span v-if="completedUnread" class="session-item-unread-dot" aria-hidden="true" />
          <span class="session-item-title" dir="auto">
            {{ session.title }}
          </span>
          <NTooltip v-if="profileModelsMissing" trigger="click" placement="top">
            <template #trigger>
              <button class="session-item-warning" type="button" @click.stop.prevent>
                !
              </button>
            </template>
            {{ t('chat.profileMissingModelsTip', { profile: profileName }) }}
          </NTooltip>
        </span>
      </span>
      <span class="session-item-agent-row">
        <span class="session-item-agent-logo-wrap" :class="{ streaming }">
          <span v-if="streaming" class="session-item-agent-glow" aria-hidden="true"><span /><span /><span /></span>
          <img
            class="session-item-agent-logo"
            :src="sessionAgentLogo.src"
            :alt="sessionAgentLogo.label"
          >
        </span>
        <span class="session-item-time">{{ formatSessionListTimestamp(session.createdAt) }}</span>
      </span>
    </div>
    <svg
      v-if="isGlobalAgentSession"
      class="session-item-global-icon"
      :aria-label="t('sidebar.globalAgent')"
      :title="t('sidebar.globalAgent')"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4" />
      <path d="M10 10h4v4h-4z" />
    </svg>
    <component :is="popoversArmed ? NTooltip : PopoverTriggerShell">
      <template #trigger>
        <button
          type="button"
          class="session-item-star"
          :class="{ starred }"
          :aria-pressed="starred"
          :aria-label="t(starred ? 'chat.unstarSession' : 'chat.starSession')"
          @click.stop.prevent="emit('toggle-star')"
          @mousedown.stop
          @contextmenu.stop.prevent
          @touchstart.stop
          @touchend.stop
          @keydown.stop
          @keyup.stop
        >
          <svg width="12" height="12" viewBox="0 0 24 24" :fill="starred ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m12 3 2.78 5.63L21 9.54l-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.93 1.06-6.2L3 9.54l6.22-.91z" />
          </svg>
        </button>
      </template>
      {{ t(starred ? 'chat.unstarSession' : 'chat.starSession') }}
    </component>
    <component
      :is="popoversArmed ? NPopconfirm : PopoverTriggerShell"
      v-if="canDelete"
      ref="deleteConfirmRef"
      :default-show="deleteConfirmOpenOnArm"
      @positive-click="emit('delete')"
    >
      <template #trigger>
        <button class="session-item-delete" @click.stop.prevent="onDeleteTriggerClick">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </template>
      {{ t('chat.deleteSession') }}
    </component>
  </component>
</template>

<style scoped>
.session-item {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 8px 10px;
  border: none;
  background: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-align: start;
  text-decoration: none;
  color: var(--text-secondary);
  transition: all var(--transition-fast);
  margin-bottom: 2px;
}

.session-item:hover {
  background: rgba(var(--accent-primary-rgb), 0.06);
  color: var(--text-primary);
}

.session-item:hover .session-item-star,
.session-item:hover .session-item-delete {
  opacity: 1;
  pointer-events: auto;
}

.session-item:focus-within .session-item-star,
.session-item:focus-within .session-item-delete {
  opacity: 1;
  pointer-events: auto;
}

.session-item.active {
  background: rgba(var(--accent-primary-rgb), 0.12);
  color: var(--text-primary);
  font-weight: 500;
  border-radius: 6px;
}

.session-item.active .session-item-title {
  color: var(--text-primary);
}

.session-item.missing-models {
  color: #b42318;
  background: rgba(220, 38, 38, 0.08);
}

.session-item.missing-models .session-item-title,
.session-item.missing-models .session-item-time {
  color: #b42318;
}

.session-item.missing-models:hover {
  background: rgba(220, 38, 38, 0.12);
}

.session-item-content {
  flex: 1;
  min-width: 0;
  overflow: visible;
}

.session-item-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}

.session-item-title-main {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 auto;
  min-width: 0;
}

.session-item-title {
  display: block;
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-item-unread-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-primary);
  box-shadow: 0 0 0 3px rgba(var(--accent-primary-rgb), 0.12);
}

.session-item-time {
  flex: 0 0 auto;
  margin-inline-start: auto;
  white-space: nowrap;
  direction: ltr;
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  color: var(--text-muted);
}

.session-item-global-icon {
  position: absolute;
  top: 5px;
  right: 5px;
  color: #d6a019;
  pointer-events: none;
}

.session-item-star,
.session-item-delete {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 16px;
  width: 16px;
  height: 16px;
  padding: 2px;
  opacity: 0;
  pointer-events: none;
  transition: all var(--transition-fast);
}

.session-item-star {
  margin-inline-start: 6px;
  margin-inline-end: 4px;
  border: none;
  border-radius: 3px;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
}

.session-item-star.starred {
  color: #f5c542;
}

.session-item-star:hover {
  background: rgba(245, 197, 66, 0.12);
}

.session-item-delete {
  flex-shrink: 0;
  padding: 2px;
  border: none;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 3px;
}

.session-item-delete:hover {
  color: var(--error);
  background: rgba(var(--error-rgb), 0.1);
}

@media (hover: none) {
  .session-item-star,
  .session-item-delete {
    opacity: 0.5;
    pointer-events: auto;
  }
}

.session-item-warning {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border: 1px solid rgba(180, 35, 24, 0.35);
  border-radius: 50%;
  background: rgba(220, 38, 38, 0.1);
  color: #b42318;
  font-size: 11px;
  font-weight: 700;
  line-height: 14px;
  cursor: pointer;
}

.session-item-agent-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  margin-top: 3px;
  padding: 3px 0;
}

.session-item-agent-logo-wrap {
  position: relative;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
}

/* hermes-v050:C4 运行中光环：6 层静态 box-shadow 环（颜色、模糊、周期与原 rainbow-glow 一致），
   只对 opacity 做交叉淡入淡出，plus-lighter 叠加让相邻两层按原来的颜色插值混合，全程走合成层，
   不再让整个侧栏滚动层每帧重绘。 */
.session-item-agent-glow {
  position: absolute;
  inset: -1px;
  border-radius: 50%;
  isolation: isolate;
  pointer-events: none;
}

.session-item-agent-glow > span {
  position: absolute;
  inset: 0;
  border-radius: 50%;
}

.session-item-agent-glow > span::before,
.session-item-agent-glow > span::after {
  content: "";
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  border-radius: 50%;
  opacity: 0;
  mix-blend-mode: plus-lighter;
  will-change: opacity;
  animation: session-item-glow-layer 4s linear infinite;
}

.session-item-agent-glow > span:nth-child(1)::before {
  box-shadow:
    0 0 0 2px #ff6b6b,
    0 0 10px rgba(255, 107, 107, 0.4),
    0 0 20px rgba(255, 107, 107, 0.2);
  animation-delay: 0s;
}

.session-item-agent-glow > span:nth-child(1)::after {
  box-shadow:
    0 0 0 2px #feca57,
    0 0 10px rgba(254, 202, 87, 0.4),
    0 0 20px rgba(254, 202, 87, 0.2);
  animation-delay: -3.3333s;
}

.session-item-agent-glow > span:nth-child(2)::before {
  box-shadow:
    0 0 0 2px #48dbfb,
    0 0 10px rgba(72, 219, 251, 0.4),
    0 0 20px rgba(72, 219, 251, 0.2);
  animation-delay: -2.6667s;
}

.session-item-agent-glow > span:nth-child(2)::after {
  box-shadow:
    0 0 0 2px #ff9ff3,
    0 0 10px rgba(255, 159, 243, 0.4),
    0 0 20px rgba(255, 159, 243, 0.2);
  animation-delay: -2s;
}

.session-item-agent-glow > span:nth-child(3)::before {
  box-shadow:
    0 0 0 2px #54a0ff,
    0 0 10px rgba(84, 160, 255, 0.4),
    0 0 20px rgba(84, 160, 255, 0.2);
  animation-delay: -1.3333s;
}

.session-item-agent-glow > span:nth-child(3)::after {
  box-shadow:
    0 0 0 2px #5f27cd,
    0 0 10px rgba(95, 39, 205, 0.4),
    0 0 20px rgba(95, 39, 205, 0.2);
  animation-delay: -0.6667s;
}

@media (prefers-reduced-motion: reduce) {
  .session-item-agent-glow > span::before,
  .session-item-agent-glow > span::after {
    animation: none;
    will-change: auto;
  }

  .session-item-agent-glow > span:nth-child(1)::before {
    opacity: 1;
  }
}

.session-item-agent-logo {
  position: relative;
  z-index: 1;
  width: 18px;
  height: 18px;
  box-sizing: border-box;
  border: 1px solid #fff;
  border-radius: inherit;
  object-fit: cover;
}

@keyframes session-item-glow-layer {
  0% {
    opacity: 1;
  }
  16.6667% {
    opacity: 0;
  }
  83.3333% {
    opacity: 0;
  }
  100% {
    opacity: 1;
  }
}
</style>
