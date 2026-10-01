// hermes-v051:T1 — 编程工具对话（Claude/Codex/Pi）标题自动生成：第 1 轮成功结束后调 bridge generate_title，
// 第 2、3 轮若仍是临时标题再试；手动改过的不覆盖；辅助模型不可用保持首句截断、不报错。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  updateSession: vi.fn(),
  getFirstSessionMessageByRole: vi.fn(),
  getSessionMessageCountByRole: vi.fn(),
  generateTitle: vi.fn(),
  createPrimaryAgentBridge: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSession: mocks.getSession,
  updateSession: mocks.updateSession,
  getFirstSessionMessageByRole: mocks.getFirstSessionMessageByRole,
  getSessionMessageCountByRole: mocks.getSessionMessageCountByRole,
}))
vi.mock('../../packages/server/src/modules/studio/public/sessions', () => ({
  getSession: mocks.getSession,
  updateSession: mocks.updateSession,
  getFirstSessionMessageByRole: mocks.getFirstSessionMessageByRole,
  getSessionMessageCountByRole: mocks.getSessionMessageCountByRole,
}))
vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
  createPrimaryAgentBridge: mocks.createPrimaryAgentBridge,
}))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: mocks.logger,
  bridgeLogger: mocks.logger,
}))

import {
  runCodingAgentAutoTitle,
  scheduleCodingAgentAutoTitle,
} from '../../packages/server/src/modules/coding-agents/services/runtime/auto-title'

const FIRST = '把 nova notes 的三场会议纪要整理好，分成 2 份待办，然后核对负责人，最后把结果整理成表格发给我'

function session(overrides: Record<string, unknown> = {}) {
  return { id: 's1', source: 'coding_agent', agent: 'claude', title: null, preview: FIRST, ...overrides }
}

