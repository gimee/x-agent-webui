import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { useProfilesStore } from './profiles'

const STAR_KEY_PREFIX = 'hermes_session_stars_v1_'
const HUMAN_ONLY_KEY_PREFIX = 'hermes_human_only_v1_'

function currentProfileName(): string {
  try {
    return useProfilesStore().activeProfileName || 'default'
  } catch {
    // Fallback during store initialization
    return localStorage.getItem('hermes_active_profile_name') || 'default'
  }
}

function starsKey(profileName: string): string {
  return `${STAR_KEY_PREFIX}${profileName}`
}

function humanOnlyKey(profileName: string): string {
  return `${HUMAN_ONLY_KEY_PREFIX}${profileName}`
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : fallback
  } catch {
    return fallback
  }
}

function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore quota/storage errors — fall back to in-memory only
  }
}

function loadStarredIds(profile: string): string[] {
  const value = loadJson<unknown>(starsKey(profile), [])
  return Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : []
}

export const useSessionBrowserPrefsStore = defineStore('session-browser-prefs', () => {
  const profileName = ref(currentProfileName())
  const starredIds = ref<string[]>(loadStarredIds(profileName.value))
  const humanOnly = ref<boolean>(loadJson<boolean>(humanOnlyKey(profileName.value), true))

  function reload() {
    profileName.value = currentProfileName()
    starredIds.value = loadStarredIds(profileName.value)
    humanOnly.value = loadJson<boolean>(humanOnlyKey(profileName.value), true)
  }

  function persistStars() {
    saveJson(starsKey(profileName.value), starredIds.value)
  }

  function persistHumanOnly() {
    saveJson(humanOnlyKey(profileName.value), humanOnly.value)
  }

  function isStarred(sessionId: string): boolean {
    return starredIds.value.includes(sessionId)
  }

  function toggleStarred(sessionId: string) {
    if (isStarred(sessionId)) {
      starredIds.value = starredIds.value.filter(id => id !== sessionId)
    } else {
      starredIds.value = [...starredIds.value, sessionId]
    }
    persistStars()
  }

  function removeStarred(sessionId: string): boolean {
    if (!isStarred(sessionId)) return false
    starredIds.value = starredIds.value.filter(id => id !== sessionId)
    persistStars()
    return true
  }

  function setHumanOnly(value: boolean) {
    if (humanOnly.value === value) return
    humanOnly.value = value
    persistHumanOnly()
  }

  watch(
    () => useProfilesStore().activeProfileName,
    () => reload(),
  )

  return {
    profileName,
    starredIds,
    humanOnly,
    reload,
    isStarred,
    toggleStarred,
    removeStarred,
    setHumanOnly,
  }
})
