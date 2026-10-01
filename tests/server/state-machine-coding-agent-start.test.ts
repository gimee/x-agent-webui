import { beforeEach, describe, expect, it, vi } from 'vitest'

// S-F9 companion: the socket `run` handler now marks coding-agent sessions
// as working before `handleCodingAgentRun` starts the runner, so the
// handler itself must release that flag when `startCodingAgentRun` throws.

const managerMock = vi.hoisted(() => ({
  runIdForSession: vi.fn(),
  isSessionLaunchCompatible: vi.fn(),
  isSessionProcessing: vi.fn(),
  stop: vi.fn(),
}))
const startCodingAgentRunMock = vi.hoisted(() => vi.fn())
const sendCodingAgentRunInputMock = vi.hoisted(() => vi.fn())
const writeModelRunProfileTokenMock = vi.hoisted(() => vi.fn(async () => undefined))
const getSessionMock = vi.hoisted(() => vi.fn())
const updateSessionMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/modules/studio/services/chat-run/model-run-prompt', () => ({
  writeModelRunProfileToken: writeModelRunProfileTokenMock,
}))
vi.mock('../../packages/server/src/modules/studio/public/runs/prompt', () => ({
  getSystemPrompt: vi.fn(() => 'system prompt'),
}))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSession: getSessionMock,
  updateSession: updateSessionMock,
}))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
  chatCodingAgentRunManager: managerMock,
  startChatCodingAgentRun: startCodingAgentRunMock,
  sendChatCodingAgentRunInput: sendCodingAgentRunInputMock,
  handleChatCodingAgentSessionCommand: vi.fn(async () => undefined),
  parseChatCodingAgentSessionCommand: vi.fn(() => null),
}))

describe('handleCodingAgentRun start failures', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSessionMock.mockReturnValue(null)
    managerMock.isSessionProcessing.mockReturnValue(false)
    managerMock.runIdForSession.mockReturnValue(undefined)
    managerMock.isSessionLaunchCompatible.mockReturnValue(true)
  })

  it('releases a session marked working by the socket layer when startCodingAgentRun throws', async () => {
    startCodingAgentRunMock.mockRejectedValue(new Error('spawn ENOENT'))
    const { handleCodingAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-coding-agent-run')
    const state = { messages: [], isWorking: true, isAborting: false, events: [], queue: [], runStartedAt: Date.now() }
    const sessionMap = new Map([['session-1', state]])
    const socket = { join: vi.fn(), emit: vi.fn() }

    await expect(handleCodingAgentRun({} as any, socket as any, {
      session_id: 'session-1', input: 'hello', coding_agent_id: 'codex',
    }, 'default', sessionMap as any)).rejects.toThrow('spawn ENOENT')

    expect(sendCodingAgentRunInputMock).not.toHaveBeenCalled()
    expect(state.isWorking).toBe(false)
    expect(state.runId).toBeUndefined()
    expect(state.activeRunMarker).toBeUndefined()
    expect(updateSessionMock).toHaveBeenCalledWith('session-1', expect.objectContaining({ end_reason: 'error' }))
  })

  it('keeps the session working when the runner is genuinely processing and send throws', async () => {
    managerMock.runIdForSession.mockReturnValue('agent-session-1')
    managerMock.isSessionProcessing.mockReturnValue(true)
    sendCodingAgentRunInputMock.mockRejectedValue(new Error('Codex is still processing the previous input'))
    const { handleCodingAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-coding-agent-run')
    const state = { messages: [], isWorking: true, isAborting: false, events: [], queue: [], runId: 'agent-session-1' }
    const sessionMap = new Map([['session-1', state]])
    const socket = { join: vi.fn(), emit: vi.fn() }

    await expect(handleCodingAgentRun({} as any, socket as any, {
      session_id: 'session-1', input: 'hello', coding_agent_id: 'codex',
    }, 'default', sessionMap as any)).rejects.toThrow('still processing')

    expect(state.isWorking).toBe(true)
    expect(state.runId).toBe('agent-session-1')
  })
})
