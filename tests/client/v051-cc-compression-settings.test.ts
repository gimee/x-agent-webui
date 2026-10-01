// @vitest-environment jsdom
// hermes-v051:C Agent 管理 → Claude → 压缩设置 dialog: follow switch + the five Settings → Context compression rows.
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ fetchCcCompression: vi.fn(), updateCcCompression: vi.fn() }))
const message = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock('@/api/hermes/cc-api', () => api)
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('naive-ui', () => ({
  NModal: defineComponent({
    name: 'NModal',
    props: { show: Boolean },
    emits: ['update:show'],
    template: '<div v-if="show" class="n-modal-stub"><slot /></div>',
  }),
  NSwitch: defineComponent({
    name: 'NSwitch',
    props: { value: Boolean, disabled: Boolean, size: String },
    emits: ['update:value'],
    template: '<button class="n-switch-stub" :disabled="disabled" @click="$emit(\'update:value\', !value)" />',
  }),
  NInputNumber: defineComponent({
    name: 'NInputNumber',
    props: { value: Number, min: Number, max: Number, step: Number, disabled: Boolean, size: String },
    emits: ['update:value'],
    template: '<input class="n-input-number-stub" :disabled="disabled" :value="value" @input="$emit(\'update:value\', Number($event.target.value))" />',
  }),
  useMessage: () => message,
}))

import CcCompressionSettings from '@/components/layout/CcCompressionSettings.vue'
import SettingRow from '@/components/hermes/settings/SettingRow.vue'

const OWN = { enabled: true, threshold: 0.3, target_ratio: 0.1, protect_last_n: 8, protect_first_n: 1 }
const MAIN = { enabled: false, threshold: 0.8, target_ratio: 0.5, protect_last_n: 30, protect_first_n: 4 }
const response = (follow: boolean) => ({ follow_main: follow, own: { ...OWN }, main: { ...MAIN }, effective: follow ? { ...MAIN } : { ...OWN } })

async function openDialog(follow: boolean) {
  api.fetchCcCompression.mockResolvedValue(response(follow))
  const wrapper = mount(CcCompressionSettings, {
    slots: { trigger: ({ open }: { open: () => void }) => h('button', { class: 'trigger', onClick: open }, 'open') },
  })
  expect(wrapper.find('.n-modal-stub').exists()).toBe(false)
  await wrapper.get('.trigger').trigger('click')
  await flushPromises()
  return wrapper
}

const rows = (wrapper: any) => wrapper.findAllComponents(SettingRow).map((row: any) => row.props('label'))
const switches = (wrapper: any) => wrapper.findAllComponents({ name: 'NSwitch' })
const numbers = (wrapper: any) => wrapper.findAllComponents({ name: 'NInputNumber' })

