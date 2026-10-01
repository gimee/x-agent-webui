import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// hermes-v051:A internal Claude-context endpoints: loopback + per-launch token, auxiliary summary, live settings.
const hasSessionMock = vi.fn()
const readConfigYamlForProfileMock = vi.fn()
const getModelContextLengthMock = vi.fn()
const bridgeRequestMock = vi.fn()
const bridgeDestroyMock = vi.fn()
const resolveSettingsMock = vi.fn()

// hermes-v051:R1-11 the real redaction function, only the run registry is faked.
vi.mock('../../packages/server/src/modules/coding-agents/services/runtime/run-manager', async (importOriginal) => ({
  codingAgentRunManager: { hasSession: hasSessionMock },
  sanitizeCodingAgentTerminalOutput: (await importOriginal<typeof import('../../packages/server/src/modules/coding-agents/services/runtime/run-manager')>()).sanitizeCodingAgentTerminalOutput,
}))
// hermes-v051:R1-07 observe whether the per-message token count runs.
vi.mock('../../packages/server/src/modules/studio/public/context-compression', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/server/src/modules/studio/public/context-compression')>()
  return { ...actual, chunkForSummary: vi.fn(actual.chunkForSummary) }
})
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  readConfigYamlForProfile: readConfigYamlForProfileMock,
}))
vi.mock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({
  getModelContextLength: getModelContextLengthMock,
}))
vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
  createPrimaryAgentBridge: vi.fn(() => ({ request: bridgeRequestMock, destroy: bridgeDestroyMock })),
}))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({ getSession: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/repositories/compression-snapshot', () => ({
  getCompressionSnapshot: vi.fn(), saveCompressionSnapshot: vi.fn(), deleteCompressionSnapshot: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bridgeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../packages/server/src/modules/coding-agents/services/claude-compression-settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../packages/server/src/modules/coding-agents/services/claude-compression-settings')>(),
  resolveClaudeCompressionSettings: resolveSettingsMock,
}))

const tokens = () => import('../../packages/server/src/modules/coding-agents/services/claude-summary/tokens')
const transcript = () => import('../../packages/server/src/modules/coding-agents/services/claude-summary/transcript')
const service = () => import('../../packages/server/src/modules/coding-agents/services/claude-summary')
const facade = () => import('../../packages/server/src/modules/studio/public/context-compression')

const SUMMARY = 'Summary of the Claude session. '.repeat(40).trim()
const AUX = { auxiliary: { compression: { provider: 'custom:example-grok', model: 'fixture-summary-model', timeout: 120 } } }

describe('Claude transcript → ChatMessage', () => {
  it('merges split assistant rows, maps tools, drops thinking and keeps media as placeholders', async () => {
    const { claudeRecordsToChatMessages } = await transcript()
    const messages = claudeRecordsToChatMessages([
      { role: 'user', content: 'Fix the gate' },
      { role: 'assistant', id: 'm1', content: [{ type: 'thinking', thinking: 'HIDDEN', signature: 'SIG' }] },
      { role: 'assistant', id: 'm1', content: [{ type: 'text', text: 'Reading the file.' }] },
      { role: 'assistant', id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'file body' }, { type: 'image', source: {} }] }] },
      { role: 'assistant', id: 'm2', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'false' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'exit 1' }, { type: 'text', text: 'and this' }, { type: 'image', source: {} }] },
      { role: 'assistant', id: 'm3', content: [{ type: 'thinking', thinking: 'ONLY THINKING' }] },
      { role: 'assistant', id: 'm4', content: 'Done.' },
      { role: 'system', content: 'ignored' },
    ])
    expect(messages).toEqual([
      { role: 'user', content: 'Fix the gate' },
      { role: 'assistant', content: 'Reading the file.', tool_calls: [{ id: 't1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/a.ts"}' } }] },
      { role: 'tool', tool_call_id: 't1', name: 'Read', content: 'file body\n[image]' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't2', type: 'function', function: { name: 'Bash', arguments: '{"command":"false"}' } }] },
      { role: 'tool', tool_call_id: 't2', name: 'Bash', content: '[tool error] exit 1' },
      { role: 'user', content: 'and this\n[image attached]' },
      { role: 'assistant', content: 'Done.' },
    ])
    expect(JSON.stringify(messages)).not.toMatch(/HIDDEN|SIG|ONLY THINKING/)
  })

  it('does not merge a different message into the previous one after a thinking-only row', async () => {
    const { claudeRecordsToChatMessages } = await transcript()
    const messages = claudeRecordsToChatMessages([
      { role: 'assistant', id: 'y', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', id: 'x', content: [{ type: 'thinking', thinking: 't' }] },
      { role: 'assistant', id: 'x', content: [{ type: 'text', text: 'second' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'no id' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'no id again' }] },
    ])
    expect(messages.map(m => m.content)).toEqual(['first', 'second', 'no id', 'no id again'])
  })
})

