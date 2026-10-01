// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { config, flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/i18n/locales/en'
import DesktopTitleBar from '@/components/layout/DesktopTitleBar.vue'

// hermes-v050:U16-T30 window-control aria-labels now come from i18n.
config.global.plugins = [createI18n({ legacy: false, locale: 'en', messages: { en } })]

type DesktopBridge = {
  platform?: string
  getWindowState?: () => Promise<{ isMaximized: boolean }>
  windowControl?: (action: 'minimize' | 'toggle-maximize' | 'close') => Promise<{ isMaximized: boolean }>
}

function setDesktopBridge(bridge: DesktopBridge) {
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: bridge,
  })
}

describe('DesktopTitleBar', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete (window as typeof window & { hermesDesktop?: DesktopBridge }).hermesDesktop
  })

  it('does not render a custom title bar on Linux so native window controls remain visible', () => {
    setDesktopBridge({ platform: 'linux' })

    const wrapper = mount(DesktopTitleBar)

    expect(wrapper.find('.desktop-titlebar').exists()).toBe(false)
  })

  it('does not render custom chrome on macOS because native traffic lights sit in the sidebar', () => {
    setDesktopBridge({ platform: 'darwin' })

    const wrapper = mount(DesktopTitleBar)

    expect(wrapper.find('.desktop-titlebar').exists()).toBe(false)
  })

  it('renders custom window controls on Windows frameless windows', () => {
    setDesktopBridge({
      platform: 'win32',
      getWindowState: vi.fn().mockResolvedValue({ isMaximized: false }),
      windowControl: vi.fn().mockResolvedValue({ isMaximized: false }),
    })

    const wrapper = mount(DesktopTitleBar)

    expect(wrapper.find('.desktop-titlebar').exists()).toBe(true)
    expect(wrapper.findAll('.desktop-window-btn')).toHaveLength(3)
    expect(wrapper.find('.desktop-titlebar__brand').exists()).toBe(false)
  })

  it('keeps Windows controls interactive in the standalone control bar', async () => {
    const windowControl = vi.fn().mockResolvedValue({ isMaximized: true })
    setDesktopBridge({
      platform: 'win32',
      getWindowState: vi.fn().mockResolvedValue({ isMaximized: false }),
      windowControl,
    })

    const wrapper = mount(DesktopTitleBar)
    await flushPromises()
    await wrapper.findAll('.desktop-window-btn')[1].trigger('click')
    await flushPromises()

    expect(windowControl).toHaveBeenCalledWith('toggle-maximize')
    expect(wrapper.find('.desktop-window-btn[aria-label="Restore"]').exists()).toBe(true)
  })
})
