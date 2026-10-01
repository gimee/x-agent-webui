<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { NPopover, NSlider, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchCcEffort, updateCcEffort, type CcEffortLevel } from '@/api/hermes/cc-api'

// hermes-v0.4.3: Agent 管理 → Claude → 推理强度. Same slider popover as the chat
// input's reasoning effort control; the value is written to ~/.claude/settings.json.
const { t } = useI18n()
const message = useMessage()
const level = ref<CcEffortLevel>('auto')
let saveTimer: ReturnType<typeof setTimeout> | null = null

const effortOptions = computed<Array<{ label: string; value: CcEffortLevel }>>(() => [
  { label: t('ccEffort.auto'), value: 'auto' },
  { label: t('chat.reasoningEffort.options.low'), value: 'low' },
  { label: t('chat.reasoningEffort.options.medium'), value: 'medium' },
  { label: t('chat.reasoningEffort.options.high'), value: 'high' },
  { label: t('chat.reasoningEffort.options.xhigh'), value: 'xhigh' },
  { label: t('chat.reasoningEffort.options.max'), value: 'max' },
])
const sliderValue = computed(() => {
  const index = effortOptions.value.findIndex(option => option.value === level.value)
  return index >= 0 ? index : 0
})
// Same palette as the chat slider (its default/low/medium/high/xhigh/max stops).
const accentColors = ['#94a3b8', '#4ed786', '#b9d93a', '#f9c33c', '#f77734', '#ef4444'] as const
const accentStyle = computed(() => ({
  '--reasoning-effort-accent-color': accentColors[sliderValue.value] || accentColors[0],
}))
const levelLabel = computed(() => effortOptions.value[sliderValue.value]?.label || level.value)

async function load() {
  try {
    level.value = (await fetchCcEffort()).level
  } catch (err: any) {
    message.error(err?.message || String(err))
  }
}

async function save(next: CcEffortLevel) {
  try {
    level.value = (await updateCcEffort(next)).level
    message.success(t('ccEffort.saved', { level: levelLabel.value }))
  } catch (err: any) {
    message.error(err?.message || String(err))
    await load()
  }
}

function sliderLabel(value: number) {
  return effortOptions.value[Math.round(value)]?.label || levelLabel.value
}

function onSliderChange(value: number | [number, number]) {
  const numericValue = Array.isArray(value) ? value[0] : value
  const option = effortOptions.value[Math.round(numericValue)]
  if (!option || option.value === level.value) return
  level.value = option.value
  // Dragging emits every step; persist once the handle settles.
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void save(option.value)
  }, 300)
}

function onShow(show: boolean) {
  if (show) void load()
}

onBeforeUnmount(() => {
  if (saveTimer) clearTimeout(saveTimer)
})
</script>

<template>
  <NPopover trigger="click" placement="bottom-start" @update:show="onShow">
    <template #trigger>
      <slot name="trigger" />
    </template>

    <div class="reasoning-effort-slider-popover" :style="accentStyle" data-testid="cc-effort-popover">
      <div class="reasoning-effort-slider-heading">
        <span>{{ t('chat.reasoningEffort.tooltip') }}</span>
        <strong>{{ levelLabel }}</strong>
      </div>
      <NSlider
        class="reasoning-effort-slider"
        :class="{ 'reasoning-effort-slider--max': level === 'max' }"
        :value="sliderValue"
        :min="0"
        :max="effortOptions.length - 1"
        :step="1"
        :format-tooltip="sliderLabel"
        @update:value="onSliderChange"
      />
      <div class="reasoning-effort-slider-range" aria-hidden="true">
        <span>{{ effortOptions[0].label }}</span>
        <span>{{ effortOptions[effortOptions.length - 1].label }}</span>
      </div>
      <div class="reasoning-effort-slider-hint">
        {{ t('chat.reasoningEffort.dragHint', { count: effortOptions.length }) }}
      </div>
      <div class="reasoning-effort-slider-hint">{{ t('ccEffort.hint') }}</div>
    </div>
  </NPopover>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.reasoning-effort-slider-popover {
  width: min(320px, calc(100vw - 64px));
  padding: 4px 2px 2px;
}

