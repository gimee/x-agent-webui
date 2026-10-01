import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// hermes-v051:A protocol cross-check: the real bin/claude-context wrapper against the real
// summary/settings routes (only the Hermes bridge, config and run liveness are faked).
const bridgeRequestMock = vi.fn()
vi.mock('../../packages/server/src/modules/coding-agents/services/runtime/run-manager', () => ({
  codingAgentRunManager: { hasSession: vi.fn(() => true) },
  sanitizeCodingAgentTerminalOutput: (value: string) => value.replace(/\bsk-[A-Za-z0-9._-]{8,}/g, '[redacted-api-key]'),
}))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  readConfigYamlForProfile: vi.fn(async () => ({ auxiliary: { compression: { provider: 'custom:example-grok', model: 'fixture-summary-model', reasoning_effort: 'none' } } })),
}))
vi.mock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({ getModelContextLength: vi.fn(() => 1_000_000) }))
vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
  createPrimaryAgentBridge: vi.fn(() => ({ request: bridgeRequestMock, destroy: vi.fn(async () => undefined) })),
}))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({ getSession: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/repositories/compression-snapshot', () => ({
  getCompressionSnapshot: vi.fn(), saveCompressionSnapshot: vi.fn(), deleteCompressionSnapshot: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bridgeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

describe('Claude wrapper ↔ WebUI summary endpoint', () => {
  it('the real wrapper gets its summary from the auxiliary model through the real route', async () => {
    const SUMMARY = 'Auxiliary summary written by grok for the successor. '.repeat(20).trim()
    bridgeRequestMock.mockResolvedValue({ status: 'completed', result: { final_response: SUMMARY } })
    const Koa = (await import('koa')).default
    const { createRequestBodyParser } = await import('../../packages/server/src/modules/studio/middleware/request-body-parser')
    const { claudeContextRoutes } = await import('../../packages/server/src/modules/coding-agents/routes/claude-context')
    const { issueClaudeSummaryToken, setClaudeSummaryBaseUrl, claudeSummaryUrl } = await import('../../packages/server/src/modules/coding-agents/services/claude-summary/tokens')
    const app = new Koa()
    app.use(createRequestBodyParser())
    app.use(claudeContextRoutes.routes())
    const server: Server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    cleanups.push(() => new Promise(resolve => server.close(resolve)))
    setClaudeSummaryBaseUrl(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    const { fixture } = await import('../claude-context/flow-fixture.mjs')
    const f = await fixture({ after: (fn: () => unknown) => cleanups.push(fn) }, { tokens: 410000 })
    const token = issueClaudeSummaryToken('studio-fixture', 'profile-fixture')
    const out = await f.start('SUCCESSOR_REQUEST', { HERMES_CC_SUMMARY_URL: claudeSummaryUrl(), HERMES_CC_SUMMARY_TOKEN: token }).done
    expect(out.code, out.stderr).toBe(0)
    expect((await f.calls()).filter((c: any) => c.stage).map((c: any) => c.stage)).toEqual(['context', 'request'])
    expect((await f.calls()).at(-1).input).toContain(SUMMARY)
    expect(out.stdout).toContain('"summarizer":"aux"')
    expect(out.stderr).not.toContain(token)
    const [request] = bridgeRequestMock.mock.calls[0]
    expect(request).toMatchObject({ model: 'fixture-summary-model', provider: 'custom:example-grok', reasoning_effort: 'none', profile: 'profile-fixture', worker_key: expect.stringMatching(/^profile-fixture:compression:studio-fixture:/) })
    expect(request.conversation_history.at(-1).content).toContain('FIXTURE_MARKER')
    expect(request.conversation_history.at(-1).content).not.toContain('SUCCESSOR_REQUEST')
    expect((await f.records('checkpoint')).summary).toBe(SUMMARY)
  }, 30_000)
})