beforeEach(() => {
  api.fetchCcCompression.mockReset()
  api.updateCcCompression.mockReset()
  api.updateCcCompression.mockImplementation(async () => response(false))
  message.success.mockReset()
  message.error.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('hermes-v051:C CcCompressionSettings', () => {
  it('opens from the slotted trigger, loads settings and shows the follow row above the five copied rows', async () => {
    const wrapper = await openDialog(false)
    expect(api.fetchCcCompression).toHaveBeenCalledOnce()
    expect(wrapper.get('.mcu-device-title').text()).toBe('ccCompression.title')
    expect(rows(wrapper)).toEqual([
      'ccCompression.followMain',
      'settings.compression.enabled',
      'settings.compression.threshold',
      'settings.compression.targetRatio',
      'settings.compression.protectLastN',
      'settings.compression.protectFirstN',
    ])
    expect(wrapper.findAllComponents(SettingRow)[0].props('hint')).toBe('ccCompression.followMainHint')
    expect(numbers(wrapper).map((input: any) => [input.props('min'), input.props('max'), input.props('step')]))
      .toEqual([[0.1, 0.95, 0.05], [0.05, 0.8, 0.05], [0, 200, 1], [0, 50, 1]])
    await wrapper.get('.mcu-device-close').trigger('click')
    expect(wrapper.find('.n-modal-stub').exists()).toBe(false)
  })

  it('follow on: the five rows show the main settings values and are read-only', async () => {
    const wrapper = await openDialog(true)
    const [follow, enabled] = switches(wrapper)
    expect(follow.props('value')).toBe(true)
    expect(follow.props('disabled')).toBe(false)
    expect(enabled.props('value')).toBe(false)
    expect(enabled.props('disabled')).toBe(true)
    expect(numbers(wrapper).map((input: any) => input.props('value'))).toEqual([0.8, 0.5, 30, 4])
    expect(numbers(wrapper).every((input: any) => input.props('disabled'))).toBe(true)
  })

  it('follow off: the five rows show Claude\'s own values and are editable', async () => {
    const wrapper = await openDialog(false)
    const [follow, enabled] = switches(wrapper)
    expect(follow.props('value')).toBe(false)
    expect(enabled.props('value')).toBe(true)
    expect(enabled.props('disabled')).toBe(false)
    expect(numbers(wrapper).map((input: any) => input.props('value'))).toEqual([0.3, 0.1, 8, 1])
    expect(numbers(wrapper).some((input: any) => input.props('disabled'))).toBe(false)
  })

  it('switches save immediately and toast "saved"; turning follow on switches the rows to main values', async () => {
    const wrapper = await openDialog(false)
    switches(wrapper)[1].vm.$emit('update:value', false)
    expect(api.updateCcCompression).toHaveBeenLastCalledWith({ own: { enabled: false } })
    await flushPromises()
    expect(message.success).toHaveBeenLastCalledWith('settings.saved')

    switches(wrapper)[0].vm.$emit('update:value', true)
    expect(api.updateCcCompression).toHaveBeenLastCalledWith({ follow_main: true })
    await flushPromises()
    expect(message.success).toHaveBeenCalledTimes(2)
    expect(numbers(wrapper).map((input: any) => input.props('value'))).toEqual([0.8, 0.5, 30, 4])
    expect(numbers(wrapper).every((input: any) => input.props('disabled'))).toBe(true)
    expect(switches(wrapper)[1].props('disabled')).toBe(true)
  })

  it('number boxes save 300 ms after the last change', async () => {
    const wrapper = await openDialog(false)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    numbers(wrapper)[0].vm.$emit('update:value', 0.5)
    await vi.advanceTimersByTimeAsync(200)
    numbers(wrapper)[0].vm.$emit('update:value', 0.6)
    await wrapper.vm.$nextTick()
    expect(numbers(wrapper)[0].props('value')).toBe(0.6)
    await vi.advanceTimersByTimeAsync(299)
    expect(api.updateCcCompression).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(api.updateCcCompression).toHaveBeenCalledOnce()
    expect(api.updateCcCompression).toHaveBeenCalledWith({ own: { threshold: 0.6 } })
    await flushPromises()
    expect(message.success).toHaveBeenCalledWith('settings.saved')

    numbers(wrapper)[2].vm.$emit('update:value', 25)
    numbers(wrapper)[3].vm.$emit('update:value', 2)
    await vi.advanceTimersByTimeAsync(300)
    expect(api.updateCcCompression).toHaveBeenCalledWith({ own: { protect_last_n: 25 } })
    expect(api.updateCcCompression).toHaveBeenCalledWith({ own: { protect_first_n: 2 } })
  })

  it('a failed save toasts "save failed"; a failed load shows the error', async () => {
    const wrapper = await openDialog(false)
    api.updateCcCompression.mockRejectedValue(new Error('nope'))
    switches(wrapper)[0].vm.$emit('update:value', true)
    await flushPromises()
    expect(message.error).toHaveBeenLastCalledWith('settings.saveFailed')

    api.fetchCcCompression.mockRejectedValue(new Error('offline'))
    const failed = mount(CcCompressionSettings, {
      slots: { trigger: ({ open }: { open: () => void }) => h('button', { class: 'trigger', onClick: open }, 'open') },
    })
    await failed.get('.trigger').trigger('click')
    await flushPromises()
    expect(message.error).toHaveBeenLastCalledWith('offline')
  })
})