.reasoning-effort-slider-heading,
.reasoning-effort-slider-range {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.reasoning-effort-slider-hint {
  margin-top: 6px;
  color: $text-muted;
  font-size: 11px;
  text-align: center;
}

.reasoning-effort-slider-heading {
  margin-bottom: 10px;
  color: $text-secondary;
  font-size: 12px;

  strong {
    color: var(--reasoning-effort-accent-color);
    font-weight: 600;
  }
}

.reasoning-effort-slider {
  --n-handle-size: 24px !important;
  --n-rail-height: 10px !important;
  --reasoning-effort-gradient-width: min(314px, calc(100vw - 70px));
  margin: 0 3px;

  :deep(.n-slider-rail) {
    background: rgba(var(--text-muted-rgb), 0.2); /* hermes-v050:U4 same track as ChatInput.vue .context-bar */
  }

  :deep(.n-slider-rail__fill) {
    background: linear-gradient(
      90deg,
      #38bdf8 0%,
      #22d3ee 20%,
      #34d399 40%,
      #facc15 62%,
      #fb923c 82%,
      #ef4444 100%
    );
    background-position: left center;
    background-repeat: no-repeat;
    background-size: var(--reasoning-effort-gradient-width) 100%;
    box-shadow: 0 0 8px rgba(56, 189, 248, 0.24);
  }

  :deep(.n-slider-handle) {
    border: 2px solid rgba(255, 255, 255, 0.92);
    background: #f8fafc;
    box-shadow: 0 2px 8px rgba(24, 18, 44, 0.38);
  }
}

.reasoning-effort-slider--max {
  :deep(.n-slider-handle) {
    position: relative;
    overflow: hidden;
    isolation: isolate;
    border-radius: 50%;
    border-color: rgba(255, 255, 255, 0.96);
    background:
      radial-gradient(circle at 24% 24%, #38bdf8 0 14%, transparent 34%),
      radial-gradient(circle at 78% 22%, #facc15 0 15%, transparent 36%),
      radial-gradient(circle at 78% 78%, #ef4444 0 16%, transparent 38%),
      radial-gradient(circle at 22% 76%, #34d399 0 15%, transparent 36%),
      conic-gradient(from 30deg, #22d3ee, #34d399, #facc15, #fb923c, #ef4444, #a855f7, #38bdf8, #22d3ee);
    background-size: 150% 150%, 145% 145%, 155% 155%, 145% 145%, 180% 180%;
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.38),
      0 0 12px rgba(239, 68, 68, 0.46),
      0 3px 9px rgba(24, 18, 44, 0.44);
    animation: reasoning-effort-max-liquid 3.6s ease-in-out infinite;
  }

  :deep(.n-slider-handle::after) {
    content: '';
    position: absolute;
    inset: 2px 5px 11px 5px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.5);
    filter: blur(1px);
    animation: reasoning-effort-max-highlight 2.8s ease-in-out infinite;
  }
}

@keyframes reasoning-effort-max-liquid {
  0%, 100% {
    background-position: 0% 20%, 100% 0%, 100% 100%, 0% 100%, 50% 50%;
    background-size: 150% 150%, 145% 145%, 155% 155%, 145% 145%, 180% 180%;
  }

  33% {
    background-position: 65% 0%, 55% 70%, 30% 100%, 0% 35%, 100% 35%;
    background-size: 175% 135%, 135% 175%, 165% 140%, 140% 165%, 210% 170%;
  }

  66% {
    background-position: 100% 70%, 20% 100%, 0% 35%, 75% 0%, 0% 70%;
    background-size: 135% 175%, 170% 140%, 140% 170%, 170% 135%, 170% 210%;
  }
}

@keyframes reasoning-effort-max-highlight {
  0%, 100% {
    opacity: 0.72;
    transform: translate(-1px, -1px) rotate(0deg);
  }

  50% {
    opacity: 0.42;
    transform: translate(3px, 2px) rotate(180deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .reasoning-effort-slider--max {
    :deep(.n-slider-handle),
    :deep(.n-slider-handle::after) {
      animation: none;
    }
  }
}

.reasoning-effort-slider-range {
  margin-top: 4px;
  color: $text-muted;
  font-size: 10px;
}
</style>
