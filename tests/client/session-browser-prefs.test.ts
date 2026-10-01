// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSessionBrowserPrefsStore } from '@/stores/hermes/session-browser-prefs'

describe('session browser prefs store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    window.localStorage.clear()
  })

  it('persists stars and only removes the explicitly unstarred session', () => {
    const store = useSessionBrowserPrefsStore()
    expect(store.starredIds).toEqual([])
    store.toggleStarred('session-1')
    store.toggleStarred('session-2')
    expect(store.isStarred('session-1')).toBe(true)
    expect(JSON.parse(localStorage.getItem('hermes_session_stars_v1_default')!)).toEqual(['session-1', 'session-2'])
    store.reload()
    expect(store.starredIds).toEqual(['session-1', 'session-2'])
    store.toggleStarred('session-1')
    expect(store.isStarred('session-1')).toBe(false)
    expect(store.removeStarred('session-2')).toBe(true)
    expect(store.removeStarred('missing')).toBe(false)
    expect(store.starredIds).toEqual([])
  })

  it('does not read or migrate the retired pin state', () => {
    localStorage.setItem('hermes_session_pins_v1_default', JSON.stringify(['old']))
    const store = useSessionBrowserPrefsStore()
    expect(store.starredIds).toEqual([])
    expect('pinnedIds' in store).toBe(false)
    expect('pruneMissingSessions' in store).toBe(false)
  })

  it('ignores invalid star storage values without breaking the list', () => {
    localStorage.setItem('hermes_session_stars_v1_default', '{"wrong": true}')
    const store = useSessionBrowserPrefsStore()
    expect(store.starredIds).toEqual([])
    localStorage.setItem('hermes_session_stars_v1_default', '["valid",null,1,"valid",""]')
    store.reload()
    expect(store.starredIds).toEqual(['valid'])
  })

  it('does not expose retired recent grouping preferences', () => {
    const store = useSessionBrowserPrefsStore()
    for (const key of ['recentCount', 'recentCollapsed', 'showRecentSessions', 'setRecentCount', 'setRecentCollapsed', 'setShowRecentSessions']) expect(key in store).toBe(false)
  })

  it('reloads star and human-only preferences automatically when the active profile changes', async () => {
    const profilesStore = useProfilesStore()
    profilesStore.activeProfileName = 'default'
    const store = useSessionBrowserPrefsStore()

    expect(store.humanOnly).toBe(true)
    store.toggleStarred('default-session')
    store.setHumanOnly(false)

    window.localStorage.setItem('hermes_session_stars_v1_work', JSON.stringify(['work-session']))
    window.localStorage.setItem('hermes_human_only_v1_work', JSON.stringify(true))

    profilesStore.activeProfileName = 'work'
    await nextTick()

    expect(store.profileName).toBe('work')
    expect(store.starredIds).toEqual(['work-session'])
    expect(store.humanOnly).toBe(true)

    profilesStore.activeProfileName = 'default'
    await nextTick()

    expect(store.starredIds).toEqual(['default-session'])
    expect(store.humanOnly).toBe(false)
  })
})
