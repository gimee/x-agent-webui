<script setup lang="ts">
import { ref } from 'vue'
import { NButton, NForm, NFormItem, NInput, NModal, NTooltip, useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useQuickPhrases, type QuickPhrase } from '@/composables/useQuickPhrases'

const { t } = useI18n()
const dialog = useDialog()
const message = useMessage()
const { phrases, addPhrase, updatePhrase, removePhrase, reorderPhrase } = useQuickPhrases()
const showModal = ref(false)
const showForm = ref(false)
const editingId = ref<string | null>(null)
const phraseDraft = ref('')
const draggingId = ref<string | null>(null)

function openModal() {
  showModal.value = true
}

function openAddForm() {
  editingId.value = null
  phraseDraft.value = ''
  showForm.value = true
}

function openEditForm(item: QuickPhrase) {
  editingId.value = item.id
  phraseDraft.value = item.phrase
  showForm.value = true
}

function submitForm() {
  if (!phraseDraft.value.trim()) {
    message.warning(t('quickPhrases.required'))
    return false
  }
  const ok = editingId.value
    ? updatePhrase(editingId.value, phraseDraft.value)
    : addPhrase(phraseDraft.value)
  if (!ok) {
    message.error(t('quickPhrases.storageFailed'))
    return false
  }
  showForm.value = false
  return true
}

function confirmRemove(item: QuickPhrase) {
  dialog.warning({
    title: t('quickPhrases.deleteTitle'),
    content: t('quickPhrases.deleteConfirm'),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => {
      const ok = removePhrase(item.id)
      if (!ok) message.error(t('quickPhrases.storageFailed'))
      return ok
    },
  })
}

function startDrag(event: DragEvent, id: string) {
  draggingId.value = id
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', id)
  }
}

function dropOn(id: string) {
  if (draggingId.value && !reorderPhrase(draggingId.value, id)) message.error(t('quickPhrases.storageFailed'))
  draggingId.value = null
}

function clearDrag() {
  draggingId.value = null
}
</script>

<template>
  <!-- hermes-v0.1.2: trigger is slotted; PageSidebarNav renders it as the 4th conversation tab. -->
  <slot name="trigger" :open="openModal">
    <NTooltip trigger="hover" placement="top">
      <template #trigger>
        <button class="quick-phrase-link" type="button" :aria-label="t('quickPhrases.title')" @click.stop="openModal">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M6 4h12v16l-6-3-6 3V4Z" />
            <path d="M9 8h6M9 12h4" />
          </svg>
        </button>
      </template>
      {{ t('quickPhrases.title') }}
    </NTooltip>
  </slot>
  <NModal v-model:show="showModal" :show-icon="false">
    <div class="mcu-device-dialog quick-phrase-dialog">
      <div class="mcu-device-header">
        <div>
          <div class="mcu-device-title">{{ t('quickPhrases.title') }}</div>
          <div class="mcu-device-subtitle">{{ t('quickPhrases.subtitle') }}</div>
        </div>
        <button class="mcu-device-close" type="button" :aria-label="t('common.cancel')" @click="showModal = false">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div class="quick-phrase-table-wrap">
        <div class="quick-phrase-table-head">
          <span>{{ t('quickPhrases.phrase') }}</span>
          <span>{{ t('quickPhrases.operation') }}</span>
        </div>
        <div v-if="phrases.length" class="quick-phrase-table-body">
          <div
            v-for="item in phrases"
            :key="item.id"
            class="quick-phrase-row"
            :class="{ 'is-dragging': draggingId === item.id }"
            @dragover.prevent
            @drop.prevent="dropOn(item.id)"
          >
            <div class="quick-phrase-value">
              <button
                class="quick-phrase-drag-handle"
                type="button"
                draggable="true"
                :aria-label="t('quickPhrases.drag')"
                @dragstart="startDrag($event, item.id)"
                @dragend="clearDrag"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <circle cx="8" cy="7" r="1.4" /><circle cx="16" cy="7" r="1.4" />
                  <circle cx="8" cy="12" r="1.4" /><circle cx="16" cy="12" r="1.4" />
                  <circle cx="8" cy="17" r="1.4" /><circle cx="16" cy="17" r="1.4" />
                </svg>
              </button>
              <span>{{ item.phrase }}</span>
            </div>
            <div class="quick-phrase-operations">
              <button type="button" class="quick-phrase-operation" :aria-label="t('quickPhrases.edit')" @click="openEditForm(item)">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 16-.8 4.8L8 20l11-11-4-4L4 16Z" /><path d="m13.5 6.5 4 4" /></svg>
              </button>
              <button type="button" class="quick-phrase-operation danger" :aria-label="t('quickPhrases.delete')" @click="confirmRemove(item)">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
              </button>
            </div>
          </div>
        </div>
        <div v-else class="quick-phrase-empty">{{ t('quickPhrases.empty') }}</div>
      </div>
      <div class="mcu-device-actions">
        <NButton type="primary" @click="openAddForm">{{ t('quickPhrases.add') }}</NButton>
      </div>
    </div>
  </NModal>

  <NModal
    v-model:show="showForm"
    preset="dialog"
    :title="editingId ? t('quickPhrases.editTitle') : t('quickPhrases.addTitle')"
    :positive-text="t('common.save')"
    :negative-text="t('common.cancel')"
    @positive-click="submitForm"
  >
    <NForm label-placement="top">
      <NFormItem :label="t('quickPhrases.phrase')" required>
        <NInput v-model:value="phraseDraft" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" :placeholder="t('quickPhrases.placeholder')" @keydown.enter.exact.prevent="submitForm" />
      </NFormItem>
    </NForm>
  </NModal>
