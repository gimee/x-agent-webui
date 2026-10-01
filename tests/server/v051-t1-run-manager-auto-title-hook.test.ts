// hermes-v051:T1 — run-manager 回合结束处唯一一处调用：run.completed（Claude/Codex/Pi 共用
// emitAndMarkPrintChatRunCompleted）后调度标题生成；run.failed 不调。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const scheduleMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/modules/coding-agents/services/runtime/auto-title', () => ({
  scheduleCodingAgentAutoTitle: scheduleMock,
}))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../packages/server/src/modules/studio/public/sessions', () => ({
  createSession: vi.fn(),
  addMessage: vi.fn(),
  getSession: vi.fn(() => ({ id: 'session-1' })),
  updateSession: vi.fn(),
  updateSessionStats: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/studio/public/usage', () => ({
  normalizeTokenUsage: vi.fn(() => ({ isEstimated: true })),
  recordSessionUsage: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/studio/public/run-state', () => ({
  applyResponseStreamEvent: vi.fn(() => null),
  flushResponseRunToDb: vi.fn(),
  extractResponseText: vi.fn(() => ''),
  calcAndUpdateUsage: vi.fn(async () => ({})),
  completeWorkspaceRunCheckpoint: vi.fn(),
  startWorkspaceRunCheckpoint: vi.fn(),
  getChatRunServer: () => null,
  getOrCreateSession: vi.fn(),
  updateContextTokenUsage: vi.fn(),
}))

import { CodingAgentRunManager } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'

function harness(agentId: string) {
  const manager = new CodingAgentRunManager()
  const run = {
    id: `run-${agentId}`,
    launch: { agentId, profile: 'research', sessionId: 'session-1', workspaceDir: process.cwd() },
    state: { messages: [], isWorking: true, events: [], queue: [] },
    exited: false,
  } as any
  const emitToChat = vi.fn()
  ;(manager as any).emitToChat = emitToChat
  ;(manager as any).markChatRunCompleted = vi.fn()
  ;(manager as any).completeWorkspaceRunDiff = vi.fn(() => null)
  ;(manager as any).startCodingAgentMemoryExport = vi.fn()
  ;(manager as any).cleanupRun = vi.fn()
  return { manager, run, emitToChat }
}

describe('hermes-v051:T1 run-manager schedules the coding-agent title after a completed turn', () => {
  beforeEach(() => scheduleMock.mockReset())

  for (const agentId of ['claude-code', 'codex', 'pi']) {
    it(`${agentId}: run.completed schedules one title attempt with the session route`, () => {
      const h = harness(agentId)
      ;(h.manager as any).emitAndMarkPrintChatRunCompleted(h.run, 'run.completed', { event: 'run.completed' })

      expect(scheduleMock).toHaveBeenCalledTimes(1)
      const [target, emit, messages] = scheduleMock.mock.calls[0]
      // hermes-v051:T1 R3-07: the turn's messages ride along so a retry can title from the latest user turn.
      expect(messages).toBe(h.run.state.messages)
      expect(target).toEqual(expect.objectContaining({ sessionId: 'session-1', profile: 'research', agentId }))
      emit('session-1', 'session.title.updated', { title: 't' })
      expect(h.emitToChat).toHaveBeenCalledWith('session-1', 'session.title.updated', { title: 't' })
    })
  }

  it('run.failed does not schedule a title', () => {
    const h = harness('claude-code')
    ;(h.manager as any).emitAndMarkPrintChatRunCompleted(h.run, 'run.failed', { event: 'run.failed' })
    expect(scheduleMock).not.toHaveBeenCalled()
  })
})
