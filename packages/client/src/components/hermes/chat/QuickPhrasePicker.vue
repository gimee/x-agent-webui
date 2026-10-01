<script setup lang="ts">
import { ref } from 'vue'
import { NPopover, NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useQuickPhrases } from '@/composables/useQuickPhrases'

const emit = defineEmits<{ select: [phrase: string] }>()
const { t } = useI18n()
const { phrases } = useQuickPhrases()
const showPopover = ref(false)

function selectPhrase(phrase: string) {
  showPopover.value = false
  emit('select', phrase)
}
</script>

<template>
  <NPopover v-model:show="showPopover" trigger="click" placement="top-start" :show-arrow="true">
    <template #trigger>
      <NTooltip trigger="hover">
        <template #trigger>
          <button
            type="button"
            class="quick-phrase-picker-button"
            :aria-label="t('quickPhrases.inputTitle')"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M7 3h10a2 2 0 0 1 2 2v14l-4-2-4 2-4-2-4 2V5a2 2 0 0 1 2-2Z" />
              <path d="M8 8h8M8 12h6" />
            </svg>
          </button>
        </template>
        {{ t('quickPhrases.inputTitle') }}
      </NTooltip>
    </template>
    <div class="quick-phrase-picker">
      <div class="quick-phrase-picker-title">{{ t('quickPhrases.inputTitle') }}</div>
      <div v-if="phrases.length" class="quick-phrase-picker-list">
        <button
          v-for="item in phrases"
          :key="item.id"
          type="button"
          class="quick-phrase-picker-item"
          @click="selectPhrase(item.phrase)"
        >
          {{ item.phrase }}
        </button>
      </div>
      <div v-else class="quick-phrase-picker-empty">{{ t('quickPhrases.empty') }}</div>
    </div>
  </NPopover>
</template>

<style scoped lang="scss">
.quick-phrase-picker-button {
  display: inline-grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background-color 0.16s ease, color 0.16s ease;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.08);
    color: var(--text-primary);
  }
}

.quick-phrase-picker {
  width: min(320px, calc(100vw - 32px));
  max-height: min(360px, calc(100vh - 120px));
  overflow-y: auto;
  padding: 4px;
}

.quick-phrase-picker-title {
  padding: 7px 9px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
}

.quick-phrase-picker-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.quick-phrase-picker-item {
  width: 100%;
  padding: 8px 9px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  text-align: start;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  cursor: pointer;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.08);
  }
}

.quick-phrase-picker-empty {
  padding: 14px 9px;
  color: var(--text-muted);
  font-size: 12px;
}
</style>
