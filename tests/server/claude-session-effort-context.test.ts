import { describe, expect, it, vi } from 'vitest'
import '../../packages/server/src/bootstrap/coding-agent-adapters'
import {
  CodingAgentRunManager,
  claudeSessionEffortArgs,
  claudeUsageContextTokens,
} from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { createSession, getSession, updateSession } from '../../packages/server/src/modules/studio/repositories/session-store'
import { recordSessionUsage } from '../../packages/server/src/modules/studio/public/usage'
import { loadSessionStateFromDb } from '../../packages/server/src/modules/studio/services/chat-run/load-state'

const suffix = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

function claudeSession(id: string, reasoningEffort = '') {
  createSession({ id, profile: 'default', source: 'coding_agent', agent: 'claude', agent_mode: 'global', model: 'claude-opus-5-5', provider: 'global', reasoning_effort: reasoningEffort, title: '' } as any)
}

describe('Claude per-conversation effort and context size (v0.4.5)', () => {
  it('context size of one call is fresh input + cache read + cache write + output', () => {
    expect(claudeUsageContextTokens({ input_tokens: 12, cache_read_input_tokens: 270_000, cache_creation_input_tokens: 5_000, output_tokens: 828 })).toBe(275_840)
    expect(claudeUsageContextTokens({ input_tokens: 3, output_tokens: -1, cache_read_input_tokens: null })).toBe(3)
    expect(claudeUsageContextTokens(undefined)).toBe(0)
  })

  it('a conversation effort overrides the global one through flag settings; empty follows global', () => {
    initAllHermesTables()
    const id = `claude-effort-${suffix()}`
    claudeSession(id, 'low')
    const run = (mode: string, agentId = 'claude-code') => ({ launch: { agentId, mode, sessionId: id } })
    expect(claudeSessionEffortArgs(run('global'))).toEqual(['--settings', '{"env":{"CLAUDE_CODE_EFFORT_LEVEL":"low"}}'])
    // Read on every turn: a change in the chat applies to the next message of the same run.
    updateSession(id, { reasoning_effort: 'max' })
    expect(claudeSessionEffortArgs(run('global'))).toEqual(['--settings', '{"env":{"CLAUDE_CODE_EFFORT_LEVEL":"max"}}'])
    for (const effort of ['', 'none', 'minimal', 'bogus']) {
      updateSession(id, { reasoning_effort: effort })
      expect(claudeSessionEffortArgs(run('global'))).toEqual([])
    }
    updateSession(id, { reasoning_effort: 'high' })
    expect(claudeSessionEffortArgs(run('scoped'))).toEqual([])
    expect(claudeSessionEffortArgs(run('global', 'codex'))).toEqual([])
  })

  it('shows and persists the last API call context instead of the run-level input + output', async () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const agentSessionId = `agent-ctx-${suffix()}`
    const chatSessionId = `chat-ctx-${suffix()}`
    claudeSession(chatSessionId)
    const emitted = vi.fn()
    ;(manager as any).emitToChat = emitted
    manager.start({
      agentSessionId, agentId: 'claude-code', mode: 'global', profile: 'default', provider: 'global', model: 'claude-opus-5-5',
      sessionId: chatSessionId, command: 'claude', args: [], shellCommand: 'claude', workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] } as any,
    })
    const run = (manager as any).runs.get(agentSessionId)
    const assistant = (usage: any) => JSON.stringify({ type: 'assistant', message: { id: 'm', role: 'assistant', content: [], usage } })
    ;(manager as any).handleClaudePrintLine(run, assistant({ input_tokens: 5, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0, output_tokens: 50 }))
    ;(manager as any).handleClaudePrintLine(run, assistant({ input_tokens: 12, cache_read_input_tokens: 270_000, cache_creation_input_tokens: 5_000, output_tokens: 828 }))
    // The run-level usage row (what the UI used to show): 12 + 5,100 = 5.1K.
    recordSessionUsage({ sessionId: chatSessionId, runId: `run-${suffix()}`, source: 'coding_agent', agent: 'claude_code', usageScope: 'run',
      usage: { input_tokens: 12, output_tokens: 5_100, cache_read_input_tokens: 1_300_000, cache_creation_input_tokens: 250_000 }, profile: 'default', model: 'claude-opus-5-5', provider: 'global', isEstimated: false } as any)
    await (manager as any).refreshCodingAgentUsage(run)

    expect(getSession(chatSessionId)?.context_tokens).toBe(275_840)
    const contextEvents = emitted.mock.calls.filter(([, event, payload]) => event === 'usage.updated' && payload?.contextTokens != null)
    expect(contextEvents.at(-1)?.[2].contextTokens).toBe(275_840)
    // A reloaded page reads the stored value.
    const reloaded = await loadSessionStateFromDb(chatSessionId, new Map())
    expect(reloaded.contextTokens).toBe(275_840)
  })

  it('a Claude turn without any API call keeps the stored context instead of the run-level fallback', async () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const agentSessionId = `agent-noapi-${suffix()}`
    const chatSessionId = `chat-noapi-${suffix()}`
    claudeSession(chatSessionId)
    updateSession(chatSessionId, { context_tokens: 28_831 })
    const emitted = vi.fn()
    ;(manager as any).emitToChat = emitted
    manager.start({
      agentSessionId, agentId: 'claude-code', mode: 'global', profile: 'default', provider: 'global', model: 'claude-opus-5-5',
      sessionId: chatSessionId, command: 'claude', args: [], shellCommand: 'claude', workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] } as any,
    })
    const run = (manager as any).runs.get(agentSessionId)
    // A failed host compaction: only the wrapper progress line, no assistant usage.
    ;(manager as any).handleClaudePrintLine(run, JSON.stringify({ type: 'system', subtype: 'host_compaction', status: 'started', pre_tokens: 28_827 }))
    recordSessionUsage({ sessionId: chatSessionId, runId: `run-${suffix()}`, source: 'coding_agent', agent: 'claude_code', usageScope: 'run',
      usage: { input_tokens: 12, output_tokens: 17 }, profile: 'default', model: 'claude-opus-5-5', provider: 'global', isEstimated: false } as any)
    await (manager as any).refreshCodingAgentUsage(run)

    expect(emitted.mock.calls.filter(([, event, payload]) => event === 'usage.updated' && payload?.contextTokens != null)).toEqual([])
    expect(getSession(chatSessionId)?.context_tokens).toBe(28_831)
  })
})
