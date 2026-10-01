// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mockProfilesApi = vi.hoisted(() => ({
  fetchProfiles: vi.fn(),
  fetchProfileDetail: vi.fn(),
  createProfile: vi.fn(),
  deleteProfile: vi.fn(),
  renameProfile: vi.fn(),
  switchProfile: vi.fn(),
  switchHermesProfile: vi.fn(),
  exportProfile: vi.fn(),
  importProfile: vi.fn(),
  updateProfileAvatar: vi.fn(),
  deleteProfileAvatar: vi.fn(),
}))

vi.mock('@/api/hermes/profiles', () => mockProfilesApi)
vi.mock('@/api/agent-status', () => ({ fetchAgentStatusSnapshot: vi.fn() }))

import { useProfilesStore } from '@/stores/hermes/profiles'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

describe('profiles store fetch dedup', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('shares one in-flight request across concurrent fetchProfiles calls', async () => {
    const pending = deferred<any[]>()
    mockProfilesApi.fetchProfiles.mockReturnValue(pending.promise)
    const store = useProfilesStore()

    const first = store.fetchProfiles()
    const second = store.fetchProfiles()
    const third = store.fetchProfiles()

    expect(mockProfilesApi.fetchProfiles).toHaveBeenCalledTimes(1)
    expect(store.loading).toBe(true)

    pending.resolve([{ name: 'default', active: true, model: 'm', alias: '' }])
    await Promise.all([first, second, third])

    expect(store.profiles).toHaveLength(1)
    expect(store.activeProfileName).toBe('default')
    expect(store.loading).toBe(false)

    // Once settled, a new call issues a fresh request.
    mockProfilesApi.fetchProfiles.mockResolvedValue([{ name: 'default', active: true, model: 'm', alias: '' }])
    await store.fetchProfiles()
    expect(mockProfilesApi.fetchProfiles).toHaveBeenCalledTimes(2)
  })

  it('ensureProfiles reuses the in-flight request and skips the network once loaded', async () => {
    const pending = deferred<any[]>()
    mockProfilesApi.fetchProfiles.mockReturnValue(pending.promise)
    const store = useProfilesStore()

    const first = store.fetchProfiles()
    const ensured = store.ensureProfiles()
    expect(mockProfilesApi.fetchProfiles).toHaveBeenCalledTimes(1)

    pending.resolve([{ name: 'default', active: true, model: 'm', alias: '' }])
    await Promise.all([first, ensured])

    await store.ensureProfiles()
    expect(mockProfilesApi.fetchProfiles).toHaveBeenCalledTimes(1)
  })

  it('ensureProfiles fetches when nothing is loaded yet', async () => {
    mockProfilesApi.fetchProfiles.mockResolvedValue([{ name: 'default', active: true, model: 'm', alias: '' }])
    const store = useProfilesStore()
    await store.ensureProfiles()
    expect(mockProfilesApi.fetchProfiles).toHaveBeenCalledTimes(1)
    expect(store.profiles).toHaveLength(1)
  })
})
