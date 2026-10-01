// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// hermes-v050:S6 — the chat store polls the session list with fields=lite.
// The lite projection must not lose anything the store derives from a row.

const sessionApi = vi.hoisted(() => ({
  fetchSessions: vi.fn(),
}))

vi.mock('@/api/studio/sessions', () => ({
  archiveSession: vi.fn(),
  fetchSessions: sessionApi.fetchSessions,
  fetchSessionMessagesPage: vi.fn(),
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []),
  fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  deleteSession: vi.fn(),
  setSessionModel: vi.fn(),
}))

vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: vi.fn(() => ({ abort: vi.fn() })),
  resumeSession: vi.fn((_sessionId: string, cb: (data: any) => void) => {
    cb({ session_id: _sessionId, isWorking: false, messages: [] })
  }),
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

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default',
  hasApiKey: () => false,
}))

vi.mock('@/api/studio/download', () => ({
  getDownloadUrl: (_path: string, name: string) => `/download/${name}`,
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

vi.mock('@/utils/completion-notification', () => ({
  showCompletionNotification: vi.fn(),
}))

vi.mock('@/utils/session-sync', () => ({
  subscribeSessionSync: vi.fn(() => vi.fn()),
  publishSessionSync: vi.fn(),
}))

import { useChatStore } from '@/stores/hermes/chat'
import { SESSION_LIST_LITE_FIELDS, toSessionListLiteRow } from '../../packages/server/src/modules/studio/contracts/session-list'

// Every column of GET /api/studio/sessions with a non-default value.
function fullRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    profile: 'research',
    source: 'coding_agent',
    agent: 'claude',
    agent_mode: 'global',
    agent_session_id: `agent-${id}`,
    agent_native_session_id: `native-${id}`,
    user_id: '7',
    model: 'claude-opus-5-5',
    provider: '',
    api_mode: 'anthropic_messages',
    reasoning_effort: 'high',
    context_tokens: 123456,
    title: `Title ${id}`,
    parent_session_id: 'parent-1',
    fork_point_message_id: '42',
    started_at: 1_700_000_000,
    ended_at: 1_700_000_500,
    end_reason: 'abort',
    message_count: 17,
    tool_call_count: 5,
    input_tokens: 1000,
    output_tokens: 2000,
    cache_read_tokens: 300,
    cache_write_tokens: 400,
    reasoning_tokens: 50,
    billing_provider: 'anthropic-billing',
    estimated_cost_usd: 1.25,
    actual_cost_usd: 1.5,
    cost_status: 'estimated',
    preview: 'first user message preview',
    last_active: 1_700_000_900,
    is_archived: 0,
    push_enabled: 1,
    workspace: `/home/agent/work/${id}`,
    history_revision: 3,
    parent_title: 'Parent title',
    parent_last_message: 'last parent message',
    parent_last_message_role: 'assistant',
    ...overrides,
  }
}

function rows() {
  return [
    fullRow('a'),
    fullRow('b', { source: 'cli', agent: 'hermes', agent_mode: '', provider: 'openrouter', parent_session_id: null, fork_point_message_id: null, parent_title: null, parent_last_message: null, parent_last_message_role: null, ended_at: null, push_enabled: 0, last_active: 1_700_000_800 }),
    fullRow('c', { source: 'global_agent', agent: 'codex', last_active: 1_700_000_700 }),
    fullRow('d', { source: 'api_server', agent: 'pi', agent_mode: 'scoped', is_archived: 1, last_active: 1_700_000_600 }),
  ]
}

async function storeSessionsFrom(list: any[]) {
  setActivePinia(createPinia())
  sessionApi.fetchSessions.mockReset()
  sessionApi.fetchSessions.mockResolvedValueOnce(list).mockResolvedValueOnce([])
  const store = useChatStore()
  await store.loadSessions()
  sessionApi.fetchSessions.mockResolvedValueOnce(list).mockResolvedValueOnce([])
  await store.refreshSessionListOnly()
  return JSON.parse(JSON.stringify(store.sessions))
}

describe('hermes-v050:S6 chat store session list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('requests the lite projection for both runtime session lists', async () => {
    setActivePinia(createPinia())
    sessionApi.fetchSessions.mockResolvedValue([])
    const store = useChatStore()
    await store.loadSessions()
    expect(sessionApi.fetchSessions).toHaveBeenCalledWith(undefined, undefined, undefined, { fields: 'lite' })
    expect(sessionApi.fetchSessions).toHaveBeenCalledWith('global_agent', undefined, undefined, { fields: 'lite' })
  })

  it('builds identical sidebar sessions from lite rows and from full rows', async () => {
    const lite = rows().map(row => toSessionListLiteRow(row as any))
    expect(Object.keys(lite[0]).sort()).toEqual([...SESSION_LIST_LITE_FIELDS].sort())
    const fromFull = await storeSessionsFrom(rows())
    const fromLite = await storeSessionsFrom(lite)
    expect(fromFull.length).toBe(4)
    expect(fromLite).toEqual(fromFull)
  })
})

describe('hermes-v050:S6 fetchSessions', () => {
  it('adds fields=lite to the list request', async () => {
    const requests: string[] = []
    vi.resetModules()
    vi.doMock('@/api/client', () => ({
      request: vi.fn(async (path: string) => { requests.push(path); return { sessions: [] } }),
      getApiKey: () => '',
      getBaseUrlValue: () => '',
    }))
    const api = await vi.importActual<typeof import('@/api/studio/sessions')>('@/api/studio/sessions')
    await api.fetchSessions(undefined, undefined, undefined, { fields: 'lite' })
    await api.fetchSessions('global_agent', undefined, 'travel', { fields: 'lite' })
    await api.fetchSessions(undefined, 8)
    expect(requests).toEqual([
      '/api/studio/sessions?fields=lite',
      '/api/studio/sessions?source=global_agent&profile=travel&fields=lite',
      '/api/studio/sessions?limit=8',
    ])
    vi.doUnmock('@/api/client')
  })
})
