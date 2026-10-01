<script setup lang="ts">
import { computed, ref } from 'vue'
import { NInputNumber, NModal, NSwitch, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchCcCompression, updateCcCompression, type CcCompressionValues } from '@/api/hermes/cc-api'
import SettingRow from '@/components/hermes/settings/SettingRow.vue'

// hermes-v051:C Agent 管理 → Claude → 压缩设置. Modal shell copied from CcApiBadge.vue; the five rows and
// their save / 300 ms debounce copied from CompressionSettings.vue (设置 → 上下文压缩). The only change to
// the rows is :disabled while 与主设置同步 is on — they then show the main settings values read-only.
const { t } = useI18n()
const message = useMessage()
const showModal = ref(false)
const followMain = ref(false)
const own = ref<Partial<CcCompressionValues>>({})
const main = ref<Partial<CcCompressionValues>>({})
const shown = computed(() => (followMain.value ? main.value : own.value))

// Claude's own defaults (server CLAUDE_COMPRESSION_DEFAULTS), shown until the settings load.
const defaults = {
  enabled: true,
  threshold: 0.4,
  target_ratio: 0.08,
  protect_last_n: 20,
  protect_first_n: 3,
}

const debounceTimers: Record<string, ReturnType<typeof setTimeout>> = {}
// hermes-v051:C loading as in CcApiBadge.vue; controls stay read-only until a load succeeds, so a
// failed or still-running GET never shows editable defaults or overwrites a change made meanwhile.
const loading = ref(false)
const loaded = ref(false)
const pendingSaves: Record<string, () => Promise<void>> = {}
const inflight = new Set<Promise<void>>()
const track = (run: Promise<void>) => { inflight.add(run); void run.finally(() => inflight.delete(run)) }

async function loadSettings() {
  loading.value = true
  try {
    // A debounced edit from the previous opening is saved before the GET, never read back stale.
    for (const [key, flush] of Object.entries(pendingSaves)) {
      clearTimeout(debounceTimers[key])
      delete pendingSaves[key]
      track(flush())
    }
    await Promise.allSettled([...inflight])
    const res = await fetchCcCompression()
    followMain.value = res.follow_main
    own.value = res.own
    main.value = res.main
    loaded.value = true
  } catch (err: any) {
    loaded.value = false
    message.error(err?.message || String(err))
  } finally {
    loading.value = false
  }
}

function openModal() {
  showModal.value = true
  void loadSettings()
}

function saveFollowMain(value: boolean) {
  followMain.value = value
  track(updateCcCompression({ follow_main: value }).then(() => {
    message.success(t('settings.saved'))
  }).catch(() => {
    message.error(t('settings.saveFailed'))
  }))
}

function save(values: Record<string, any>) {
  own.value = { ...own.value, ...values }
  track(updateCcCompression({ own: values }).then(() => {
    message.success(t('settings.saved'))
  }).catch(() => {
    message.error(t('settings.saveFailed'))
  }))
}

function debouncedSave(key: string, value: any) {
  own.value = { ...own.value, [key]: value }
  if (debounceTimers[key]) clearTimeout(debounceTimers[key])
  pendingSaves[key] = async () => {
    try {
      await updateCcCompression({ own: { [key]: value } })
      message.success(t('settings.saved'))
    } catch {
      message.error(t('settings.saveFailed'))
    }
  }
  debounceTimers[key] = setTimeout(() => {
    const flush = pendingSaves[key]
    delete pendingSaves[key]
    if (flush) track(flush())
  }, 300)
}
</script>

<template>
  <!-- hermes-v051:C trigger is slotted like CcApiBadge (Agent 管理 → Claude → 压缩设置). -->
  <slot name="trigger" :open="openModal" />
  <NModal v-model:show="showModal" :show-icon="false">
    <div class="mcu-device-dialog">
      <div class="mcu-device-header">
        <div>
          <div class="mcu-device-title">{{ t('ccCompression.title') }}</div>
        </div>
        <button class="mcu-device-close" type="button" :aria-label="t('common.cancel')" @click="showModal = false">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>
      <div class="mcu-device-table">
        <section class="settings-section">
          <SettingRow :label="t('ccCompression.followMain')" :hint="t('ccCompression.followMainHint')">
            <NSwitch
              :value="followMain"
              :disabled="!loaded"
              size="small"
              @update:value="v => saveFollowMain(v)"
            />
          </SettingRow>
          <SettingRow :label="t('settings.compression.enabled')" :hint="t('settings.compression.enabledHint')">
            <NSwitch
              :value="shown.enabled ?? defaults.enabled"
              size="small"
              :disabled="followMain || !loaded"
              @update:value="v => save({ enabled: v })"
            />
          </SettingRow>
          <SettingRow :label="t('settings.compression.threshold')" :hint="t('settings.compression.thresholdHint')">
            <NInputNumber
              :value="shown.threshold ?? defaults.threshold"
              :min="0.1"
              :max="0.95"
              :step="0.05"
              size="small"
              class="input-sm"
              :disabled="followMain || !loaded"
              @update:value="v => v != null && debouncedSave('threshold', v)"
            />
          </SettingRow>
          <SettingRow :label="t('settings.compression.targetRatio')" :hint="t('settings.compression.targetRatioHint')">
            <NInputNumber
              :value="shown.target_ratio ?? defaults.target_ratio"
              :min="0.05"
              :max="0.8"
              :step="0.05"
              size="small"
              class="input-sm"
              :disabled="followMain || !loaded"
              @update:value="v => v != null && debouncedSave('target_ratio', v)"
            />
          </SettingRow>
          <SettingRow :label="t('settings.compression.protectLastN')" :hint="t('settings.compression.protectLastNHint')">
            <NInputNumber
              :value="shown.protect_last_n ?? defaults.protect_last_n"
              :min="0"
              :max="200"
              :step="1"
              size="small"
              class="input-sm"
              :disabled="followMain || !loaded"
              @update:value="v => v != null && debouncedSave('protect_last_n', v)"
            />
          </SettingRow>
          <SettingRow :label="t('settings.compression.protectFirstN')" :hint="t('settings.compression.protectFirstNHint')">
            <NInputNumber
              :value="shown.protect_first_n ?? defaults.protect_first_n"
              :min="0"
              :max="50"
              :step="1"
              size="small"
              class="input-sm"
              :disabled="followMain || !loaded"
              @update:value="v => v != null && debouncedSave('protect_first_n', v)"
            />
          </SettingRow>
        </section>
      </div>
    </div>
  </NModal>
</template>

<style scoped lang="scss">
.settings-section {
  margin-top: 16px;
}

.mcu-device-dialog {
  width: min(880px, calc(100vw - 48px));
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

.mcu-device-table {
  flex: 1 1 auto;
  min-height: 0;
  padding: 12px 18px;
  overflow: hidden;
}

@media (max-width: 640px) {
  .mcu-device-dialog {
    width: calc(100vw - 24px);
  }
}
</style>
