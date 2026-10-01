// hermes-v051:B2 — Hermes 对话：压缩完成（含失败）5 秒后，压缩事件从补推（重放）列表删除。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getSessionMock = vi.fn()
const calcAndUpdateUsageMock = vi.fn()
const estimateUsageTokensFromMessagesMock = vi.fn()
const updateMessageContextTokenUsageMock = vi.fn((_sid: string, state: any, _emit: any, messageTokens: number) => {
  state.contextTokens = messageTokens
  return messageTokens
})
const compressorCompressMock = vi.fn()

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSessionDetail: vi.fn(),
  getSession: getSessionMock,
  getSessionContextMessages: vi.fn(() => []),
  getSessionContextMessage: vi.fn(() => null),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/compression-snapshot', () => ({
  getCompressionSnapshot: vi.fn(() => null),
}))

vi.mock('../../packages/server/src/modules/studio/services/context-compressor', () => ({
  SUMMARY_PREFIX: '[Previous context summary]',
  ChatContextCompressor: class {
    compress = compressorCompressMock
  },
}))

vi.mock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({
  getModelContextLength: vi.fn(() => 256_000),
}))

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  readConfigYamlForProfile: vi.fn(async () => ({})),
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bridgeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  calcAndUpdateUsage: calcAndUpdateUsageMock,
  estimateUsageTokensFromMessages: estimateUsageTokensFromMessagesMock,
  updateMessageContextTokenUsage: updateMessageContextTokenUsageMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/message-format', () => ({
  isAssistantMessageSendable: vi.fn(() => true),
}))

const history = Array.from({ length: 6 }, (_, index) => ({
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: `message ${index}`,
}))

async function runCompression(state: any) {
  const { compressHistory } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
  return compressHistory(
    history as any,
    null,
    'session-1',
    'http://upstream',
    undefined,
    state,
    160_000,
    vi.fn(),
    new Map([['session-1', state]]),
    { model: 'm', provider: 'p' },
  )
}

const replayed = (state: any) => state.events.map((entry: any) => entry.event)

describe('hermes-v051:B2 Hermes compression replay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSessionMock.mockReturnValue({ id: 'session-1', profile: 'default', history_revision: 0 })
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 1_000, outputTokens: 0 })
    estimateUsageTokensFromMessagesMock.mockReturnValue({ inputTokens: 900, outputTokens: 0 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('drops started/completed from the replay list 5s after a completed compression, keeping other events', async () => {
    vi.useFakeTimers()
    compressorCompressMock.mockResolvedValue({
      messages: [{ role: 'user', content: 'compressed' }],
      meta: { compressed: true, llmCompressed: true, totalMessages: 6, summaryTokenEstimate: 1, verbatimCount: 0, compressedStartIndex: 0 },
    })
    const state = { messages: [], isWorking: true, events: [{ event: 'tool.started', data: {} }], queue: [] }
    await runCompression(state)
    expect(replayed(state)).toEqual(['tool.started', 'compression.started', 'compression.completed'])

    vi.advanceTimersByTime(4_999)
    expect(replayed(state)).toEqual(['tool.started', 'compression.started', 'compression.completed'])
    vi.advanceTimersByTime(1)
    expect(replayed(state)).toEqual(['tool.started'])
  })

  it('drops a failed compression 5s later as well', async () => {
    vi.useFakeTimers()
    compressorCompressMock.mockRejectedValue(new Error('summary model timed out'))
    const state = { messages: [], isWorking: true, events: [], queue: [] }
    await runCompression(state)
    expect(state.events.at(-1)).toEqual({ event: 'compression.completed', data: expect.objectContaining({ compressed: false, error: 'summary model timed out' }) })
    vi.advanceTimersByTime(5_000)
    expect(replayed(state)).toEqual([])
  })
})
