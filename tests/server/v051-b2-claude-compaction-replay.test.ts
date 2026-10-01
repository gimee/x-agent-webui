// hermes-v051:B2 — 编程工具对话：压缩完成 5 秒后，压缩事件从补推（重放）列表删除，切回标签页/重连不再把状态行挂回去。
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../packages/server/src/bootstrap/coding-agent-adapters'
import { CodingAgentRunManager } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { createSession, updateSession } from '../../packages/server/src/modules/studio/repositories/session-store'

const suffix = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

function startClaudeRun() {
  initAllHermesTables()
  const manager = new CodingAgentRunManager()
  const agentSessionId = `agent-b2-${suffix()}`
  const chatSessionId = `chat-b2-${suffix()}`
  createSession({ id: chatSessionId, profile: 'default', source: 'coding_agent', agent: 'claude', agent_mode: 'global', model: 'claude-opus-5-5', provider: 'global', title: '' } as any)
  updateSession(chatSessionId, { message_count: 7 } as any)
  const state = { messages: [], isWorking: false, events: [], queue: [] } as any
  // Same buffering as ChatRunSocket.emitExternalEvent: every event of a working session is kept for the resume replay.
  ;(manager as any).emitToChat = (sessionId: string, event: string, payload: any) => {
    if (state.isWorking) state.events.push({ event, data: { ...payload, session_id: sessionId } })
  }
  manager.start({
    agentSessionId, agentId: 'claude-code', mode: 'global', profile: 'default', provider: 'global', model: 'claude-opus-5-5',
    sessionId: chatSessionId, command: 'claude', args: [], shellCommand: 'claude', workspaceDir: process.cwd(),
    state,
  })
  const run = (manager as any).runs.get(agentSessionId)
  const host = (fields: Record<string, unknown>) => (manager as any).handleClaudePrintLine(run, JSON.stringify({ type: 'system', subtype: 'host_compaction', ...fields }))
  const replayed = () => state.events.map((entry: any) => entry.event).filter((event: string) => event !== 'usage.updated')
  return { run, state, host, replayed }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('hermes-v051:B2 Claude compaction replay', () => {
  it('drops started/completed from the replay list 5s after completion and keeps everything else', () => {
    vi.useFakeTimers()
    const { state, host, replayed } = startClaudeRun()
    expect(state.isWorking).toBe(true)
    state.events.push({ event: 'tool.started', data: { event: 'tool.started', tool_call_id: 'toolu_1' } })
    host({ status: 'started', pre_tokens: 450_000, summarizer: 'aux' })
    host({ status: 'completed', pre_tokens: 450_000, post_tokens: 80_000, summarizer: 'aux' })
    expect(replayed()).toEqual(['tool.started', 'compression.started', 'compression.completed'])

    vi.advanceTimersByTime(4_999)
    expect(replayed()).toEqual(['tool.started', 'compression.started', 'compression.completed'])
    vi.advanceTimersByTime(1)
    expect(replayed()).toEqual(['tool.started'])
  })

  it('also drops a failed compaction 5s later', () => {
    vi.useFakeTimers()
    const { host, replayed } = startClaudeRun()
    host({ status: 'started', pre_tokens: 9_000 })
    host({ status: 'failed', pre_tokens: 9_000, reason: 'claude_fork_failed' })
    expect(replayed()).toEqual(['compression.started', 'compression.completed'])
    vi.advanceTimersByTime(5_000)
    expect(replayed()).toEqual([])
  })

  it('keeps a compaction that started after the completed one (still running)', () => {
    vi.useFakeTimers()
    const { host, replayed } = startClaudeRun()
    host({ status: 'started', pre_tokens: 9_000 })
    host({ status: 'completed', pre_tokens: 9_000, post_tokens: 900 })
    vi.advanceTimersByTime(2_000)
    host({ status: 'started', pre_tokens: 12_000 })
    vi.advanceTimersByTime(3_000)
    expect(replayed()).toEqual(['compression.started'])
    vi.advanceTimersByTime(60_000)
    expect(replayed()).toEqual(['compression.started'])
  })
})