describe('Claude summary tokens', () => {
  it('binds one random token to a session and profile; replace and revoke invalidate it', async () => {
    const t = await tokens()
    const a = t.issueClaudeSummaryToken('s1', 'default')
    expect(a).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(t.claudeSummaryTokenProfile('s1', a)).toBe('default')
    expect(t.claudeSummaryTokenProfile('s1', `${a}x`)).toBeNull()
    expect(t.claudeSummaryTokenProfile('s2', a)).toBeNull()
    expect(t.claudeSummaryTokenProfile('s1', '')).toBeNull()
    const b = t.issueClaudeSummaryToken('s1', 'work')
    expect(b).not.toBe(a)
    expect(t.claudeSummaryTokenProfile('s1', a)).toBeNull()
    t.revokeClaudeSummaryToken('s1', a)
    expect(t.claudeSummaryTokenProfile('s1', b)).toBe('work')
    t.revokeClaudeSummaryToken('s1', b)
    expect(t.claudeSummaryTokenProfile('s1', b)).toBeNull()
  })

  it('builds the endpoint URL from the loopback base URL', async () => {
    const t = await tokens()
    t.setClaudeSummaryBaseUrl('http://127.0.0.1:43210/')
    expect(t.claudeSummaryUrl()).toBe('http://127.0.0.1:43210/api/coding-agents/claude-context/summary')
  })
})

