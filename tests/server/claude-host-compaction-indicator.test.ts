import { describe, expect, it, vi } from 'vitest'
import '../../packages/server/src/bootstrap/coding-agent-adapters'
import { CodingAgentRunManager } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { createSession, getSession, updateSession } from '../../packages/server/src/modules/studio/repositories/session-store'

const suffix = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

describe('Claude host compaction indicator (v0.4.6)', () => {
  it('turns the wrapper progress lines into the Hermes compression events without touching native identity or text', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const agentSessionId = `agent-hostc-${suffix()}`
    const chatSessionId = `chat-hostc-${suffix()}`
    const nativeId = '11111111-1111-4111-8111-111111111111'
    createSession({ id: chatSessionId, profile: 'default', source: 'coding_agent', agent: 'claude', agent_mode: 'global', model: 'claude-opus-5-5', provider: 'global', title: '', agent_native_session_id: nativeId } as any)
    updateSession(chatSessionId, { message_count: 42 } as any)
    const emitted = vi.fn()
    ;(manager as any).emitToChat = emitted
    manager.start({
      agentSessionId, agentId: 'claude-code', mode: 'global', profile: 'default', provider: 'global', model: 'claude-opus-5-5',
      sessionId: chatSessionId, command: 'claude', args: [], shellCommand: 'claude', workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] } as any,
    })
    const run = (manager as any).runs.get(agentSessionId)
    const line = (fields: Record<string, unknown>) => (manager as any).handleClaudePrintLine(run, JSON.stringify({ type: 'system', subtype: 'host_compaction', ...fields }))

    line({ status: 'started', pre_tokens: 400_000 })
    line({ status: 'completed', pre_tokens: 400_000, post_tokens: 80_000 })
    line({ status: 'bogus', pre_tokens: 1 })

    // hermes-v051:B1 the estimate now shows on the context meter until the next API call
    // of the turn reports the real size (v0.5.1 plan B1 overturns the v0.4.6 rule).
    expect(emitted.mock.calls).toEqual([
      [chatSessionId, 'compression.started', { event: 'compression.started', message_count: 42, token_count: 400_000 }],
      [chatSessionId, 'usage.updated', { event: 'usage.updated', session_id: chatSessionId, inputTokens: 0, outputTokens: 0, contextTokens: 80_000 }],
      [chatSessionId, 'compression.completed', { event: 'compression.completed', compressed: true, totalMessages: 42, beforeTokens: 400_000, afterTokens: 80_000, contextTokens: 80_000 }],
    ])
    // The lines are not reply text.
    expect(run.printTextStarted).toBeFalsy()
    expect(getSession(chatSessionId)?.agent_native_session_id).toBe(nativeId)
  })
})
