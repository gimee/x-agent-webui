import { ref } from 'vue'

export type QuickPhrase = {
  id: string
  phrase: string
  createdAt: number
}

export const QUICK_PHRASES_STORAGE_KEY = 'hermes_quick_phrases_v1'

function readStoredPhrases(): QuickPhrase[] {
  if (typeof window === 'undefined') return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(QUICK_PHRASES_STORAGE_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is QuickPhrase => (
      item && typeof item.id === 'string' && typeof item.phrase === 'string' && item.phrase.trim().length > 0
    ))
  } catch {
    return []
  }
}

const phrases = ref<QuickPhrase[]>(readStoredPhrases())
let storageListenerInstalled = false

function commit(next: QuickPhrase[]): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (next.length) window.localStorage.setItem(QUICK_PHRASES_STORAGE_KEY, JSON.stringify(next))
    else window.localStorage.removeItem(QUICK_PHRASES_STORAGE_KEY)
    phrases.value = next
    return true
  } catch {
    return false
  }
}

function newId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function installStorageListener() {
  if (storageListenerInstalled || typeof window === 'undefined') return
  storageListenerInstalled = true
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== QUICK_PHRASES_STORAGE_KEY) return
    phrases.value = readStoredPhrases()
  })
}

export function useQuickPhrases() {
  installStorageListener()

  function addPhrase(phrase: string) {
    const value = phrase.trim()
    if (!value) return false
    return commit([...phrases.value, { id: newId(), phrase: value, createdAt: Date.now() }])
  }

  function updatePhrase(id: string, phrase: string) {
    const value = phrase.trim()
    if (!value) return false
    const index = phrases.value.findIndex(item => item.id === id)
    if (index < 0) return false
    const next = [...phrases.value]
    next[index] = { ...next[index], phrase: value }
    return commit(next)
  }

  function removePhrase(id: string) {
    return commit(phrases.value.filter(item => item.id !== id))
  }

  function reorderPhrase(fromId: string, toId: string) {
    if (fromId === toId) return true
    const fromIndex = phrases.value.findIndex(item => item.id === fromId)
    const toIndex = phrases.value.findIndex(item => item.id === toId)
    if (fromIndex < 0 || toIndex < 0) return false
    const next = [...phrases.value]
    const [moved] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, moved)
    return commit(next)
  }

  return { phrases, addPhrase, updatePhrase, removePhrase, reorderPhrase }
}