</template>

<style scoped lang="scss">
.quick-phrase-link {
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  width: 36px;
  height: 28px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color 0.16s ease, color 0.16s ease;

  &:hover { background: rgba(var(--accent-primary-rgb), 0.08); color: var(--text-primary); }
}

.mcu-device-dialog {
  width: min(880px, calc(100vw - 48px));
  height: min(680px, calc(100vh - 72px));
  background: var(--bg-card);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.mcu-device-header { flex: 0 0 auto; min-height: 68px; padding: 16px 18px; display: flex; align-items: center; justify-content: space-between; background: var(--bg-secondary); border-bottom: 1px solid var(--border-color); }
.mcu-device-title { font-size: 16px; font-weight: 650; line-height: 22px; }
.mcu-device-subtitle { margin-top: 2px; font-size: 12px; line-height: 18px; color: var(--text-muted); }
.mcu-device-close { width: 32px; height: 32px; border: 0; border-radius: 8px; background: transparent; color: var(--text-secondary); display: inline-grid; place-items: center; cursor: pointer; &:hover { background: rgba(var(--text-muted-rgb), 0.14); color: var(--text-primary); } }
.quick-phrase-table-wrap { flex: 1 1 auto; min-height: 0; padding: 12px 18px; overflow: auto; }
.quick-phrase-table-head, .quick-phrase-row { display: grid; grid-template-columns: minmax(0, 1fr) 96px; gap: 12px; align-items: center; }
.quick-phrase-table-head { padding: 9px 10px; color: var(--text-secondary); background: var(--bg-secondary); border: 1px solid var(--border-color); font-size: 12px; font-weight: 600; }
.quick-phrase-row { min-height: 48px; padding: 7px 10px; border: 1px solid var(--border-color); border-top: 0; background: var(--bg-card); transition: background-color 0.15s ease, opacity 0.15s ease; &.is-dragging { opacity: 0.45; background: rgba(var(--accent-primary-rgb), 0.08); } }
.quick-phrase-value { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 13px; line-height: 18px; white-space: pre-wrap; overflow-wrap: anywhere; }
.quick-phrase-drag-handle { flex: 0 0 26px; width: 26px; height: 28px; padding: 0; border: 0; background: transparent; color: var(--text-muted); cursor: grab; display: inline-grid; place-items: center; &:active { cursor: grabbing; } &:hover { color: var(--text-primary); } }
.quick-phrase-operations { display: flex; justify-content: flex-end; gap: 4px; }
.quick-phrase-operation { width: 30px; height: 30px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--text-secondary); display: inline-grid; place-items: center; cursor: pointer; &:hover { background: rgba(var(--accent-primary-rgb), 0.08); color: var(--text-primary); } &.danger:hover { color: var(--error); } }
.quick-phrase-empty { padding: 36px 12px; color: var(--text-muted); font-size: 13px; text-align: center; }
.mcu-device-actions { flex: 0 0 auto; padding: 12px 18px 16px; display: flex; justify-content: flex-end; gap: 10px; background: var(--bg-secondary); border-top: 1px solid var(--border-color); }
@media (max-width: 640px) { .mcu-device-dialog { width: calc(100vw - 24px); height: calc(100vh - 32px); } .quick-phrase-table-head, .quick-phrase-row { grid-template-columns: minmax(0, 1fr) 76px; gap: 6px; } }
</style>
