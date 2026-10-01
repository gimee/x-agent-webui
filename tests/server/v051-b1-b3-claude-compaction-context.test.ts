// hermes-v051:B1 / B3 — Claude 压缩后输入框上下文数字（估算 → 本轮每次 API 调用的真实值）与压缩失败提示。
import { describe, expect, it, vi } from 'vitest'
import '../../packages/server/src/bootstrap/coding-agent-adapters'
import { CodingAgentRunManager } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { createSession, getSession, updateSession } from '../../packages/server/src/modules/studio/repositories/session-store'
import { recordSessionUsage } from '../../packages/server/src/modules/studio/public/usage'

const suffix = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

function startClaudeRun() {
  initAllHermesTables()
  const manager = new CodingAgentRunManager()
  const agentSessionId = `agent-b1-${suffix()}`
  const chatSessionId = `chat-b1-${suffix()}`
  createSession({ id: chatSessionId, profile: 'default', source: 'coding_agent', agent: 'claude', agent_mode: 'global', model: 'claude-opus-5-5', provider: 'global', title: '' } as any)
  updateSession(chatSessionId, { message_count: 42, context_tokens: 450_000 } as any)
  const emitted = vi.fn()
  ;(manager as any).emitToChat = emitted
  manager.start({
    agentSessionId, agentId: 'claude-code', mode: 'global', profile: 'default', provider: 'global', model: 'claude-opus-5-5',
    sessionId: chatSessionId, command: 'claude', args: [], shellCommand: 'claude', workspaceDir: process.cwd(),
    state: { messages: [], isWorking: false, events: [], queue: [] } as any,
  })
  const run = (manager as any).runs.get(agentSessionId)
  const line = (event: Record<string, unknown>) => (manager as any).handleClaudePrintLine(run, JSON.stringify(event))
  const host = (fields: Record<string, unknown>) => line({ type: 'system', subtype: 'host_compaction', ...fields })
  const assistant = (usage: Record<string, number>, extra: Record<string, unknown> = {}) => line({
    type: 'assistant', parent_tool_use_id: null, ...extra,
    message: { id: String(extra.messageId || 'msg_1'), role: 'assistant', content: [], usage },
  })
  const contextUpdates = () => emitted.mock.calls
    .filter(([, event, payload]) => event === 'usage.updated' && payload?.contextTokens != null)
    .map(([, , payload]) => payload.contextTokens)
  const completed = () => emitted.mock.calls.filter(([, event]) => event === 'compression.completed').map(([, , payload]) => payload)
  const runLevelUsage = () => recordSessionUsage({ sessionId: chatSessionId, runId: `run-${suffix()}`, source: 'coding_agent', agent: 'claude_code', usageScope: 'run',
    usage: { input_tokens: 12, output_tokens: 17 }, profile: 'default', model: 'claude-opus-5-5', provider: 'global', isEstimated: false } as any)
  return { manager, run, chatSessionId, emitted, host, assistant, line, contextUpdates, completed, runLevelUsage }
}

