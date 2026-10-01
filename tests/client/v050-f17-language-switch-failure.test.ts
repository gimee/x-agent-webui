// @vitest-environment jsdom
// hermes-v050:F-17 切换语言失败不能静默：
// - 发版后旧页面去加载已不存在的语言包（动态 import 失败）：Chrome 会把失败的模块缓存在 module map 里
//   （Q-3，真浏览器已核实：同一 URL 再 import 直接失败、不再发请求），页内重试无法恢复，所以记下所选语言、
//   自动刷新一次；同一标签页 60s 内不再自动刷新（防循环），改为提示。
// - 其它失败：提示切换失败，下拉框保持原语言。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'

const switchLocaleMock = vi.hoisted(() => vi.fn())
const messageMock = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }))

vi.mock('@/i18n', () => ({ switchLocale: switchLocaleMock }))
vi.mock('vue-i18n', () => ({
  useI18n: () => ({ locale: ref('zh'), t: (key: string) => key }),
}))
vi.mock('naive-ui', () => ({
  NSelect: defineComponent({
    name: 'NSelect',
    props: { value: String, options: Array },
    emits: ['update:value'],
    setup(props, { emit }) {
      return () => h('select', {
        class: 'language-select-stub',
        value: props.value,
        onChange: (event: Event) => emit('update:value', (event.target as HTMLSelectElement).value),
      }, (props.options as Array<{ value: string; label: string }> || []).map(option => h('option', { value: option.value }, option.label)))
    },
  }),
  useMessage: () => messageMock,
}))

import LanguageSwitch from '@/components/layout/LanguageSwitch.vue'
import { localeReloadRuntime, reloadForLocaleUpdate } from '@/i18n/locale-load-recovery'

const staleChunkError = () => new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1/assets/en-DEADBEEF.js')

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await nextTick()
    await Promise.resolve()
  }
}

async function pick(wrapper: ReturnType<typeof mount>, value: string) {
  const select = wrapper.get('select.language-select-stub')
  ;(select.element as HTMLSelectElement).value = value
  await select.trigger('change')
  await flush()
}

describe('language switch failures are reported (F-17)', () => {
  let reload: ReturnType<typeof vi.fn>
  let originalReload: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    switchLocaleMock.mockReset()
    for (const fn of Object.values(messageMock)) fn.mockReset()
    sessionStorage.clear()
    localStorage.clear()
    localStorage.setItem('hermes_locale', 'zh')
    reload = vi.fn()
    originalReload = localeReloadRuntime.reload
    localeReloadRuntime.reload = reload
  })

  afterEach(() => {
    vi.useRealTimers()
    localeReloadRuntime.reload = originalReload
  })

  it('reloads once into the chosen language when the locale chunk is gone after a deploy', async () => {
    switchLocaleMock.mockRejectedValue(staleChunkError())
    const wrapper = mount(LanguageSwitch)
    await pick(wrapper, 'en')
    expect(switchLocaleMock).toHaveBeenCalledWith('en')
    expect(messageMock.info).toHaveBeenCalledWith('language.reloadingForUpdate')
    expect(localStorage.getItem('hermes_locale')).toBe('en')
    // 记下刷新前的语言：新页面万一仍加载不了所选语言，退回它启动
    expect(JSON.parse(sessionStorage.getItem('hermes_locale_reload_at') || '{}')).toMatchObject({ from: 'zh', to: 'en' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(reload).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('does not reload in a loop: a second stale-chunk failure right after the reload only shows an error', async () => {
    switchLocaleMock.mockRejectedValue(staleChunkError())
    const first = mount(LanguageSwitch)
    await pick(first, 'en')
    await vi.advanceTimersByTimeAsync(1_000)
    first.unmount()
    // 刷新后的新页面（同一标签页，sessionStorage 还在）再次失败
    localStorage.setItem('hermes_locale', 'zh')
    const second = mount(LanguageSwitch)
    await pick(second, 'en')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(messageMock.error).toHaveBeenCalledWith('language.switchFailed')
    expect(localStorage.getItem('hermes_locale')).toBe('zh')
    second.unmount()
  })

  it('shows an error (no reload) for other failures, and nothing when the switch succeeds', async () => {
    switchLocaleMock.mockRejectedValueOnce(new Error('boom'))
    const wrapper = mount(LanguageSwitch)
    await pick(wrapper, 'ja')
    expect(messageMock.error).toHaveBeenCalledWith('language.switchFailed')
    expect(reload).not.toHaveBeenCalled()

    switchLocaleMock.mockResolvedValueOnce(undefined)
    messageMock.error.mockReset()
    await pick(wrapper, 'en')
    expect(messageMock.error).not.toHaveBeenCalled()
    expect(messageMock.info).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('recognises the dynamic-import failure messages of Chrome, Firefox and Safari only', () => {
    const now = () => 1_000_000
    for (const error of [
      new TypeError('Failed to fetch dynamically imported module: /assets/ja-1.js'),
      new TypeError('error loading dynamically imported module: /assets/ja-1.js'),
      new TypeError('Importing a module script failed.'),
    ]) {
      sessionStorage.clear()
      const doReload = vi.fn()
      expect(reloadForLocaleUpdate('ja', error, { reload: doReload, now, delayMs: 0 })).toBe(true)
    }
    sessionStorage.clear()
    expect(reloadForLocaleUpdate('ja', new Error('Unexpected token'), { reload: vi.fn(), now, delayMs: 0 })).toBe(false)
  })
})
