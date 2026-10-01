// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ChatView from '@/views/hermes/ChatView.vue'
import { useAppStore } from '@/stores/hermes/app'
import { useChatStore } from '@/stores/hermes/chat'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSettingsStore } from '@/stores/hermes/settings'

vi.mock('@/components/hermes/chat/ChatPanel.vue', () => ({
  default: {
    name: 'ChatPanel',
    props: { standalone: Boolean, contentMode: String },
    template: '<div data-testid="chat-panel" />',
  },
}))

const mockRoute = {
  name: 'hermes.chat' as string,
  params: {} as Record<string, string>,
  query: {} as Record<string, string>,
  meta: {} as Record<string, unknown>,
}

vi.mock('vue-router', () => ({
  useRoute: () => mockRoute,
  useRouter: () => ({ replace: vi.fn() }),
}))

vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: vi.fn(),
  resumeSession: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
  onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))

vi.mock('@/api/studio/sessions', () => ({
  archiveSession: vi.fn(),
  fetchSessions: vi.fn(),
  fetchSessionMessagesPage: vi.fn(),
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []),
  fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  deleteSession: vi.fn(),
  setSessionModel: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default',
}))

vi.mock('@/api/studio/download', () => ({
  getDownloadUrl: (_path: string, name: string) => `/download/${name}`,
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

vi.mock('@/utils/session-sync', () => ({
  subscribeSessionSync: vi.fn(() => vi.fn()),
  publishSessionSync: vi.fn(),
}))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(res => { resolve = res })
  return { promise, resolve }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('ChatView first-screen load order', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRoute.name = 'hermes.chat'
    mockRoute.params = {}
    mockRoute.query = {}
    mockRoute.meta = {}
    setActivePinia(createPinia())
    vi.spyOn(useAppStore(), 'loadModels').mockImplementation(() => undefined)
    vi.spyOn(useSettingsStore(), 'fetchSettings').mockResolvedValue(undefined as any)
  })

  it('starts loading sessions without waiting for the profiles request on the default route', async () => {
    const profilesStore = useProfilesStore()
    const chatStore = useChatStore()
    const pendingProfiles = deferred()
    vi.spyOn(profilesStore, 'fetchProfiles').mockReturnValue(pendingProfiles.promise)
    const loadSessions = vi.spyOn(chatStore, 'loadSessions').mockResolvedValue()

    const wrapper = mount(ChatView)
    await flush()

    // Profiles are still pending, sessions must already be requested.
    expect(profilesStore.fetchProfiles).toHaveBeenCalledTimes(1)
    expect(loadSessions).toHaveBeenCalledTimes(1)

    pendingProfiles.resolve()
    await flush()
    wrapper.unmount()
  })

  it('waits for profiles before loading sessions when the route pins a profile', async () => {
    mockRoute.query = { profile: 'work' }
    const profilesStore = useProfilesStore()
    const chatStore = useChatStore()
    const pendingProfiles = deferred()
    vi.spyOn(profilesStore, 'fetchProfiles').mockImplementation(async () => {
      await pendingProfiles.promise
      profilesStore.profiles = [
        { name: 'default', active: true, model: 'm', alias: '' },
        { name: 'work', active: false, model: 'm', alias: '' },
      ]
    })
    vi.spyOn(profilesStore, 'switchProfile').mockResolvedValue(true)
    const loadSessions = vi.spyOn(chatStore, 'loadSessions').mockResolvedValue()

    const wrapper = mount(ChatView)
    await flush()
    expect(loadSessions).not.toHaveBeenCalled()

    pendingProfiles.resolve()
    await flush()
    await flush()
    expect(profilesStore.switchProfile).toHaveBeenCalledWith('work')
    expect(chatStore.sessionProfileFilter).toBe('work')
    expect(loadSessions).toHaveBeenCalledTimes(1)
    expect(loadSessions).toHaveBeenCalledWith('work', null)
    wrapper.unmount()
  })

  it('drops a stale session profile filter and reloads sessions once profiles arrive', async () => {
    const profilesStore = useProfilesStore()
    const chatStore = useChatStore()
    chatStore.setSessionProfileFilter('deleted-profile')
    const pendingProfiles = deferred()
    vi.spyOn(profilesStore, 'fetchProfiles').mockImplementation(async () => {
      await pendingProfiles.promise
      profilesStore.profiles = [{ name: 'default', active: true, model: 'm', alias: '' }]
    })
    const loadSessions = vi.spyOn(chatStore, 'loadSessions').mockImplementation(async () => {
      chatStore.sessionsLoaded = true
    })

    const wrapper = mount(ChatView)
    await flush()
    expect(loadSessions).toHaveBeenCalledTimes(1)
    expect(loadSessions).toHaveBeenLastCalledWith('deleted-profile', null)

    pendingProfiles.resolve()
    await flush()
    await flush()
    expect(chatStore.sessionProfileFilter).toBeNull()
    expect(loadSessions).toHaveBeenCalledTimes(2)
    expect(loadSessions).toHaveBeenLastCalledWith(null, null)
    wrapper.unmount()
  })
})
