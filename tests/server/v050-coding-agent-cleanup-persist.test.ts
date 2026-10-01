import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

// hermes-v050:S-F8 — a coding-agent turn that ends abnormally (idle timeout,
// server shutdown, agent uninstall/stopMatching, explicit stop) used to lose
// everything streamed so far: cleanupRun never flushed the response run.
// Real CodingAgentRunManager → response-stream → persistRunMessages →
// session-store on in-memory SQLite; only the Claude CLI is a fake child.
//
// Guards: exactly one row per segment/tool (no double flush with the abort and
// queue-insertion paths, which already persist themselves).

const DB_MODULE = '../../packages/server/src/modules/studio/infrastructure/database/index'

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bridgeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const FAKE_CLAUDE = `
const fs = require('node:fs')
const steps = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_STEPS, 'utf8'))
let index = 0
function next() {
  const step = steps[index++]
  if (!step) return process.exit(0)
  if (step.emit) { process.stdout.write(JSON.stringify(step.emit) + '\\n'); return setTimeout(next, 5) }
  if (step.waitFor) {
    const timer = setInterval(() => { if (fs.existsSync(step.waitFor)) { clearInterval(timer); next() } }, 10)
    return
  }
  if (step.hang) return setInterval(() => {}, 1000)
}
process.stdin.on('data', () => {})
process.stdin.on('end', next)
`

let tempRoot = ''
let fakeCli = ''

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'hermes-v050-sf8-'))
  fakeCli = join(tempRoot, 'fake-claude.cjs')
  writeFileSync(fakeCli, FAKE_CLAUDE)
})

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

const stream = (event: unknown) => ({ emit: { type: 'stream_event', event } })
const TEXT_ONE = 'I will look at the build first. '
const TEXT_TWO = 'Half of the second answer'

function textThenLongTool() {
  return [
    stream({ type: 'message_start', message: { id: 'msg_1' } }),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: TEXT_ONE } }),
    stream({ type: 'content_block_stop', index: 0 }),
    stream({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_build', name: 'Bash', input: {} } }),
    stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"npm run build"}' } }),
    stream({ type: 'content_block_stop', index: 1 }),
    { emit: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_build', content: 'build ok' }] } } },
    stream({ type: 'message_start', message: { id: 'msg_2' } }),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: TEXT_TWO } }),
    { hang: true },
  ]
}

