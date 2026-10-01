// hermes-v050:U3/U16-T5 — 命令回执下发稳定 code，客户端按 i18n 渲染；message 保留英文供旧客户端回退。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const addMessageMock = vi.hoisted(() => vi.fn(() => 1))
const getSessionMock = vi.hoisted(() => vi.fn())
const updateSessionStatsMock = vi.hoisted(() => vi.fn())
const getOrCreateSessionMock = vi.hoisted(() => vi.fn(() => ({ messages: [], isWorking: false })))
const calcAndUpdateUsageMock = vi.hoisted(() => vi.fn())
const getModelContextLengthMock = vi.hoisted(() => vi.fn(() => 256_000))
const compactMock = vi.hoisted(() => vi.fn())
const getRunInfoMock = vi.hoisted(() => vi.fn())
const getPiSessionStatsMock = vi.hoisted(() => vi.fn())
const getPiSessionStateMock = vi.hoisted(() => vi.fn())
const stopMock = vi.hoisted(() => vi.fn(() => true))
const startCodingAgentRunMock = vi.hoisted(() => vi.fn(async () => ({ agentSessionId: 'agent-session-1' })))
const compactStoredCodingAgentSessionMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  addMessage: addMessageMock,
  getSession: getSessionMock,
  updateSessionStats: updateSessionStatsMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/run-state', () => ({
  getOrCreateSession: getOrCreateSessionMock,
  calcAndUpdateUsage: calcAndUpdateUsageMock,
  updateContextTokenUsage: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({
  getModelContextLength: getModelContextLengthMock,
}))

vi.mock('../../packages/server/src/modules/coding-agents/services/runtime/run-manager', () => ({
  codingAgentRunManager: {
    compact: compactMock,
    getRunInfo: getRunInfoMock,
    getPiSessionStats: getPiSessionStatsMock,
    getPiSessionState: getPiSessionStateMock,
    stop: stopMock,
  },
}))

vi.mock('../../packages/server/src/modules/coding-agents/services/index', () => ({
  startCodingAgentRun: startCodingAgentRunMock,
  compactStoredCodingAgentSession: compactStoredCodingAgentSessionMock,
}))

function makeSocket() {
  const emitted: Array<{ event: string; payload: any }> = []
  return {
    emitted,
    socket: {
      id: 'socket-1',
      connected: true,
      join: vi.fn(),
      emit: (event: string, payload: any) => emitted.push({ event, payload }),
    },
    nsp: {
      adapter: { rooms: new Map() },
      to: () => ({
        emit: () => {},
      }),
    } as any,
  }
}

describe('hermes-v050:U3 coding agent command receipts carry stable codes for client i18n', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    addMessageMock.mockReturnValue(1)
    getOrCreateSessionMock.mockReturnValue({ messages: [], isWorking: false })
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 10, outputTokens: 20 })
    getModelContextLengthMock.mockReturnValue(256_000)
  })

  async function run(command: 'compact' | 'context' | 'usage', args = '') {
    const { handleCodingAgentSessionCommand } = await import('../../packages/server/src/modules/coding-agents/services/session-command')
    const { socket, nsp, emitted } = makeSocket()
    await handleCodingAgentSessionCommand(nsp, socket as any, { session_id: 'session-1' }, { name: command, rawName: command, args }, 'default', new Map())
    return emitted.filter(item => item.event === 'session.command').map(item => item.payload)
  }

  it('tags the /compact sent receipt with compact_sent + agentId and keeps the English message for old clients', async () => {
    compactMock.mockResolvedValue({ started: true })
    getSessionMock.mockReturnValue({ id: 'session-1', agent: 'claude' })
    const commands = await run('compact')
    expect(commands[0]).toMatchObject({ action: 'compact', messageCode: 'compact_sent', agentId: 'claude', message: 'Native /compact sent to Claude Code.' })
  })

  it('tags compaction results with before/after numbers', async () => {
    compactMock.mockResolvedValue({ compacted: true, beforeTokens: 500, afterTokens: 200 })
    getSessionMock.mockReturnValue({ id: 'session-1', agent: 'codex' })
    const commands = await run('compact')
    expect(commands[0]).toMatchObject({ messageCode: 'compact_sent', agentId: 'codex' })
    expect(commands.at(-1)).toMatchObject({ messageCode: 'compact_done', compacted: true, beforeTokens: 500, afterTokens: 200 })
    expect(commands.at(-1)?.message).toBe('Compaction completed. Before: 500 tokens. After: 200 tokens.')

    compactMock.mockResolvedValue({ compacted: false })
    const unchanged = await run('compact')
    expect(unchanged.at(-1)).toMatchObject({ messageCode: 'compact_no_change', compacted: false })
  })

  it('tags compaction failures with the raw error detail', async () => {
    compactMock.mockRejectedValue(new Error('native compact unsupported'))
    getSessionMock.mockReturnValue({ id: 'session-1', agent: 'codex' })
    const commands = await run('compact')
    expect(commands.at(-1)).toMatchObject({ ok: false, messageCode: 'compact_failed', error: 'native compact unsupported', message: 'Compaction failed: native compact unsupported' })
  })

  it('tags context / usage receipts and their lookup failures', async () => {
    getSessionMock.mockReturnValue({ id: 'session-1', agent: 'claude' })
    expect((await run('context')).at(-1)).toMatchObject({ messageCode: 'context', inputTokens: 10, outputTokens: 20, totalTokens: 30, contextWindow: 256_000 })
    expect((await run('usage')).at(-1)).toMatchObject({ messageCode: 'usage', inputTokens: 10, outputTokens: 20, totalTokens: 30 })
    calcAndUpdateUsageMock.mockRejectedValue(new Error('db locked'))
    expect((await run('context')).at(-1)).toMatchObject({ ok: false, messageCode: 'context_failed', error: 'db locked' })
    expect((await run('usage')).at(-1)).toMatchObject({ ok: false, messageCode: 'usage_failed', error: 'db locked' })
  })

  it('tags Pi native context / usage receipts', async () => {
    getSessionMock.mockReturnValue({ id: 'session-1', agent: 'pi' })
    getRunInfoMock.mockReturnValue({ exists: true, agentId: 'pi' })
    getPiSessionStatsMock.mockResolvedValue({
      tokens: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, total: 155 },
      cost: 0.25,
      contextUsage: { tokens: 40_000, contextWindow: 200_000, percent: 20 },
    })
    expect((await run('context')).at(-1)).toMatchObject({ messageCode: 'context_pi', contextTokens: 40_000, contextWindow: 200_000, contextPercent: 20 })
    expect((await run('usage')).at(-1)).toMatchObject({ messageCode: 'usage_pi', totalTokens: 155, cacheReadTokens: 30 })
  })
})
