import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// hermes-v050:S-F11 — clearing a session's history while its coding agent is
// running left the run alive on the old state object: it kept streaming and
// then persisted its turn into the history that had just been cleared.
// Real ChatRunSocket.clearSessionHistory + CodingAgentRunManager →
// response-stream → session-store on in-memory SQLite; only the Claude CLI is
// a fake child process.

const DB_MODULE = '../../packages/server/src/modules/studio/infrastructure/database/index'

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bridgeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../packages/server/src/modules/hermes/services/bridge/index', () => ({ AgentBridgeClient: vi.fn(() => ({})) }))
vi.mock('../../packages/server/src/modules/hermes/services/bridge/manager', () => ({ getAgentBridgeManager: vi.fn(() => ({})) }))

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
}
process.stdin.on('data', () => {})
process.stdin.on('end', next)
`

let tempRoot = ''
let fakeCli = ''

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'hermes-v050-sf11-'))
  fakeCli = join(tempRoot, 'fake-claude.cjs')
  writeFileSync(fakeCli, FAKE_CLAUDE)
})

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

const stream = (event: unknown) => ({ emit: { type: 'stream_event', event } })

describe('hermes-v050:S-F11 clearing history stops the running coding agent', () => {
  let raw: any
  let manager: any

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    raw = new DatabaseSync(':memory:')
    vi.doMock(DB_MODULE, () => ({ getDb: () => raw, isSqliteAvailable: () => true, getStoragePath: () => ':memory:' }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
  })

  afterEach(() => {
    manager?.shutdown?.()
    manager = null
    raw?.close()
    vi.doUnmock(DB_MODULE)
    vi.resetModules()
  })

  async function waitFor(predicate: () => boolean, timeoutMs = 5000) {
    const started = Date.now()
    while (!predicate()) {
      if (Date.now() - started > timeoutMs) throw new Error('timed out')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  it('stops the run so nothing of the in-flight turn is written into the cleared session', { timeout: 30_000 }, async () => {
    const runDir = mkdtempSync(join(tempRoot, 'run-'))
    const goFile = join(runDir, 'go')
    const stepsFile = join(runDir, 'steps.json')
    writeFileSync(stepsFile, JSON.stringify([
      stream({ type: 'message_start', message: { id: 'msg_1' } }),
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Part one. ' } }),
      { waitFor: goFile },
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Part two.' } }),
      stream({ type: 'content_block_stop', index: 0 }),
      { emit: { type: 'result', result: 'Part one. Part two.', usage: { input_tokens: 1, output_tokens: 1 } } },
    ]))

    const store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const responseStream = await import('../../packages/server/src/modules/studio/services/chat-run/response-stream')
    const responseUtils = await import('../../packages/server/src/modules/studio/services/chat-run/response-utils')
    const { CodingAgentRunManager } = await import('../../packages/server/src/modules/coding-agents/services/runtime/run-manager')
    manager = new CodingAgentRunManager(60_000)
    const { configureChatAgentRuntime } = await import('../../packages/server/src/modules/studio/public/chat-agent-runtime')
    configureChatAgentRuntime({
      createPrimaryAgentBridge: () => ({ close: async () => {}, interrupt: vi.fn(async () => ({})) }),
      getPrimaryAgentBridgeManager: () => ({}),
      redactPrimaryAgentBridgeError: (error?: string) => error,
      codingAgentRunManager: manager,
      sendCodingAgentRunInput: vi.fn(),
      startCodingAgentRun: vi.fn(),
      handleCodingAgentSessionCommand: vi.fn(),
      parseCodingAgentSessionCommand: () => null,
    })
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const deltas: string[] = []
    const namespace = {
      adapter: { rooms: new Map() }, sockets: new Map(), use: vi.fn(), on: vi.fn(), emit: vi.fn(),
      to: () => ({ emit: (event: string, payload: any) => { if (event === 'message.delta') deltas.push(String(payload?.delta || '')) } }),
    }
    const server = new ChatRunSocket({ of: () => namespace } as any)
    const { configureRunState } = await import('../../packages/server/src/modules/studio/public/run-state')
    const { getOrCreateSession } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
    configureRunState({
      applyResponseStreamEvent: responseStream.applyResponseStreamEvent,
      calcAndUpdateUsage: async () => ({ inputTokens: 0, outputTokens: 0 }),
      completeWorkspaceRunCheckpoint: () => null,
      extractResponseText: responseUtils.extractResponseText,
      flushResponseRunToDb: responseStream.flushResponseRunToDb,
      getChatRunServer: () => server as any,
      getOrCreateSession,
      startWorkspaceRunCheckpoint: () => undefined,
      updateContextTokenUsage: () => undefined,
    })

    const sessionMap: Map<string, any> = (server as any).sessionMap
    const state = getOrCreateSession(sessionMap, 's1')
    state.webhookAgent = 'claude-code'
    manager.start({
      agentSessionId: 'agent-s1', agentId: 'claude-code', mode: 'global', profile: 'default',
      provider: 'anthropic', model: 'claude-test', sessionId: 's1',
      command: process.execPath, args: [fakeCli], shellCommand: '', workspaceDir: tempRoot,
      env: { FAKE_CLAUDE_STEPS: stepsFile }, state,
    })
    manager.send('s1', 'tell me a story', { clientMessageId: 'cm_story' })
    await waitFor(() => deltas.join('').includes('Part one.'))
    expect(manager.isSessionProcessing('s1')).toBe(true)

    const cleared = server.clearSessionHistory('s1')
    expect(cleared.deleted).toBe(1)
    // Let the CLI continue: a run that survived the clear would now finish its turn.
    writeFileSync(goFile, '')
    await new Promise(resolve => setTimeout(resolve, 400))

    expect(raw.prepare(`SELECT role, content FROM messages WHERE session_id = 's1'`).all()).toEqual([])
    expect(store.getSession('s1')?.message_count).toBe(0)
    expect(deltas.join('')).not.toContain('Part two.')
    expect(manager.hasSession('s1')).toBe(false)
    expect(sessionMap.has('s1')).toBe(false)
  })
})