describe('hermes-v050:S-F8 coding-agent turns that end abnormally are persisted', () => {
  let raw: any
  let store: any
  let manager: any
  let emitted: Array<{ event: string; payload: any }>
  let completed: string[]
  let stepsFile: string
  let state: any

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    raw = new DatabaseSync(':memory:')
    vi.doMock(DB_MODULE, () => ({ getDb: () => raw, isSqliteAvailable: () => true, getStoragePath: () => ':memory:' }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const responseStream = await import('../../packages/server/src/modules/studio/services/chat-run/response-stream')
    const responseUtils = await import('../../packages/server/src/modules/studio/services/chat-run/response-utils')
    const { configureRunState } = await import('../../packages/server/src/modules/studio/public/run-state')
    emitted = []
    completed = []
    configureRunState({
      applyResponseStreamEvent: responseStream.applyResponseStreamEvent,
      calcAndUpdateUsage: async () => ({ inputTokens: 0, outputTokens: 0 }),
      completeWorkspaceRunCheckpoint: () => null,
      extractResponseText: responseUtils.extractResponseText,
      flushResponseRunToDb: responseStream.flushResponseRunToDb,
      getChatRunServer: () => ({
        emitExternalEvent: (_sid: string, event: string, payload: any) => { emitted.push({ event, payload }) },
        markExternalRunCompleted: (_sid: string, event: string) => { completed.push(event) },
      }),
      getOrCreateSession: () => ({ messages: [], isWorking: false, events: [], queue: [] }),
      startWorkspaceRunCheckpoint: () => undefined,
      updateContextTokenUsage: () => undefined,
    })
    stepsFile = join(mkdtempSync(join(tempRoot, 'run-')), 'steps.json')
  })

  afterEach(() => {
    manager?.shutdown?.()
    manager = null
    raw?.close()
    vi.doUnmock(DB_MODULE)
    vi.resetModules()
  })

  async function startTurn(steps: unknown[], idleMs = 60_000) {
    writeFileSync(stepsFile, JSON.stringify(steps))
    const { CodingAgentRunManager } = await import('../../packages/server/src/modules/coding-agents/services/runtime/run-manager')
    manager = new CodingAgentRunManager(idleMs)
    state = { messages: [], isWorking: false, events: [], queue: [] }
    manager.start({
      agentSessionId: 'agent-s1',
      agentId: 'claude-code',
      mode: 'global',
      profile: 'default',
      provider: 'anthropic',
      model: 'claude-test',
      sessionId: 's1',
      command: process.execPath,
      args: [fakeCli],
      shellCommand: '',
      workspaceDir: tempRoot,
      env: { FAKE_CLAUDE_STEPS: stepsFile },
      state,
    })
    manager.send('s1', 'please build it', { clientMessageId: 'cm_user_1' })
    await waitFor(() => deltaText().includes(TEXT_TWO))
  }

  const deltaText = () => emitted.filter(item => item.event === 'message.delta').map(item => String(item.payload.delta || '')).join('')

  async function waitFor(predicate: () => boolean, timeoutMs = 5000) {
    const started = Date.now()
    while (!predicate()) {
      if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the fake Claude CLI')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  function rows() {
    return raw.prepare(
      `SELECT role, content, tool_call_id, tool_name, finish_reason, client_message_id, tool_calls
       FROM messages WHERE session_id = 's1' ORDER BY id`,
    ).all() as Array<Record<string, any>>
  }

  function expectTurnPersistedOnce() {
    const persisted = rows()
    expect(persisted.filter(row => row.role === 'user')).toEqual([
      expect.objectContaining({ content: 'please build it', client_message_id: 'cm_user_1' }),
    ])
    const assistantText = persisted.filter(row => row.role === 'assistant' && row.content)
    expect(assistantText.map(row => row.content)).toEqual([TEXT_ONE, TEXT_TWO])
    expect(new Set(assistantText.map(row => row.client_message_id)).size).toBe(2)
    assistantText.forEach(row => expect(row.client_message_id).toMatch(/^am_/))
    const toolCallRows = persisted.filter(row => row.role === 'assistant' && String(row.tool_calls || '').includes('toolu_build'))
    expect(toolCallRows).toHaveLength(1)
    expect(persisted.filter(row => row.role === 'tool')).toEqual([
      expect.objectContaining({ tool_call_id: 'toolu_build', content: 'build ok' }),
    ])
    // A killed segment must not look like a still-streaming one after reload.
    expect(assistantText.at(-1)?.finish_reason).toBe('interrupted')
    persisted.filter(row => row.role === 'assistant').forEach(row => expect(row.finish_reason).not.toBeNull())
  }

  it('persists the partial turn when the idle timer closes a silent Claude run', async () => {
    await startTurn(textThenLongTool(), 400)
    await waitFor(() => !manager.hasSession('s1'), 5000)
    expectTurnPersistedOnce()
    expect(completed).toContain('run.failed')
  })

  it('persists the partial turn on server shutdown', async () => {
    await startTurn(textThenLongTool())
    manager.shutdown()
    expectTurnPersistedOnce()
  })

  it('persists the partial turn when the agent is stopped for uninstall (stopMatching)', async () => {
    await startTurn(textThenLongTool())
    expect(manager.stopMatching((launch: any) => launch.agentId === 'claude-code', { reportClosed: true })).toBe(1)
    expectTurnPersistedOnce()
  })

  it('persists the partial turn when the run is stopped through the API (stop)', async () => {
    await startTurn(textThenLongTool())
    expect(manager.stop('s1')).toBe(true)
    expectTurnPersistedOnce()
  })

  it('guard: the queue-insertion interrupt still persists exactly once', async () => {
    await startTurn(textThenLongTool())
    const result = await manager.interruptForQueueInsertion('s1')
    expect(result.status).toBe('interrupted')
    expectTurnPersistedOnce()
  })

  it('guard: a user abort (flush, then stop without reporting) persists exactly once', async () => {
    await startTurn(textThenLongTool())
    const responseStream = await import('../../packages/server/src/modules/studio/services/chat-run/response-stream')
    // abort.ts: flushResponseRunToDb(state) followed by stop(sessionId, { reportClosed: false }).
    responseStream.flushResponseRunToDb(state, 's1')
    manager.stop('s1', { reportClosed: false })
    const persisted = rows()
    expect(persisted.filter(row => row.role === 'assistant' && row.content).map(row => row.content)).toEqual([TEXT_ONE, TEXT_TWO])
    expect(persisted.filter(row => row.role === 'tool')).toHaveLength(1)
    expect(persisted.filter(row => row.role === 'assistant' && String(row.tool_calls || '').includes('toolu_build'))).toHaveLength(1)
  })

  it('does not write a finished turn a second time when the run is later closed', async () => {
    const steps = [
      stream({ type: 'message_start', message: { id: 'msg_1' } }),
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: TEXT_ONE } }),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: TEXT_TWO } }),
      stream({ type: 'content_block_stop', index: 0 }),
      { emit: { type: 'result', result: `${TEXT_ONE}${TEXT_TWO}`, usage: { input_tokens: 1, output_tokens: 1 } } },
    ]
    await startTurn(steps)
    await waitFor(() => completed.includes('run.completed'))
    manager.shutdown()
    const assistant = rows().filter(row => row.role === 'assistant')
    expect(assistant).toEqual([expect.objectContaining({ content: `${TEXT_ONE}${TEXT_TWO}`, finish_reason: 'stop' })])
    expect(existsSync(stepsFile)).toBe(true)
  })
})
