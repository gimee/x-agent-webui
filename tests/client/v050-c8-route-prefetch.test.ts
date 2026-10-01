// hermes-v050:C8 首屏路由组件与语言包并行：只调用懒加载函数，不碰已解析的组件对象，解析失败不抛。
import { describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { prefetchRouteComponents } from '@/router/prefetch'

describe('prefetchRouteComponents', () => {
  it('starts the lazy chunk for the initial hash route only', async () => {
    const chat = vi.fn(async () => ({ default: defineComponent({ render: () => null }) }))
    const settings = vi.fn(async () => ({ default: defineComponent({ render: () => null }) }))
    const Eager = defineComponent({ name: 'Eager', render: () => null })
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/hermes/chat/:id?', component: chat },
        { path: '/hermes/settings', component: settings },
        { path: '/eager', component: Eager },
      ],
    })
    prefetchRouteComponents(router, '#/hermes/chat/abc?profile=default')
    expect(chat).toHaveBeenCalledTimes(1)
    expect(settings).not.toHaveBeenCalled()

    expect(() => prefetchRouteComponents(router, '#/eager')).not.toThrow()
    expect(() => prefetchRouteComponents(router, '')).not.toThrow()
    expect(() => prefetchRouteComponents(router, '#/nope/%E0%A4%A')).not.toThrow()
  })

  it('skips auth-only routes while logged out but still prefetches public ones', () => {
    const chat = vi.fn(async () => ({ default: defineComponent({ render: () => null }) }))
    const login = vi.fn(async () => ({ default: defineComponent({ render: () => null }) }))
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/chat', component: chat }, { path: '/login', component: login, meta: { public: true } }],
    })
    prefetchRouteComponents(router, '#/chat', false)
    prefetchRouteComponents(router, '#/login', false)
    expect(chat).not.toHaveBeenCalled()
    expect(login).toHaveBeenCalledTimes(1)
  })

  it('swallows chunk load failures (the router reports them on navigation)', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('offline')))
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/x', component: failing }] })
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    prefetchRouteComponents(router, '#/x')
    await new Promise(resolve => setTimeout(resolve, 10))
    process.off('unhandledRejection', unhandled)
    expect(failing).toHaveBeenCalledTimes(1)
    expect(unhandled).not.toHaveBeenCalled()
  })
})
