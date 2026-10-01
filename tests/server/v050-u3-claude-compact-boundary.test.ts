// hermes-v050:U3 — Claude 原生 compact_boundary 改走 Studio 的压缩事件通道，不再把英文结果拼进助手正文。
import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

const spawned = vi.hoisted(() => [] as any[])
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: vi.fn(() => {
      const child: any = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.stdin = new PassThrough()
      child.pid = 4242
      child.exitCode = null
      child.kill = vi.fn()
      spawned.push(child)
      return child
    }),
  }
})
import '../../packages/server/src/bootstrap/coding-agent-adapters'
import { CodingAgentRunManager } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { createSession, updateSession } from '../../packages/server/src/modules/studio/repositories/session-store'

const suffix = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

function startClaudeRun() {
  initAllHermesTables()
  const manager = new CodingAgentRunManager()
  const agentSessionId = `agent-cb-${suffix()}`
  const chatSessionId = `chat-cb-${suffix()}`
  createSession({ id: chatSessionId, profile: 'default', source: 'coding_agent', agent: 'claude', agent_mode: 'scoped', model: 'claude-opus-5-5', provider: 'global', title: '', agent_native_session_id: '22222222-2222-4222-8222-222222222222' } as any)
  updateSession(chatSessionId, { message_count: 42 } as any)
  const emitted = vi.fn()
  ;(manager as any).emitToChat = emitted
  manager.start({
    agentSessionId, agentId: 'claude-code', mode: 'scoped', profile: 'default', provider: 'global', model: 'claude-opus-5-5',
    sessionId: chatSessionId, command: 'claude', args: [], shellCommand: 'claude', workspaceDir: process.cwd(),
    state: { messages: [], isWorking: false, events: [], queue: [] } as any,
  })
  const run = (manager as any).runs.get(agentSessionId)
  const responseEvents: any[] = []
  const original = (manager as any).handleResponseEvent.bind(manager)
  ;(manager as any).handleResponseEvent = (runId: string, event: any) => {
    responseEvents.push(event)
    return original(runId, event)
  }
  const line = (event: Record<string, unknown>) => (manager as any).handleClaudePrintLine(run, JSON.stringify(event))
  return { manager, run, chatSessionId, emitted, responseEvents, line }
}

describe('hermes-v050:U3 Claude native compact_boundary', () => {
  it('emits compression.completed through the host-compaction channel instead of appending English reply text', () => {
    const { run, chatSessionId, emitted, responseEvents, line } = startClaudeRun()
    line({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 170_560, post_tokens: 7_163 } })

    const compression = emitted.mock.calls.filter(call => call[1] === 'compression.completed')
    expect(compression).toEqual([
      // hermes-v051:B1 a known post-compaction size is also the new context estimate.
      [chatSessionId, 'compression.completed', { event: 'compression.completed', compressed: true, totalMessages: 42, beforeTokens: 170_560, afterTokens: 7_163, contextTokens: 7_163 }],
    ])
    expect(run.printTextStarted).toBeFalsy()
    expect(String(run.printText || '')).toBe('')
    const deltas = responseEvents.filter(event => event.type === 'response.output_text.delta')
    expect(deltas).toEqual([])
    expect(JSON.stringify(responseEvents)).not.toContain('Compaction completed')
  })

  it('reports an unknown post-compaction size as 0 (same contract as host_compaction) when Claude omits post_tokens', () => {
    const { emitted, line } = startClaudeRun()
    line({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 120_252 } })
    const payload = emitted.mock.calls.find(call => call[1] === 'compression.completed')?.[2]
    expect(payload).toEqual({ event: 'compression.completed', compressed: true, totalMessages: 42, beforeTokens: 120_252, afterTokens: 0 })
  })

  it('keeps the old suppression of the trailing result text after a compaction (no English reply line), but still streams real replies', () => {
    const { run, responseEvents, line } = startClaudeRun()
    line({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 9_000, post_tokens: 900 } })
    line({ type: 'result', subtype: 'success', result: 'Compacted', usage: { input_tokens: 1, output_tokens: 1 } })
    expect(String(run.printText || '')).toBe('')
    expect(JSON.stringify(responseEvents)).not.toContain('Compacted')
    expect(responseEvents.some(event => event.type === 'response.completed')).toBe(true)
  })

  it('does not leak the compaction flag into the next turn', () => {
    const { manager, run, line } = startClaudeRun()
    line({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 9_000, post_tokens: 900 } })
    line({ type: 'result', subtype: 'success', result: '', usage: {} })
    run.currentChild = undefined
    ;(manager as any).startClaudePrintTurn(run, 'hello', '', [])
    expect(spawned.length).toBeGreaterThan(0)
    line({ type: 'result', subtype: 'success', result: 'Next turn reply', usage: {} })
    expect(String(run.printText || '')).toBe('Next turn reply')
  })
})
