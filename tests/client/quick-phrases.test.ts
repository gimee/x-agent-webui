// @vitest-environment jsdom
// Quick phrases regression suite.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { QUICK_PHRASES_STORAGE_KEY, useQuickPhrases } from '@/composables/useQuickPhrases'
import QuickPhraseBadge from '@/components/layout/QuickPhraseBadge.vue'
import QuickPhrasePicker from '@/components/hermes/chat/QuickPhrasePicker.vue'
import PageSidebarNav from '@/components/layout/PageSidebarNav.vue'

const mocks = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn(), dialog: vi.fn(), push: vi.fn() }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('@/api/client', () => ({ isStoredSuperAdmin: () => false }))
vi.mock('@/components/layout/CcApiBadge.vue', () => ({ default: { template: '<button class="cc-api-link" />' } }))
vi.mock('naive-ui', () => ({
  NButton: { template: '<button type="button"><slot /></button>' },
  NTooltip: { template: '<slot name="trigger" />' },
  NForm: { template: '<form><slot /></form>' },
  NFormItem: { template: '<div><slot /></div>' },
  NInput: {
    props: ['value'], emits: ['update:value'],
    template: '<textarea :value="value" @input="$emit(\'update:value\', $event.target.value)" />',
  },
  NModal: {
    props: ['show', 'preset'], emits: ['positive-click'],
    template: '<div v-if="show" class="modal-stub" :data-preset="preset"><slot /><button v-if="preset" class="positive" @click="$emit(\'positive-click\')">save</button></div>',
  },
  NPopover: {
    props: ['show'], emits: ['update:show'],
    template: '<div><div class="popover-trigger" @click="$emit(\'update:show\', !show)"><slot name="trigger" /></div><div v-if="show" class="popover-content"><slot /></div></div>',
  },
  useDialog: () => ({ warning: mocks.dialog }),
  useMessage: () => ({ warning: mocks.warning, error: mocks.error }),
}))

const api = useQuickPhrases()
beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  localStorage.clear()
  api.phrases.value = []
})

describe('quick phrase durable behavior', () => {
  it('adds, edits, reorders and deletes, reading every result from storage', () => {
    expect(api.addPhrase(' first ')).toBe(true)
    expect(api.addPhrase('second')).toBe(true)
    expect(api.addPhrase('third')).toBe(true)
    const [first, second, third] = api.phrases.value
    expect(api.updatePhrase(second.id, 'edited')).toBe(true)
    expect(api.reorderPhrase(third.id, first.id)).toBe(true)
    expect(JSON.parse(localStorage.getItem(QUICK_PHRASES_STORAGE_KEY)!)).toEqual(api.phrases.value)
    expect(api.phrases.value.map(item => item.phrase)).toEqual(['third', 'first', 'edited'])
    expect(api.removePhrase(first.id)).toBe(true)
    expect(JSON.parse(localStorage.getItem(QUICK_PHRASES_STORAGE_KEY)!).map((item: any) => item.phrase)).toEqual(['third', 'edited'])
  })

  it('rejects blank or missing entries without mutation', () => {
    expect(api.addPhrase('   ')).toBe(false)
    expect(api.updatePhrase('missing', 'x')).toBe(false)
    expect(api.reorderPhrase('missing', 'other')).toBe(false)
    expect(api.phrases.value).toEqual([])
    expect(localStorage.getItem(QUICK_PHRASES_STORAGE_KEY)).toBeNull()
  })

  it('does not report success or mutate state when storage fails', () => {
    api.addPhrase('original')
    const before = JSON.stringify(api.phrases.value)
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(api.addPhrase('not saved')).toBe(false)
    expect(JSON.stringify(api.phrases.value)).toBe(before)
  })

  it('reloads stored order after a storage event and clears after clear()', () => {
    const rows = [{ id: 'b', phrase: 'B', createdAt: 1 }, { id: 'a', phrase: 'A', createdAt: 2 }]
    localStorage.setItem(QUICK_PHRASES_STORAGE_KEY, JSON.stringify(rows))
    window.dispatchEvent(new StorageEvent('storage', { key: QUICK_PHRASES_STORAGE_KEY }))
    expect(api.phrases.value).toEqual(rows)
    localStorage.clear()
    window.dispatchEvent(new StorageEvent('storage', { key: null }))
    expect(api.phrases.value).toEqual([])
  })
})

describe('quick phrase component wiring', () => {
  it('moves search and quick phrases into the four-way switch and drops the tool strip (v0.1.2)', () => {
    const wrapper = mount(PageSidebarNav, { props: { active: 'chat' } })
    expect(wrapper.find('.quick-actions').exists()).toBe(false)
    expect(wrapper.findAll('.conversation-switch--four button')).toHaveLength(4)
    expect(wrapper.find('.conversation-switch--four [data-testid="nav-search"]').exists()).toBe(true)
    expect(wrapper.find('.conversation-switch--four [data-testid="nav-quick-phrases"]').exists()).toBe(true)
    expect(wrapper.find('.page-sidebar-tabs [aria-label="sidebar.search"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('adds and edits via the form, sorts from a handle, and confirms deletion', async () => {
    const wrapper = mount(QuickPhraseBadge)
    await wrapper.get('.quick-phrase-link').trigger('click')
    expect(wrapper.findAll('.quick-phrase-table-head span').map(item => item.text())).toEqual(['quickPhrases.phrase', 'quickPhrases.operation'])
    await wrapper.get('.mcu-device-actions button').trigger('click')
    await wrapper.get('textarea').setValue('Alpha')
    await wrapper.get('.positive').trigger('click')
    expect(api.phrases.value[0].phrase).toBe('Alpha')
    api.addPhrase('Beta')
    await nextTick()
    expect(wrapper.findAll('.quick-phrase-row[draggable]').length).toBe(0)
    await wrapper.findAll('.quick-phrase-drag-handle')[1].trigger('dragstart', { dataTransfer: { effectAllowed: '', setData: vi.fn() } })
    await wrapper.findAll('.quick-phrase-row')[0].trigger('drop')
    expect(api.phrases.value.map(item => item.phrase)).toEqual(['Beta', 'Alpha'])
    await wrapper.findAll('.quick-phrase-operation')[0].trigger('click')
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('Beta')
    await wrapper.get('textarea').setValue('Beta edited')
    await wrapper.get('.positive').trigger('click')
    await wrapper.findAll('.quick-phrase-operation.danger')[0].trigger('click')
    expect(api.phrases.value).toHaveLength(2) // cancel/no confirmation does not delete
    expect(mocks.dialog.mock.calls[0][0].onPositiveClick()).toBe(true)
    expect(api.phrases.value.map(item => item.phrase)).toEqual(['Alpha'])
    wrapper.unmount()
  })

  it('shows ordered phrases, emits the selected text and closes its picker', async () => {
    api.addPhrase('One')
    api.addPhrase('Two')
    const selectSpy = vi.fn()
    const wrapper = mount(QuickPhrasePicker, { attrs: { onSelect: selectSpy } })
    await wrapper.get('.quick-phrase-picker-button').trigger('click')
    expect(wrapper.findAll('.quick-phrase-picker-item').map(item => item.text())).toEqual(['One', 'Two'])
    await wrapper.findAll('.quick-phrase-picker-item')[1].trigger('click')
    expect(selectSpy).toHaveBeenCalledWith('Two')
    expect(wrapper.find('.popover-content').exists()).toBe(false)
    wrapper.unmount()
  })
})
