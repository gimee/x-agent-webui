// @vitest-environment jsdom
// hermes-v051:C R2-03 regression: load / debounce races in CcCompressionSettings (real component, API mocked).
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ fetchCcCompression: vi.fn(), updateCcCompression: vi.fn() }))
const message = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('@/api/hermes/cc-api', () => api)
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('naive-ui', () => ({
  NModal: defineComponent({ name: 'NModal', props: { show: Boolean }, emits: ['update:show'], template: '<div v-if="show"><slot /></div>' }),
  NSwitch: defineComponent({ name: 'NSwitch', props: { value: Boolean, disabled: Boolean, size: String }, emits: ['update:value'], template: '<button class="sw" :data-value="String(value)" :disabled="disabled" @click="$emit(\'update:value\', !value)" />' }),
  NInputNumber: defineComponent({ name: 'NInputNumber', props: { value: Number, min: Number, max: Number, step: Number, disabled: Boolean, size: String }, emits: ['update:value'], template: '<input class="num" :disabled="disabled" :value="value" @input="$emit(\'update:value\', Number($event.target.value))" />' }),
  useMessage: () => message,
}))
import CcCompressionSettings from '@/components/layout/CcCompressionSettings.vue'

const OWN = { enabled: true, threshold: 0.4, target_ratio: 0.08, protect_last_n: 20, protect_first_n: 3 }
const doc = (own = OWN, follow = false) => ({ follow_main: follow, own: { ...own }, main: { enabled: true, threshold: 0.5, target_ratio: 0.2, protect_last_n: 20, protect_first_n: 3 }, effective: { ...own } })
const mountIt = () => mount(CcCompressionSettings, { slots: { trigger: ({ open }: any) => h('button', { class: 'trigger', onClick: open }, 'open') } })

afterEach(() => { vi.useRealTimers(); api.fetchCcCompression.mockReset(); api.updateCcCompression.mockReset() })

describe('hermes-v051:C CcCompressionSettings load and debounce races (R2-03)', () => {
  it('controls stay read-only until the GET answers, so a stale GET never overwrites an edit', async () => {
    let resolveGet: (v: any) => void = () => {}
    api.fetchCcCompression.mockImplementation(() => new Promise(r => { resolveGet = r }))
    const w = mountIt()
    await w.get('.trigger').trigger('click')
    expect(w.findAll('.sw').map(s => s.attributes('disabled'))).toEqual(['', ''])
    expect(w.findAll('.num').every(n => n.attributes('disabled') !== undefined)).toBe(true)
    resolveGet(doc())
    await flushPromises()
    expect(w.findAll('.sw').map(s => s.attributes('disabled'))).toEqual([undefined, undefined])
    expect(w.findAll('.num').every(n => n.attributes('disabled') === undefined)).toBe(true)
  })

  it('reopening within 300 ms saves the pending edit before reading, and shows the saved value', async () => {
    vi.useFakeTimers()
    let stored = doc()
    api.fetchCcCompression.mockImplementation(async () => stored)
    api.updateCcCompression.mockImplementation(async (patch: any) => { stored = doc({ ...stored.own, ...patch.own }); return stored })
    const w = mountIt()
    await w.get('.trigger').trigger('click'); await flushPromises()
    await w.findAll('.num')[0].setValue('0.6')
    ;(w.vm as any).$.setupState.showModal = false
    await w.get('.trigger').trigger('click')
    await flushPromises()
    expect(api.updateCcCompression).toHaveBeenCalledWith({ own: { threshold: 0.6 } })
    expect(api.updateCcCompression.mock.invocationCallOrder[0]).toBeLessThan(api.fetchCcCompression.mock.invocationCallOrder.at(-1)!)
    expect((w.findAll('.num')[0].element as HTMLInputElement).value).toBe('0.6')
    vi.advanceTimersByTime(300); await flushPromises()
    expect(api.updateCcCompression).toHaveBeenCalledTimes(1)
  })

  it('a failed GET keeps every control read-only instead of showing editable defaults', async () => {
    api.fetchCcCompression.mockRejectedValue(new Error('HTTP 502'))
    const w = mountIt()
    await w.get('.trigger').trigger('click'); await flushPromises()
    expect(message.error).toHaveBeenCalledWith('HTTP 502')
    expect(w.findAll('.sw').map(s => s.attributes('disabled'))).toEqual(['', ''])
    expect(w.findAll('.num').every(n => n.attributes('disabled') !== undefined)).toBe(true)
  })
})
