<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { NSelect, useMessage } from 'naive-ui'
import { switchLocale } from '@/i18n'
import { languageOptions } from '@/i18n/language-options'
import { reloadForLocaleUpdate } from '@/i18n/locale-load-recovery'

withDefaults(defineProps<{
  size?: 'tiny' | 'small' | 'medium' | 'large'
}>(), {
  size: 'tiny',
})

const { locale, t } = useI18n()
const message = useMessage()

async function handleChange(val: string) {
  try {
    await switchLocale(val)
  } catch (error) {
    // hermes-v050:F-17 不再静默失败：发版后旧页面的语言包已不存在时刷新一次进新版本，否则提示
    console.error('[i18n] failed to switch locale', error)
    if (reloadForLocaleUpdate(val, error, { from: locale.value })) {
      message.info(t('language.reloadingForUpdate'))
      return
    }
    message.error(t('language.switchFailed'))
  }
}
</script>

<template>
  <NSelect
    :value="locale"
    :options="languageOptions"
    :size="size"
    :consistent-menu-width="false"
    class="language-switch input-sm"
    @update:value="handleChange"
  />
</template>
