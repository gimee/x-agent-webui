import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSessionMock = vi.fn()
const getSessionDetailPaginatedMock = vi.fn()
const estimateUsageTokensFromMessagesMock = vi.fn()
const getRecordedUsageTotalsMock = vi.fn()
const getUsageMock = vi.fn()

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSession: getSessionMock,
  getSessionDetailPaginated: getSessionDetailPaginatedMock,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/usage-store', () => ({
  getRecordedUsageTotals: getRecordedUsageTotalsMock,
  getUsage: getUsageMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  estimateUsageTokensFromMessages: estimateUsageTokensFromMessagesMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/message-format', () => ({
  handleMessage: vi.fn((messages: any[]) => messages),
}))

describe('loadSessionStateFromDb token estimation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSessionMock.mockReturnValue({ id: 'session-1', profile: 'default', source: 'cli' })
    getSessionDetailPaginatedMock.mockReturnValue({
      messages: [
        { role: 'user', content: 'a'.repeat(1000) },
        { role: 'assistant', content: 'b'.repeat(1000) },
      ],
      total: 2,
      hasMore: false,
      limit: 150,
    })
    estimateUsageTokensFromMessagesMock.mockReturnValue({ inputTokens: 111, outputTokens: 222 })
  })

  it('skips the tiktoken estimate when usage totals are already persisted', async () => {
    getRecordedUsageTotalsMock.mockReturnValue({ inputTokens: 5000, outputTokens: 700 })
    getUsageMock.mockReturnValue({ input_tokens: 4000, output_tokens: 600 })
    const { loadSessionStateFromDb } = await import('../../packages/server/src/modules/studio/services/chat-run/load-state')

    const state = await loadSessionStateFromDb('session-1', new Map())

    expect(estimateUsageTokensFromMessagesMock).not.toHaveBeenCalled()
    expect(state.inputTokens).toBe(5000)
    expect(state.outputTokens).toBe(700)
    expect(state.contextTokens).toBe(4600)
  })

  it('still estimates from the loaded page when nothing is persisted', async () => {
    getRecordedUsageTotalsMock.mockReturnValue({ inputTokens: 0, outputTokens: 0 })
    getUsageMock.mockReturnValue(undefined)
    const { loadSessionStateFromDb } = await import('../../packages/server/src/modules/studio/services/chat-run/load-state')

    const state = await loadSessionStateFromDb('session-1', new Map())

    expect(estimateUsageTokensFromMessagesMock).toHaveBeenCalledTimes(1)
    expect(state.inputTokens).toBe(111)
    expect(state.outputTokens).toBe(222)
    expect(state.contextTokens).toBeUndefined()
  })
})
