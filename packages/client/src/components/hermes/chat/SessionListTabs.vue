<script setup lang="ts">
import { NTabs, NTab } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { HTMLAttributes } from 'vue'
const props = withDefaults(defineProps<{ modelValue?: 'all' | 'starred' }>(), { modelValue: 'all' })
const emit = defineEmits<{ 'update:modelValue': [value: 'all' | 'starred'] }>()
const { t } = useI18n()
function tabProps(value: 'all' | 'starred'): HTMLAttributes {
  return {
    role: 'tab',
    'aria-selected': props.modelValue === value,
    tabindex: 0,
    onKeydown(event: KeyboardEvent) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        emit('update:modelValue', value)
      }
    },
  }
}
</script>

<template>
  <NTabs
    class="session-list-tabs"
    role="tablist"
    :value="modelValue"
    type="card"
    size="small"
    justify-content="space-evenly"
    @update:value="emit('update:modelValue', $event)"
  >
    <NTab name="all" v-bind="tabProps('all')">{{ t('chat.allSessions') }}</NTab>
    <NTab name="starred" v-bind="tabProps('starred')">{{ t('chat.starredSessions') }}</NTab>
  </NTabs>
</template>

<style scoped>
/* Reserve the raised tab's height so filtering never moves the list. */
.session-list-tabs { flex: 1; min-width: 0; height: 34px; }
.session-list-tabs.n-tabs.n-tabs--card-type :deep(.n-tabs-nav-scroll-content),
.session-list-tabs.n-tabs.n-tabs--card-type :deep(.n-tabs-wrapper) { height: 34px; align-items: flex-end; }
.session-list-tabs.n-tabs.n-tabs--card-type :deep(.n-tabs-wrapper) { gap: 0; flex: 1; width: 100%; }
.session-list-tabs.n-tabs.n-tabs--card-type :deep(.n-tabs-tab-wrapper) { flex: 1; min-width: 0; }
.session-list-tabs.n-tabs.n-tabs--card-type :deep(.n-tabs-tab-pad),
.session-list-tabs.n-tabs.n-tabs--card-type :deep(.n-tabs-pad) { display: none; }
.session-list-tabs.n-tabs.n-tabs--card-type :deep(.n-tabs-tab) {
  box-sizing: border-box;
  width: 100%;
  height: 30px;
  padding: 0 12px;
  justify-content: center;
  border: 1px solid var(--border-color);
  border-radius: 0;
  box-shadow: none;
  background: color-mix(in srgb, var(--bg-sidebar-surface) 96%, var(--text-secondary));
  color: var(--text-muted);
  font-size: 12px;
  transition: background-color 120ms ease, color 120ms ease;
}
.session-list-tabs.n-tabs.n-tabs--card-type :deep(.n-tabs-tab--active) {
  height: 34px;
  background: var(--bg-sidebar-surface);
  border-bottom-color: var(--bg-sidebar-surface);
  color: var(--text-primary);
  font-weight: 600;
}
/* The taller active tab owns the shared edge, keeping the top step closed. */
.session-list-tabs.n-tabs.n-tabs--card-type :deep(.n-tabs-tab[data-name="all"]:not(.n-tabs-tab--active)) { border-right-width: 0; }
.session-list-tabs.n-tabs.n-tabs--card-type :deep(.n-tabs-tab[data-name="starred"]:not(.n-tabs-tab--active)) { border-left-width: 0; }
.session-list-tabs.n-tabs.n-tabs--card-type :deep(.n-tabs-tab:focus-visible) { outline: 2px solid var(--text-secondary); outline-offset: -3px; }

</style>