describe('Claude summary endpoints', () => {
  let server: Server
  let base: string

  beforeEach(async () => {
    vi.resetModules()
    for (const mock of [hasSessionMock, readConfigYamlForProfileMock, getModelContextLengthMock, bridgeRequestMock, bridgeDestroyMock, resolveSettingsMock]) mock.mockReset()
    hasSessionMock.mockReturnValue(true)
    readConfigYamlForProfileMock.mockResolvedValue(AUX)
    getModelContextLengthMock.mockReturnValue(1_000_000)
    bridgeDestroyMock.mockResolvedValue(undefined)
    bridgeRequestMock.mockResolvedValue({ status: 'completed', result: { final_response: SUMMARY } })
    const Koa = (await import('koa')).default
    const { createRequestBodyParser } = await import('../../packages/server/src/modules/studio/middleware/request-body-parser')
    const { claudeContextRoutes } = await import('../../packages/server/src/modules/coding-agents/routes/claude-context')
    const app = new Koa()
    app.use(createRequestBodyParser())
    app.use(claudeContextRoutes.routes())
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/coding-agents/claude-context`
  })

  afterEach(async () => {
    await new Promise(resolve => server ? server.close(resolve) : resolve(undefined))
  })

  const post = async (path: string, token: string, body: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) })
    return { status: response.status, deadline: response.headers.get('x-hermes-summary-deadline-ms'), body: await response.json() }
  }
  const rows = [
    { role: 'user', content: 'Please fix the gate' },
    { role: 'assistant', id: 'm1', content: [{ type: 'text', text: 'Working on it.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/gate.ts' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'gate source' }] },
  ]

  it('summarizes with the auxiliary compression model: reasoning effort, timeout and single-call chunking', async () => {
    readConfigYamlForProfileMock.mockResolvedValue({ auxiliary: { compression: { ...AUX.auxiliary.compression, reasoning_effort: 'none' } } })
    const { issueClaudeSummaryToken } = await tokens()
    const token = issueClaudeSummaryToken('studio-1', 'default')
    const out = await post('summary', token, { session_id: 'studio-1', rows, previous_summary: null, focus: null, summary_budget: 8000 })
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: true, summary: SUMMARY, model: 'fixture-summary-model', provider: 'custom:example-grok', chunks: 1 })
    expect(typeof out.body.seconds).toBe('number')
    expect(Number(out.deadline)).toBeGreaterThanOrEqual(270_000)
    expect(getModelContextLengthMock).toHaveBeenCalledWith({ profile: 'default', model: 'fixture-summary-model', provider: 'custom:example-grok' })
    expect(bridgeRequestMock).toHaveBeenCalledTimes(1)
    const [request, options] = bridgeRequestMock.mock.calls[0]
    expect(request).toMatchObject({ action: 'chat', profile: 'default', model: 'fixture-summary-model', provider: 'custom:example-grok', reasoning_effort: 'none', timeout: 270, worker_key: expect.stringMatching(/^default:compression:studio-1:/) })
    expect(options.timeoutMs).toBeGreaterThan(284_000)
    expect(options.timeoutMs).toBeLessThanOrEqual(285_000)
    const prompt = request.conversation_history.at(-1).content
    expect(prompt).toContain('TURNS TO SUMMARIZE')
    expect(prompt).toContain('Please fix the gate')
    expect(prompt).toContain('[tool_call: Read(')
    expect(prompt).toContain('[tool:Read]: gate source')
    expect(prompt).toContain('Target ~8000 tokens')
  })

  it('uses the longer configured timeout, the incremental prompt with the previous summary, and the /compact focus', async () => {
    readConfigYamlForProfileMock.mockResolvedValue({ auxiliary: { compression: { ...AUX.auxiliary.compression, timeout: 600 } } })
    const { issueClaudeSummaryToken } = await tokens()
    const token = issueClaudeSummaryToken('studio-1', 'default')
    const out = await post('summary', token, { session_id: 'studio-1', rows, previous_summary: 'PREVIOUS SUMMARY TEXT', focus: 'keep the gate numbers', summary_budget: 99999 })
    expect(out.body.ok).toBe(true)
    const [request] = bridgeRequestMock.mock.calls[0]
    expect(request.timeout).toBe(600)
    expect(request).not.toHaveProperty('reasoning_effort')
    const prompt = request.conversation_history.at(-1).content
    expect(prompt).toContain('PREVIOUS SUMMARY:\nPREVIOUS SUMMARY TEXT')
    expect(prompt).toContain('NEW TURNS TO INCORPORATE')
    expect(prompt).toContain('Target ~16000 tokens')
    expect(prompt.trimEnd().endsWith('keep the gate numbers')).toBe(true)
  })

  it('splits only when the history exceeds half of the summary model window', async () => {
    getModelContextLengthMock.mockReturnValue(40_000)
    const big = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ` + 'word '.repeat(9000) }))
    const { issueClaudeSummaryToken } = await tokens()
    const out = await post('summary', issueClaudeSummaryToken('studio-1', 'default'), { session_id: 'studio-1', rows: big, summary_budget: 8000 })
    expect(out.body.ok).toBe(true)
    expect(out.body.chunks).toBeGreaterThan(1)
    expect(bridgeRequestMock).toHaveBeenCalledTimes(out.body.chunks)
    expect((await facade()).chunkForSummary).toHaveBeenCalled()
  })

  // hermes-v051:R1-07 UTF-8 bytes bound tokens: a history no larger in bytes than one chunk is one chunk,
  // without the per-message exact count that blocks the event loop (~1.9s on a 455K-token session).
  it('sends a history that fits one chunk by bytes without the per-message token count', async () => {
    const { chunkForSummary } = await facade()
    vi.mocked(chunkForSummary).mockClear()
    const { issueClaudeSummaryToken } = await tokens()
    const out = await post('summary', issueClaudeSummaryToken('studio-1', 'default'), { session_id: 'studio-1', rows, summary_budget: 8000 })
    expect(out.body).toMatchObject({ ok: true, chunks: 1 })
    expect(chunkForSummary).not.toHaveBeenCalled()
    expect(bridgeRequestMock.mock.calls[0][0].conversation_history.at(-1).content).toContain('user: Please fix the gate\n\nassistant: [tool_call: Read(')
  })

  // hermes-v051:R1-11 credentials pasted into the conversation never reach the auxiliary provider.
  it('redacts credentials in the history, the previous summary and the focus before the summarizer call', async () => {
    const { issueClaudeSummaryToken } = await tokens()
    const secretRows = [
      { role: 'user', content: 'use sk-ant-api03-FIXTUREabcdefgh1234 with Authorization: Bearer fixtureBearerToken123' },
      { role: 'assistant', id: 'm', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'curl -H "api_key: FIXTUREAPIKEY12345" https://x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'OPENAI_API_KEY=sk-proj-FIXTURE9876543210' }] },
    ]
    const out = await post('summary', issueClaudeSummaryToken('studio-1', 'default'), { session_id: 'studio-1', rows: secretRows, previous_summary: 'earlier: sk-or-FIXTURE0000000000', focus: 'keep sk-FIXTUREfocus12345', summary_budget: 8000 })
    expect(out.body.ok).toBe(true)
    const sent = JSON.stringify(bridgeRequestMock.mock.calls[0][0])
    expect(sent).not.toMatch(/FIXTUREabcdefgh1234|fixtureBearerToken123|FIXTUREAPIKEY12345|FIXTURE9876543210|FIXTURE0000000000|FIXTUREfocus12345/)
    expect(sent).toContain('[redacted-api-key]')
    expect(sent).toContain('Bearer [redacted]')
    expect(sent).toContain('curl -H')
  })

  // hermes-v051:R1-14 each request has its own bridge worker: a retry never queues behind an orphaned call.
  it('gives every summary request its own bridge worker key', async () => {
    const { issueClaudeSummaryToken } = await tokens()
    const token = issueClaudeSummaryToken('studio-1', 'default')
    await post('summary', token, { session_id: 'studio-1', rows, summary_budget: 8000 })
    await post('summary', token, { session_id: 'studio-1', rows, summary_budget: 8000 })
    const [first, second] = bridgeRequestMock.mock.calls.map(call => call[0].worker_key)
    expect(first).toMatch(/^default:compression:studio-1:[0-9a-f]{8,}$/)
    expect(second).toMatch(/^default:compression:studio-1:[0-9a-f]{8,}$/)
    expect(first).not.toBe(second)
  })

  // hermes-v051:R1-13 the whole summary is bounded by the deadline, and a closed wrapper connection starts no further chunk.
  it('answers timeout when the summarizer outlives the deadline', async () => {
    bridgeRequestMock.mockImplementation(() => new Promise(() => {}))
    const { summarizeClaudeTranscript } = await service()
    const started = Date.now()
    const out = await summarizeClaudeTranscript('default', { model: 'fixture-summary-model', timeoutMs: 80, chunkTokens: 30_000 }, { records: rows, summaryBudget: 8000 })
    expect(out).toEqual({ ok: false, reason: 'timeout' })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('starts no further chunk after the wrapper closes the connection', async () => {
    getModelContextLengthMock.mockReturnValue(40_000)
    let release: (value: unknown) => void = () => {}
    bridgeRequestMock.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const { issueClaudeSummaryToken } = await tokens()
    const big = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ` + 'word '.repeat(9000) }))
    const body = JSON.stringify({ session_id: 'studio-1', rows: big, summary_budget: 8000 })
    const { request } = await import('node:http')
    const req = request(`${base}/summary`, { method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${issueClaudeSummaryToken('studio-1', 'default')}` } })
    const response = new Promise<any>(resolve => req.on('response', resolve))
    req.on('error', () => {})
    req.end(body)
    expect((await response).headers['x-hermes-summary-deadline-ms']).toBeTruthy()
    for (let i = 0; i < 100 && bridgeRequestMock.mock.calls.length < 1; i++) await new Promise(r => setTimeout(r, 20))
    req.destroy()
    await new Promise(r => setTimeout(r, 100))
    release({ status: 'completed', result: { final_response: SUMMARY } })
    await new Promise(r => setTimeout(r, 300))
    expect(bridgeRequestMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['auto', { auxiliary: { compression: { provider: 'auto' } } }],
    ['unset', {}],
    ['provider without model', { auxiliary: { compression: { provider: 'custom:example-grok' } } }],
  ])('reports unavailable immediately when the auxiliary compression model is %s', async (_name, config) => {
    readConfigYamlForProfileMock.mockResolvedValue(config)
    const { issueClaudeSummaryToken } = await tokens()
    const out = await post('summary', issueClaudeSummaryToken('studio-1', 'default'), { session_id: 'studio-1', rows, summary_budget: 8000 })
    expect(out).toMatchObject({ status: 200, deadline: null, body: { ok: false, reason: 'unavailable' } })
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })

  it('reports an error notice from the summarizer as invalid_summary and a bridge failure as failed', async () => {
    const { issueClaudeSummaryToken } = await tokens()
    const token = issueClaudeSummaryToken('studio-1', 'default')
    bridgeRequestMock.mockResolvedValueOnce({ status: 'completed', result: { final_response: 'Context window exceeded, use /compress' } })
    expect((await post('summary', token, { session_id: 'studio-1', rows, summary_budget: 8000 })).body).toEqual({ ok: false, reason: 'invalid_summary' })
    bridgeRequestMock.mockResolvedValueOnce({ status: 'error', error: 'upstream 401 for key sk-fixture0000000000' })
    const failed = await post('summary', token, { session_id: 'studio-1', rows, summary_budget: 8000 })
    expect(failed.body).toEqual({ ok: false, reason: 'failed' })
    const { logger } = await import('../../packages/server/src/modules/studio/public/logging')
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('sk-fixture0000000000')
  })

  it('rejects a wrong token, another session\'s token and a token whose run has ended', async () => {
    const { issueClaudeSummaryToken, claudeSummaryTokenProfile } = await tokens()
    const token = issueClaudeSummaryToken('studio-1', 'default')
    issueClaudeSummaryToken('studio-2', 'default')
    expect((await post('summary', 'wrong-token', { session_id: 'studio-1', rows })).status).toBe(401)
    expect((await post('summary', token, { session_id: 'studio-2', rows })).status).toBe(401)
    expect((await post('summary', token, { rows })).status).toBe(401)
    hasSessionMock.mockReturnValue(false)
    expect((await post('summary', token, { session_id: 'studio-1', rows })).body).toEqual({ ok: false, reason: 'unauthorized' })
    expect(claudeSummaryTokenProfile('studio-1', token)).toBeNull()
    hasSessionMock.mockReturnValue(true)
    expect((await post('summary', token, { session_id: 'studio-1', rows })).status).toBe(401)
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })

  it('refuses requests relayed with forwarding headers and malformed bodies', async () => {
    const { issueClaudeSummaryToken } = await tokens()
    const token = issueClaudeSummaryToken('studio-1', 'default')
    for (const header of ['x-forwarded-for', 'forwarded', 'x-real-ip']) {
      expect((await post('summary', token, { session_id: 'studio-1', rows }, { [header]: '203.0.113.9' })).status).toBe(403)
    }
    expect((await post('summary', token, { session_id: 'studio-1', rows: 'not rows' })).status).toBe(400)
    expect((await post('summary', token, { session_id: 'studio-1', rows, previous_summary: 7 })).status).toBe(400)
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })

  it('refuses non-loopback peers before reading the token', async () => {
    const { claudeContextSummary } = await service()
    for (const remoteAddress of ['198.51.100.8', '203.0.113.2', '::ffff:198.51.100.8', undefined]) {
      const ctx: any = { req: { socket: { remoteAddress } }, get: () => '', request: { body: {} }, set: vi.fn() }
      await claudeContextSummary(ctx)
      expect(ctx.status).toBe(403)
      expect(ctx.body).toEqual({ ok: false, reason: 'forbidden' })
    }
  })

  it('serves the effective compression settings of the token\'s profile for the next turn', async () => {
    resolveSettingsMock.mockResolvedValue({ followMain: true, own: {}, main: {}, effective: { enabled: false, threshold: 0.8, targetRatio: 0.5, protectLastN: 30, protectFirstN: 2 } })
    const { issueClaudeSummaryToken } = await tokens()
    const token = issueClaudeSummaryToken('studio-1', 'work')
    const out = await post('settings', token, { session_id: 'studio-1' })
    expect(out.body).toEqual({ ok: true, env: {
      HERMES_CC_COMPACT_ENABLED: '0', HERMES_CC_COMPACT_THRESHOLD: '0.8', HERMES_CC_COMPACT_TARGET_RATIO: '0.5',
      HERMES_CC_COMPACT_PROTECT_LAST_N: '30', HERMES_CC_COMPACT_PROTECT_FIRST_N: '2',
    } })
    expect(resolveSettingsMock).toHaveBeenCalledWith(expect.any(String), 'work')
    expect((await post('settings', 'wrong', { session_id: 'studio-1' })).status).toBe(401)
  })
})
