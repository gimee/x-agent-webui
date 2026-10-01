<script setup lang="ts">
import { computed, h, ref } from 'vue'
import { NButton, NDataTable, NForm, NFormItem, NInput, NModal, NSpace, NTag, NTooltip, useDialog, useMessage } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { applyCcApiProfile, createCcApiProfile, deleteCcApiProfile, fetchCcApiProfiles, updateCcApiProfile, type CcApiProfile } from '@/api/hermes/cc-api'

const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()
const showModal = ref(false)
const showFormModal = ref(false)
const loading = ref(false)
const saving = ref(false)
const applyingId = ref('')
const profiles = ref<CcApiProfile[]>([])
const activeId = ref<string | null>(null)
const editingId = ref('')
const form = ref({ name: '', base_url: '', api_key: '' })

// Chrome ignores plain autocomplete=off: history suggestions key off the
// input's name (randomize it per page load) and the password manager
// auto-fills type=password on open (block with readonly-until-focus).
const formNonce = Math.random().toString(36).slice(2, 8)
const nameInputProps = { name: `cc-api-name-${formNonce}`, autocomplete: 'off', spellcheck: false, 'data-form-type': 'other' }
const urlInputProps = { name: `cc-api-url-${formNonce}`, autocomplete: 'off', spellcheck: false, 'data-form-type': 'other' }
const keyInputProps = {
  name: `cc-api-key-${formNonce}`,
  autocomplete: 'new-password',
  autocapitalize: 'none',
  spellcheck: false,
  readonly: true,
  'data-form-type': 'other',
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
}

function unlockReadonly(e: FocusEvent) {
  (e.target as HTMLInputElement | null)?.removeAttribute?.('readonly')
}

function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 12) return `${key.slice(0, 4)}…`
  return `${key.slice(0, 8)}…${key.slice(-4)}`
}

function applyResponse(res: { profiles: CcApiProfile[]; active_id: string | null }) {
  profiles.value = res.profiles
  activeId.value = res.active_id
}

async function loadProfiles() {
  loading.value = true
  try {
    applyResponse(await fetchCcApiProfiles())
  } catch (err: any) {
    message.error(err?.message || String(err))
  } finally {
    loading.value = false
  }
}

function openModal() {
  showModal.value = true
  void loadProfiles()
}

function openAddModal() {
  editingId.value = ''
  form.value = { name: '', base_url: '', api_key: '' }
  showFormModal.value = true
}

function openEditModal(row: CcApiProfile) {
  editingId.value = row.id
  form.value = { name: row.name, base_url: row.baseUrl, api_key: row.apiKey }
  showFormModal.value = true
}

async function submitForm() {
  const { name, base_url, api_key } = form.value
  if (!name.trim() || !base_url.trim() || !api_key.trim()) {
    message.warning(t('ccApi.allRequired'))
    return false
  }
  saving.value = true
  try {
    const res = editingId.value
      ? await updateCcApiProfile(editingId.value, { name: name.trim(), base_url: base_url.trim(), api_key: api_key.trim() })
      : await createCcApiProfile({ name: name.trim(), base_url: base_url.trim(), api_key: api_key.trim() })
    applyResponse(res)
    showFormModal.value = false
    message.success(editingId.value ? t('ccApi.updated') : t('ccApi.added'))
  } catch (err: any) {
    message.error(err?.message || String(err))
    return false
  } finally {
    saving.value = false
  }
}

async function applyProfile(row: CcApiProfile) {
  applyingId.value = row.id
  try {
    applyResponse(await applyCcApiProfile(row.id))
    message.success(t('ccApi.applied', { name: row.name }))
  } catch (err: any) {
    message.error(err?.message || String(err))
  } finally {
    applyingId.value = ''
  }
}

function confirmDelete(row: CcApiProfile) {
  dialog.warning({
    title: t('ccApi.deleteTitle'),
    content: t('ccApi.deleteConfirm', { name: row.name }),
    positiveText: t('common.confirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        applyResponse(await deleteCcApiProfile(row.id))
        message.success(t('ccApi.deleted'))
      } catch (err: any) {
        message.error(err?.message || String(err))
      }
    },
  })
}

const columns = computed<DataTableColumns<CcApiProfile>>(() => [
  {
    title: t('ccApi.name'),
    key: 'name',
    ellipsis: { tooltip: true },
    render(row) {
      if (row.id !== activeId.value) return row.name
      return h(NSpace, { size: 6, align: 'center', wrapItem: false }, {
        default: () => [
          row.name,
          h(NTag, { size: 'small', type: 'success', bordered: false }, { default: () => t('ccApi.active') }),
        ],
      })
    },
  },
  {
    title: 'URL',
    key: 'baseUrl',
    ellipsis: { tooltip: true },
  },
  {
    title: 'API Key',
    key: 'apiKey',
    width: 170,
    render(row) {
      return maskKey(row.apiKey)
    },
  },
  {
    title: t('ccApi.actions'),
    key: 'actions',
    width: 190,
    render(row) {
      const isActive = row.id === activeId.value
      return h(NSpace, { size: 4, wrapItem: false }, {
        default: () => [
          h(NButton, {
            size: 'tiny',
            type: 'primary',
            secondary: true,
            disabled: isActive,
            loading: applyingId.value === row.id,
            onClick: () => applyProfile(row),
          }, { default: () => t('ccApi.apply') }),
          h(NButton, {
            size: 'tiny',
            secondary: true,
            disabled: isActive,
            onClick: () => openEditModal(row),
          }, { default: () => t('common.edit') }),
          h(NButton, {
            size: 'tiny',
            type: 'error',
            secondary: true,
            disabled: isActive,
            onClick: () => confirmDelete(row),
          }, { default: () => t('common.delete') }),
        ],
      })
    },
  },
])