describe('hermes-v051:B1 Claude context meter after a compaction', () => {
  it('host_compaction completed carries the estimate as contextTokens, pushes it as a usage update and stores it', () => {
    const { run, chatSessionId, host, contextUpdates, completed } = startClaudeRun()
    host({ status: 'started', pre_tokens: 450_000, summarizer: 'aux' })
    host({ status: 'completed', pre_tokens: 450_000, post_tokens: 80_000, summarizer: 'aux' })

    expect(completed()).toEqual([
      { event: 'compression.completed', compressed: true, totalMessages: 42, beforeTokens: 450_000, afterTokens: 80_000, contextTokens: 80_000, summarizer: 'aux' },
    ])
    expect(contextUpdates()).toEqual([80_000])
    expect(getSession(chatSessionId)?.context_tokens).toBe(80_000)
    expect(run.state.contextTokens).toBe(80_000)
  })

  it('passes summarizer through on started too and drops values outside aux|claude', () => {
    const { emitted, host } = startClaudeRun()
    host({ status: 'started', pre_tokens: 1_000, summarizer: 'claude' })
    host({ status: 'completed', pre_tokens: 1_000, post_tokens: 100, summarizer: 'bogus' })
    expect(emitted.mock.calls.find(([, event]) => event === 'compression.started')?.[2]).toEqual({ event: 'compression.started', message_count: 42, token_count: 1_000, summarizer: 'claude' })
    expect(emitted.mock.calls.find(([, event]) => event === 'compression.completed')?.[2]).not.toHaveProperty('summarizer')
  })

  it('then every main-thread API call of the turn pushes and stores the real context at once; sub-agent calls do not', () => {
    const { run, chatSessionId, host, assistant, contextUpdates } = startClaudeRun()
    host({ status: 'completed', pre_tokens: 450_000, post_tokens: 80_000, summarizer: 'aux' })

    assistant({ input_tokens: 3, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 1_200, output_tokens: 50 })
    expect(contextUpdates()).toEqual([80_000, 81_253])
    expect(getSession(chatSessionId)?.context_tokens).toBe(81_253)

    // Claude repeats the same call's usage on every content block: no duplicate push.
    assistant({ input_tokens: 3, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 1_200, output_tokens: 50 })
    expect(contextUpdates()).toEqual([80_000, 81_253])

    // A sub-agent (Task) call has its own, smaller context.
    assistant({ input_tokens: 5, cache_read_input_tokens: 20_000, output_tokens: 10 }, { parent_tool_use_id: 'toolu_task_1', messageId: 'msg_side' })
    expect(contextUpdates()).toEqual([80_000, 81_253])
    expect(getSession(chatSessionId)?.context_tokens).toBe(81_253)
    expect(run.claudeContextTokens).toBe(81_253)

    assistant({ input_tokens: 1, cache_read_input_tokens: 83_000, cache_creation_input_tokens: 400, output_tokens: 20 }, { messageId: 'msg_2' })
    expect(contextUpdates()).toEqual([80_000, 81_253, 83_421])
    expect(getSession(chatSessionId)?.context_tokens).toBe(83_421)
    expect(run.state.contextTokens).toBe(83_421)
  })

  it('pushes the real context of every main-thread call even without a compaction in the turn', () => {
    const { chatSessionId, assistant, contextUpdates } = startClaudeRun()
    assistant({ input_tokens: 10, cache_read_input_tokens: 200_000, output_tokens: 90 })
    expect(contextUpdates()).toEqual([200_100])
    expect(getSession(chatSessionId)?.context_tokens).toBe(200_100)
  })

  it('the end of the turn still shows the last main-thread call', async () => {
    const { manager, run, chatSessionId, host, assistant, contextUpdates, runLevelUsage } = startClaudeRun()
    host({ status: 'completed', pre_tokens: 450_000, post_tokens: 80_000 })
    assistant({ input_tokens: 3, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 1_200, output_tokens: 50 })
    assistant({ input_tokens: 5, cache_read_input_tokens: 20_000, output_tokens: 10 }, { parent_tool_use_id: 'toolu_task_1', messageId: 'msg_side' })
    runLevelUsage()
    await (manager as any).refreshCodingAgentUsage(run)
    expect(contextUpdates().at(-1)).toBe(81_253)
    expect(getSession(chatSessionId)?.context_tokens).toBe(81_253)
  })

  it('a turn whose last word is the compaction keeps the estimate, never a pre-compaction call or the run-level fallback (29)', async () => {
    const { manager, run, chatSessionId, line, assistant, contextUpdates, runLevelUsage } = startClaudeRun()
    // native auto-compaction in the middle of a turn: one call before it, none after
    assistant({ input_tokens: 2, cache_read_input_tokens: 449_000, output_tokens: 900 })
    line({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 449_902, post_tokens: 61_000 } })
    runLevelUsage()
    await (manager as any).refreshCodingAgentUsage(run)
    expect(contextUpdates()).toEqual([449_902, 61_000])
    expect(contextUpdates()).not.toContain(29)
    expect(getSession(chatSessionId)?.context_tokens).toBe(61_000)
  })

  it('native compact_boundary without post_tokens leaves the meter alone (unknown size)', async () => {
    const { manager, run, chatSessionId, line, contextUpdates, completed, runLevelUsage } = startClaudeRun()
    line({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 118_640 } })
    expect(completed()[0]).not.toHaveProperty('contextTokens')
    runLevelUsage()
    await (manager as any).refreshCodingAgentUsage(run)
    expect(contextUpdates()).toEqual([])
    expect(getSession(chatSessionId)?.context_tokens).toBe(450_000)
  })
})

describe('hermes-v051:B3 Claude compaction failure', () => {
  it('status:"failed" becomes the Hermes compression failure event and leaves the context meter alone', async () => {
    const { manager, run, chatSessionId, host, contextUpdates, completed, runLevelUsage } = startClaudeRun()
    host({ status: 'started', pre_tokens: 450_000, summarizer: 'aux' })
    host({ status: 'failed', pre_tokens: 450_000, summarizer: 'claude', reason: 'claude_fork_failed' })

    expect(completed()).toEqual([
      {
        event: 'compression.completed',
        compressed: false,
        totalMessages: 42,
        resultMessages: 42,
        beforeTokens: 450_000,
        afterTokens: 450_000,
        summaryTokens: 0,
        verbatimCount: 42,
        compressedStartIndex: -1,
        error: 'claude_fork_failed',
        summarizer: 'claude',
      },
    ])
    expect(contextUpdates()).toEqual([])
    // v0.4.7: a turn without any API call still skips the run-level fallback.
    runLevelUsage()
    await (manager as any).refreshCodingAgentUsage(run)
    expect(contextUpdates()).toEqual([])
    expect(getSession(chatSessionId)?.context_tokens).toBe(450_000)
    expect(run.printTextStarted).toBeFalsy()
  })

  it('a failure without a reason still carries an error', () => {
    const { host, completed } = startClaudeRun()
    host({ status: 'failed', pre_tokens: 9_000 })
    expect(completed()).toEqual([expect.objectContaining({ compressed: false, beforeTokens: 9_000, error: 'host_compaction_failed' })])
  })
})
