// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('naive-ui', () => ({ useMessage: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }) }))
vi.mock('@/api/client', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/client')>(),
  getApiKey: () => 'synthetic-image-token', getBaseUrlValue: () => '', getActiveProfileName: () => 'wrong-global-profile',
}))
vi.mock('@/components/hermes/chat/markdown-renderer-loader', async () => {
  const { default: renderer } = await import('@/components/hermes/chat/MarkdownRenderer.vue')
  return { AsyncMarkdownRenderer: renderer, resolvedMarkdownRenderer: () => renderer }
})
import MessageItem from '@/components/hermes/chat/MessageItem.vue'
import { useChatStore } from '@/stores/hermes/chat'
const wrappers: ReturnType<typeof mount>[] = []
function item(content: string, scope?: { id: string; profile: string }) {
  const wrapper = mount(MessageItem, { props: {
    message: { id: 'image-message', role: 'assistant', content, timestamp: 1 },
    ...(scope ? { imageSession: scope } : {}),
  } })
  wrappers.push(wrapper)
  return wrapper
}
describe('message-owned coding-agent image URLs', () => {
  beforeEach(() => { setActivePinia(createPinia()); useChatStore().activeSessionId = 'wrong-global-session' })
  afterEach(() => { wrappers.splice(0).forEach(w => w.unmount()) })
  it('uses the explicit owning session/profile and decodes a Markdown path once', async () => {
    const path = '/tmp/中文 image & 100% #1.png'
    const wrapper = item(`![local](<${path}>)\n\n![public](https://example.com/image.png)`, { id: 'owner/a', profile: 'research' })
    await flushPromises()
    const images = wrapper.findAll('.markdown-body img')
    expect(images).toHaveLength(2)
    const url = new URL(images[0].attributes('src'), 'http://local')
    expect(url.pathname).toBe('/api/studio/sessions/owner%2Fa/workspace-file/content')
    expect(url.searchParams.get('path')).toBe(path)
    expect(url.searchParams.get('profile')).toBe('research')
    expect(url.searchParams.get('token')).toBe('synthetic-image-token')
    expect(images[1].attributes('src')).toBe('https://example.com/image.png')
    await images[0].trigger('click')
    await flushPromises()
    expect(document.querySelector('.image-preview-overlay img')?.getAttribute('src')).toBe(new URL(images[0].attributes('src'), window.location.origin).href)
  })
  it('reacts to an owning scope change without reading the globally active chat', async () => {
    const wrapper = item('![local](/tmp/image.jpg)', { id: 'a', profile: 'default' })
    await wrapper.setProps({ imageSession: { id: 'b', profile: 'other' } } as any)
    await flushPromises()
    const url = new URL(wrapper.get('.markdown-body img').attributes('src'), 'http://local')
    expect(url.pathname).toBe('/api/studio/sessions/b/workspace-file/content')
    expect(url.searchParams.get('profile')).toBe('other')
  })
  it('unwraps an existing generic download image without carrying its old profile or token', async () => {
    const path = '/tmp/photo & #1.png'
    const original = '/api/studio/files/download?' + new URLSearchParams({ path, profile: 'stale', token: 'stale-token' })
    const wrapper = item(`![existing](<${original}>)`, { id: 'owner', profile: 'research' })
    await flushPromises()
    const url = new URL(wrapper.get('.markdown-body img').attributes('src'), 'http://local')
    expect(url.searchParams.get('path')).toBe(path)
    expect(url.searchParams.get('profile')).toBe('research')
    expect(url.searchParams.get('token')).toBe('synthetic-image-token')
  })
  it('keeps the generic download path when no coding-agent owner is supplied', async () => {
    const wrapper = item('![local](/home/agent/.hermes/image.jpg)')
    await flushPromises()
    expect(wrapper.get('.markdown-body img').attributes('src')).toContain('/api/studio/files/download?')
  })
})