</script>

<template>
  <!-- hermes-v0.1.2: trigger is slotted so the manager can live anywhere (Agent 管理 → Claude → API管理). -->
  <slot name="trigger" :open="openModal">
    <NTooltip trigger="hover" placement="top">
      <template #trigger>
        <button class="cc-api-link" type="button" :aria-label="t('ccApi.title')" @click.stop="openModal">
          <svg class="cc-api-badge" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="4" />
            <path d="M15 9.5a3.5 3.5 0 1 0 0 5" />
          </svg>
        </button>
      </template>
      {{ t('ccApi.title') }}
    </NTooltip>
  </slot>
  <NModal v-model:show="showModal" :show-icon="false">
    <div class="mcu-device-dialog">
      <div class="mcu-device-header">
        <div>
          <div class="mcu-device-title">{{ t('ccApi.title') }}</div>
          <div class="mcu-device-subtitle">{{ t('ccApi.subtitle') }}</div>
        </div>
        <button class="mcu-device-close" type="button" :aria-label="t('common.cancel')" @click="showModal = false">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>
      <div class="mcu-device-table">
        <NDataTable
          style="height: 100%;"
          size="small"
          :columns="columns"
          :data="profiles"
          :loading="loading"
          :bordered="false"
          :single-line="false"
          :row-key="(row: CcApiProfile) => row.id"
          flex-height
        />
      </div>
      <div class="mcu-device-actions">
        <NButton type="primary" @click="openAddModal">{{ t('ccApi.add') }}</NButton>
      </div>
    </div>
  </NModal>
  <NModal
    v-model:show="showFormModal"
    preset="dialog"
    :title="editingId ? t('ccApi.editTitle') : t('ccApi.addTitle')"
    :positive-text="editingId ? t('common.save') : t('ccApi.add')"
    :negative-text="t('common.cancel')"
    :positive-button-props="{ loading: saving }"
    @positive-click="submitForm"
  >
    <NForm label-placement="top" autocomplete="off">
      <NFormItem :label="t('ccApi.name')" required>
        <NInput v-model:value="form.name" :input-props="nameInputProps" :placeholder="t('ccApi.namePlaceholder')" :disabled="saving" />
      </NFormItem>
      <NFormItem label="URL" required>
        <NInput v-model:value="form.base_url" :input-props="urlInputProps" placeholder="https://..." :disabled="saving" />
      </NFormItem>
      <NFormItem label="API Key" required>
        <NInput
          v-model:value="form.api_key"
          type="password"
          show-password-on="click"
          :input-props="keyInputProps"
          placeholder="sk-..."
          :disabled="saving"
          @focus="unlockReadonly"
          @keydown.enter.prevent="submitForm"
        />
      </NFormItem>
    </NForm>
  </NModal>
</template>

<style scoped lang="scss">
.cc-api-link {
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  width: 36px;
  height: 28px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition:
    background-color 0.16s ease,
    color 0.16s ease;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.08);
    color: var(--text-primary);
  }
}

.cc-api-badge {
  flex: 0 0 auto;
  width: 17px;
  height: 17px;
  color: inherit;
  overflow: visible;
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

.mcu-device-header {
  flex: 0 0 auto;
  min-height: 68px;
  padding: 16px 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
}

.mcu-device-title {
  font-size: 16px;
  font-weight: 650;
  line-height: 22px;
  color: var(--text-primary);
}

.mcu-device-subtitle {
  margin-top: 2px;
  font-size: 12px;
  line-height: 18px;
  color: var(--text-muted);
}

.mcu-device-close {
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  display: inline-grid;
  place-items: center;
  cursor: pointer;

  &:hover {
    background: rgba(var(--text-muted-rgb), 0.14);
    color: var(--text-primary);
  }
}

.mcu-device-actions {
  flex: 0 0 auto;
  padding: 12px 18px 16px;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
}

.mcu-device-table {
  flex: 1 1 auto;
  min-height: 0;
  padding: 12px 18px;
  overflow: hidden;

  :deep(.n-data-table) {
    height: 100%;
    --n-td-color: var(--bg-card);
    --n-th-color: var(--bg-secondary);
    --n-border-color: var(--border-color);
    --n-td-text-color: var(--text-primary);
    --n-th-text-color: var(--text-secondary);
  }

  :deep(.n-data-table-base-table) {
    height: 100%;
  }

  :deep(.n-data-table-base-table-body) {
    overflow-y: auto;
  }
}

@media (max-width: 640px) {
  .mcu-device-dialog {
    width: calc(100vw - 24px);
    height: calc(100vh - 32px);
  }

  .mcu-device-actions {
    justify-content: stretch;

    :deep(.n-button) {
      flex: 1;
    }
  }
}
</style>
