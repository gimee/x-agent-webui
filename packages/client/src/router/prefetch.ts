import type { Router } from 'vue-router'

type LazyRouteComponent = () => Promise<unknown>

// 与 vue-router 判定「已解析组件」的口径一致：函数式组件/带编译选项的不是懒加载函数
function isLazyRouteComponent(component: unknown): component is LazyRouteComponent {
  return typeof component === 'function'
    && !('displayName' in component)
    && !('props' in component)
    && !('__vccOpts' in component)
}

/**
 * hermes-v050:C8 首屏路由组件与语言包并行下载：原来要等 i18n 就绪、router 安装后才开始拉
 * ChatView 等懒加载块。这里只「提前调用」懒加载函数，模块缓存保证导航时拿到同一个模块；
 * 需要登录的路由在未登录时不预取（守卫会跳登录页）；解析或加载失败都交给正常导航处理。
 */
export function prefetchRouteComponents(router: Router, hash: string, authenticated = true): void {
  try {
    const target = router.resolve(hash.replace(/^#/, '') || '/')
    if (!authenticated && !target.meta.public) return
    for (const record of target.matched) {
      for (const component of Object.values(record.components || {})) {
        if (!isLazyRouteComponent(component)) continue
        const pending = component()
        if (pending && typeof (pending as Promise<unknown>).catch === 'function') {
          ;(pending as Promise<unknown>).catch(() => undefined)
        }
      }
    }
  } catch {
    // 非法 hash 等：正常导航会给出同样的结果
  }
}