describe('hermes-v051:T1 coding-agent auto title', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createPrimaryAgentBridge.mockReturnValue({ generateTitle: mocks.generateTitle })
    mocks.getSession.mockReturnValue(session())
    mocks.getSessionMessageCountByRole.mockReturnValue(1)
    mocks.getFirstSessionMessageByRole.mockReturnValue({ role: 'user', content: FIRST })
    mocks.generateTitle.mockResolvedValue({ ok: true, title: '整理三场评审会议纪要' })
  })

  it('titles the session after the first successful turn and pushes session.title.updated', async () => {
    const emit = vi.fn()
    const title = await runCodingAgentAutoTitle({ sessionId: 's1', profile: 'research', agentId: 'claude-code' }, emit)

    expect(title).toBe('整理三场评审会议纪要')
    expect(mocks.generateTitle).toHaveBeenCalledWith(FIRST, 'research', expect.objectContaining({ timeoutMs: expect.any(Number) }))
    expect(mocks.getFirstSessionMessageByRole).toHaveBeenCalledWith('s1', 'user')
    expect(mocks.updateSession).toHaveBeenCalledWith('s1', { title: '整理三场评审会议纪要' })
    expect(emit).toHaveBeenCalledWith('s1', 'session.title.updated', {
      event: 'session.title.updated',
      session_id: 's1',
      title: '整理三场评审会议纪要',
    })
  })

  it('retries on turns 2 and 3 while the title is still the first-line placeholder, then stops', async () => {
    const emit = vi.fn()
    mocks.getSession.mockReturnValue(session({ title: FIRST.slice(0, 40) + '...' }))
    for (const turns of [2, 3]) {
      mocks.getSessionMessageCountByRole.mockReturnValue(turns)
      await runCodingAgentAutoTitle({ sessionId: 's1', profile: 'default', agentId: 'claude-code' }, emit)
    }
    expect(mocks.generateTitle).toHaveBeenCalledTimes(2)

    mocks.generateTitle.mockClear()
    mocks.getSessionMessageCountByRole.mockReturnValue(4)
    const skipped = await runCodingAgentAutoTitle({ sessionId: 's1', profile: 'default', agentId: 'claude-code' }, emit)
    expect(skipped).toBeNull()
    expect(mocks.generateTitle).not.toHaveBeenCalled()
  })

  // hermes-v051:T1 R3-07: retries title from the first message plus the current turn's message.
  it('retries on turns 2-3 with the first message plus the current user turn, within the Hermes budget', async () => {
    const emit = vi.fn()
    mocks.getSession.mockReturnValue(session({ title: FIRST.slice(0, 40) + '...' }))
    mocks.getSessionMessageCountByRole.mockReturnValue(2)
    const messages = [
      { role: 'user', content: FIRST },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: '另外把 3 号项目的待办也查一下' },
      { role: 'assistant', content: '查好了' },
    ]
    await runCodingAgentAutoTitle({ sessionId: 's1', profile: 'default', agentId: 'claude-code', messages }, emit)
    expect(mocks.generateTitle).toHaveBeenCalledWith(`${FIRST}\n\n另外把 3 号项目的待办也查一下`, 'default', expect.anything())

    mocks.generateTitle.mockClear()
    mocks.getFirstSessionMessageByRole.mockReturnValue({ role: 'user', content: '头'.repeat(3000) })
    await runCodingAgentAutoTitle({
      sessionId: 's1', profile: 'default', agentId: 'claude-code',
      messages: [{ role: 'user', content: '头'.repeat(3000) }, { role: 'user', content: '尾'.repeat(3000) }],
    }, emit)
    const input: string = mocks.generateTitle.mock.calls[0][0]
    expect(input.length).toBeLessThanOrEqual(1000)
    expect(input).toContain('尾')
    expect(input.startsWith('头')).toBe(true)
  })

  it('titles turn 1 from the first message alone', async () => {
    await runCodingAgentAutoTitle({
      sessionId: 's1', profile: 'default', agentId: 'claude-code',
      messages: [{ role: 'user', content: FIRST }],
    }, vi.fn())
    expect(mocks.generateTitle).toHaveBeenCalledWith(FIRST, 'default', expect.anything())
  })

  it('does not retry after a deterministic failure (disabled / unavailable), but does after a transient one', async () => {
    const emit = vi.fn()
    mocks.getSession.mockImplementation((id: string) => session({ id }))
    mocks.generateTitle.mockResolvedValueOnce({ ok: true, title: null, reason: 'disabled' })
    await runCodingAgentAutoTitle({ sessionId: 'det-1', profile: 'default', agentId: 'claude-code' }, emit)
    mocks.getSessionMessageCountByRole.mockReturnValue(2)
    await runCodingAgentAutoTitle({ sessionId: 'det-1', profile: 'default', agentId: 'claude-code' }, emit)
    expect(mocks.generateTitle).toHaveBeenCalledTimes(1)

    mocks.generateTitle.mockClear()
    mocks.getSessionMessageCountByRole.mockReturnValue(1)
    mocks.generateTitle.mockResolvedValueOnce({ ok: true, title: null, reason: 'http_400' })
    await runCodingAgentAutoTitle({ sessionId: 'det-2', profile: 'default', agentId: 'claude-code' }, emit)
    mocks.getSessionMessageCountByRole.mockReturnValue(2)
    await runCodingAgentAutoTitle({ sessionId: 'det-2', profile: 'default', agentId: 'claude-code' }, emit)
    expect(mocks.generateTitle).toHaveBeenCalledTimes(2)
  })

  it('schedule extracts the latest user turn from the run messages', async () => {
    const emit = vi.fn()
    mocks.getSessionMessageCountByRole.mockReturnValue(2)
    mocks.getSession.mockReturnValue(session({ id: 'sched-2', title: FIRST.slice(0, 40) + '...' }))
    scheduleCodingAgentAutoTitle({ sessionId: 'sched-2', profile: 'default', agentId: 'codex' }, emit, [
      { role: 'user', content: FIRST },
      { role: 'user', content: '第二轮的问题' },
      { role: 'assistant', content: 'x' },
    ])
    await vi.waitFor(() => expect(mocks.generateTitle).toHaveBeenCalledWith(`${FIRST}\n\n第二轮的问题`, 'default', expect.anything()))
  })

  it('never overwrites a manually renamed session', async () => {
    const emit = vi.fn()
    mocks.getSession.mockReturnValue(session({ title: '我自己起的名字' }))
    const title = await runCodingAgentAutoTitle({ sessionId: 's1', profile: 'default', agentId: 'claude-code' }, emit)
    expect(title).toBeNull()
    expect(mocks.generateTitle).not.toHaveBeenCalled()
    expect(mocks.updateSession).not.toHaveBeenCalled()
  })

  it('re-checks after the model call so a rename made meanwhile wins', async () => {
    const emit = vi.fn()
    mocks.generateTitle.mockImplementationOnce(async () => {
      mocks.getSession.mockReturnValue(session({ title: '用户刚改的名字' }))
      return { ok: true, title: '整理三场评审会议纪要' }
    })
    const title = await runCodingAgentAutoTitle({ sessionId: 's1', profile: 'default', agentId: 'claude-code' }, emit)
    expect(mocks.generateTitle).toHaveBeenCalledTimes(1)
    expect(title).toBeNull()
    expect(mocks.updateSession).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it('keeps the first-line placeholder silently when the auxiliary model is unavailable or fails', async () => {
    const emit = vi.fn()
    mocks.generateTitle.mockResolvedValueOnce({ ok: true, title: null, reason: 'http_400' })
    expect(await runCodingAgentAutoTitle({ sessionId: 's1', profile: 'default', agentId: 'claude-code' }, emit)).toBeNull()
    mocks.generateTitle.mockRejectedValueOnce(new Error('Agent bridge request timed out'))
    expect(await runCodingAgentAutoTitle({ sessionId: 's1', profile: 'default', agentId: 'claude-code' }, emit)).toBeNull()
    mocks.createPrimaryAgentBridge.mockImplementationOnce(() => { throw new Error('Studio chat Agent runtime has not been configured') })
    expect(await runCodingAgentAutoTitle({ sessionId: 's1', profile: 'default', agentId: 'claude-code' }, emit)).toBeNull()
    expect(mocks.updateSession).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    expect(mocks.logger.error).not.toHaveBeenCalled()
  })

  it('rejects answer-shaped model output (T3) and keeps the placeholder', async () => {
    const emit = vi.fn()
    mocks.generateTitle.mockResolvedValueOnce({ ok: true, title: '好的，我来帮你把评审会的会议纪要整理好。' })
    expect(await runCodingAgentAutoTitle({ sessionId: 's1', profile: 'default', agentId: 'claude-code' }, emit)).toBeNull()
    expect(mocks.updateSession).not.toHaveBeenCalled()
  })

  it('uses the same path for Codex and Pi sessions', async () => {
    for (const [agent, agentId] of [['codex', 'codex'], ['pi', 'pi']] as const) {
      const emit = vi.fn()
      mocks.getSession.mockReturnValue(session({ agent }))
      const title = await runCodingAgentAutoTitle({ sessionId: 's1', profile: 'default', agentId }, emit)
      expect(title).toBe('整理三场评审会议纪要')
      expect(emit).toHaveBeenCalledTimes(1)
    }
  })

  it('reads the text of a content-block first message', async () => {
    mocks.getFirstSessionMessageByRole.mockReturnValue({
      role: 'user',
      content: JSON.stringify([
        { type: 'text', text: '看看这张截图里的报错' },
        { type: 'image', path: '/tmp/x.png', name: 'x.png' },
      ]),
    })
    await runCodingAgentAutoTitle({ sessionId: 's1', profile: 'default', agentId: 'claude-code' }, vi.fn())
    expect(mocks.generateTitle).toHaveBeenCalledWith('看看这张截图里的报错', 'default', expect.anything())
  })

  it('skips sessions that are not coding-agent sessions', async () => {
    mocks.getSession.mockReturnValue(session({ source: 'cli' }))
    expect(await runCodingAgentAutoTitle({ sessionId: 's1', profile: 'default', agentId: 'claude-code' }, vi.fn())).toBeNull()
    expect(mocks.generateTitle).not.toHaveBeenCalled()
  })

  it('schedule never throws and runs one title request per session at a time', async () => {
    let resolveTitle: (value: unknown) => void = () => {}
    mocks.generateTitle.mockImplementation(() => new Promise(resolve => { resolveTitle = resolve }))
    const emit = vi.fn()
    expect(() => scheduleCodingAgentAutoTitle({ sessionId: 's1', profile: 'default', agentId: 'claude-code' }, emit)).not.toThrow()
    scheduleCodingAgentAutoTitle({ sessionId: 's1', profile: 'default', agentId: 'claude-code' }, emit)
    await vi.waitFor(() => expect(mocks.generateTitle).toHaveBeenCalledTimes(1))
    resolveTitle({ ok: true, title: '整理三场评审会议纪要' })
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1))
    expect(() => scheduleCodingAgentAutoTitle(undefined as any, emit)).not.toThrow()
  })
})
