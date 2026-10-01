// hermes-v050:T10 — 编程工具 run.failed：英文 error 原样保留，另带 error_code + error_params
// （退出码、stderr 详情作为参数），客户端映射到 chat.errors.*。
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
      child.pid = 4343
      child.exitCode = null
      child.kill = vi.fn()
      spawned.push(child)
      return child
    }),
  }
})
import '../../packages/server/src/bootstrap/coding-agent-adapters'
import { CodingAgentRunManager, codingAgentRunErrorFields } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { createSession } from '../../packages/server/src/modules/studio/repositories/session-store'

const suffix = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

function startClaudeRun() {
  initAllHermesTables()
  const manager = new CodingAgentRunManager()
  const agentSessionId = `agent-t10-${suffix()}`
  const chatSessionId = `chat-t10-${suffix()}`
  createSession({ id: chatSessionId, profile: 'default', source: 'coding_agent', agent: 'claude', agent_mode: 'scoped', model: 'claude-opus-5-5', provider: 'global', title: '' } as any)
  const emitted = vi.fn()
  ;(manager as any).emitToChat = emitted
  manager.start({
    agentSessionId, agentId: 'claude-code', mode: 'scoped', profile: 'default', provider: 'global', model: 'claude-opus-5-5',
    sessionId: chatSessionId, command: 'claude', args: [], shellCommand: 'claude', workspaceDir: process.cwd(),
    state: { messages: [], isWorking: false, events: [], queue: [] } as any,
  })
  const run = (manager as any).runs.get(agentSessionId)
  const line = (event: Record<string, unknown>) => (manager as any).handleClaudePrintLine(run, JSON.stringify(event))
  const failed = () => emitted.mock.calls.filter(call => call[1] === 'run.failed').map(call => call[2])
  return { manager, run, chatSessionId, emitted, line, failed }
}

describe('hermes-v050:T10 codingAgentRunErrorFields', () => {
  it('codes the run.failed texts written by the run manager', () => {
    expect(codingAgentRunErrorFields('Coding agent run failed')).toEqual({ error_code: 'coding_agent_run_failed' })
    expect(codingAgentRunErrorFields('Claude Code API error')).toEqual({ error_code: 'claude_api_error' })
    expect(codingAgentRunErrorFields('Codex run failed')).toEqual({ error_code: 'codex_run_failed' })
    expect(codingAgentRunErrorFields('Claude Code exited with code 2')).toEqual({
      error_code: 'coding_agent_exited', error_params: { agent: 'claude-code', exit_code: 2 },
    })
    expect(codingAgentRunErrorFields('Codex exited with code unknown')).toEqual({
      error_code: 'coding_agent_exited', error_params: { agent: 'codex', exit_code: null },
    })
    expect(codingAgentRunErrorFields('Pi exited with code 1: Traceback\nValueError: bad')).toEqual({
      error_code: 'coding_agent_exited', error_params: { agent: 'pi', exit_code: 1, detail: 'Traceback\nValueError: bad' },
    })
  })

  it('leaves provider / model errors and empty errors uncoded', () => {
    expect(codingAgentRunErrorFields('API Error: 529 overloaded')).toEqual({})
    expect(codingAgentRunErrorFields('Interrupted to insert a queued message')).toEqual({})
    expect(codingAgentRunErrorFields('Someone else exited with code 3')).toEqual({})
    expect(codingAgentRunErrorFields('')).toEqual({})
    expect(codingAgentRunErrorFields(null)).toEqual({})
    expect(codingAgentRunErrorFields(undefined)).toEqual({})
  })
})

describe('hermes-v050:T10 coding-agent run.failed payloads', () => {
  it('adds claude_api_error next to the English "Claude Code API error"', async () => {
    const { line, failed } = startClaudeRun()
    line({ type: 'assistant', isApiErrorMessage: true, message: { content: [] } })
    await vi.waitFor(() => expect(failed()).toHaveLength(1))
    expect(failed()[0]).toEqual(expect.objectContaining({
      event: 'run.failed',
      error: 'Claude Code API error',
      error_code: 'claude_api_error',
    }))
  })

  it('adds coding_agent_exited with the exit code and stderr detail when Claude exits non-zero', async () => {
    const { manager, run, failed } = startClaudeRun()
    ;(manager as any).startClaudePrintTurn(run, 'hello', '', [])
    const child = spawned.at(-1)
    child.stderr.write('permission denied\n')
    await new Promise(resolve => setImmediate(resolve))
    child.stdout.end()
    child.emit('close', 2)
    await vi.waitFor(() => expect(failed()).toHaveLength(1))
    expect(failed()[0]).toEqual(expect.objectContaining({
      event: 'run.failed',
      error: 'Claude Code exited with code 2: permission denied',
      error_code: 'coding_agent_exited',
      error_params: { agent: 'claude-code', exit_code: 2, detail: 'permission denied' },
    }))
  })

  it('fails the turn on the stream-json spelling of a native API error', async () => {
    const { line, failed } = startClaudeRun()
    line({ type: 'assistant', is_api_error_message: true, error: 'server_error', message: { content: [{ type: 'text', text: 'API Error: 502 Bad gateway' }] } })
    await vi.waitFor(() => expect(failed()).toHaveLength(1))
    expect(failed()[0].error).toBe('API Error: 502 Bad gateway')
    expect(failed()[0].error_code).toBeUndefined()
  })

  it('keeps the native API error when the managed wrapper then exits 75', async () => {
    const { manager, run, failed } = startClaudeRun()
    ;(manager as any).startClaudePrintTurn(run, 'hello', '', [])
    const child = spawned.at(-1)
    child.stdout.write(`${JSON.stringify({ type: 'assistant', is_api_error_message: true, error: 'server_error', message: { content: [{ type: 'text', text: 'API Error: 502 Bad gateway' }] } })}\n`)
    child.stderr.write('[host-compaction] Native call failed (1, 1 result(s), error): API Error: 502 Bad gateway\n')
    await new Promise(resolve => setImmediate(resolve))
    child.stdout.end()
    child.emit('close', 75)
    await vi.waitFor(() => expect(failed()).toHaveLength(1))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(failed()).toHaveLength(1)
    expect(failed()[0].error).toBe('API Error: 502 Bad gateway')
  })

  it('does not code a provider error returned as the reply text', async () => {
    const { line, failed } = startClaudeRun()
    line({ type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API Error: 529 overloaded' }] } })
    await vi.waitFor(() => expect(failed()).toHaveLength(1))
    expect(failed()[0].error).toBe('API Error: 529 overloaded')
    expect(failed()[0].error_code).toBeUndefined()
    expect(failed()[0].error_params).toBeUndefined()
  })
})
