// hermes-v050:U16 — Pinia stores are not components, so they cannot call
// useI18n(). vue-i18n exposes the global `$t` / `$te` on the app's
// globalProperties; a store reaches that app through the component that
// created it or through the Pinia instance it is installed on. The lookup is
// lazy, and without an app i18n (unit tests, detached stores) the English
// literal is returned unchanged, which keeps the old behaviour.
import { getCurrentInstance, type App } from 'vue'
import { getActivePinia } from 'pinia'

export type StoreTranslate = (key: string, fallback: string, params?: Record<string, unknown>) => string

export function useStoreTranslate(): StoreTranslate {
  const app: App | undefined = getCurrentInstance()?.appContext.app
    ?? (getActivePinia() as { _a?: App } | undefined)?._a
  return (key, fallback, params) => {
    const globals = app?.config.globalProperties as Record<string, any> | undefined
    const t = globals?.$t
    const te = globals?.$te
    if (typeof t !== 'function' || typeof te !== 'function' || !te(key)) return fallback
    return params ? t(key, params) : t(key)
  }
}
