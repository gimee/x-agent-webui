// hermes-v051:T2/T3 — WebUI 采用 Hermes 生成的标题：
// T2 轮询看来源：derived（Agent 回合开头写的首句截断临时标题）继续等，llm/user 才采用；
// T3 中文防线：明显是回答的不采用（超过 30 个汉字、以句号结尾、含换行）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  updateSession: vi.fn(),
  getFirstSessionMessageByRole: vi.fn(),
  getSessionMessageCountByRole: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSession: mocks.getSession,
  updateSession: mocks.updateSession,
  getFirstSessionMessageByRole: mocks.getFirstSessionMessageByRole,
  getSessionMessageCountByRole: mocks.getSessionMessageCountByRole,
}))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: mocks.logger,
  bridgeLogger: mocks.logger,
}))

import {
  pollBridgeGeneratedTitleAfterRun,
  syncBridgeGeneratedTitle,
} from '../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run'
import { isAnswerShapedTitle } from '../../packages/server/src/modules/studio/services/chat-run/session-title'

const FIRST = '帮我把评审会的会议纪要整理好发给全团队'

describe('hermes-v051:T3 answer-shaped title guard', () => {
  it('rejects titles with more than 30 Han characters', () => {
    expect(isAnswerShapedTitle('一'.repeat(30))).toBe(false)
    expect(isAnswerShapedTitle('一'.repeat(31))).toBe(true)
    expect(isAnswerShapedTitle(`Fix ${'错'.repeat(31)} bug`)).toBe(true)
  })

  it('rejects titles ending with a full stop (。 or .)', () => {
    expect(isAnswerShapedTitle('已经帮你转好了。')).toBe(true)
    expect(isAnswerShapedTitle('Done.')).toBe(true)
    expect(isAnswerShapedTitle('Done. ')).toBe(true)
    expect(isAnswerShapedTitle('升级到 v0.5.1')).toBe(false)
    expect(isAnswerShapedTitle('Node.js 内存泄漏排查')).toBe(false)
  })

  it('rejects titles containing a line break', () => {
    expect(isAnswerShapedTitle('整理三场\n评审会议纪要')).toBe(true)
    expect(isAnswerShapedTitle('整理三场\r评审会议纪要')).toBe(true)
  })

  it('accepts normal short titles', () => {
    expect(isAnswerShapedTitle('整理三场评审会议纪要')).toBe(false)
    expect(isAnswerShapedTitle('Postgres connection pool exhaustion')).toBe(false)
    expect(isAnswerShapedTitle('')).toBe(false)
  })
})

describe('hermes-v051:T2 bridge title adoption', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mocks.getSession.mockReturnValue({ id: 's1', source: 'cli', title: FIRST, preview: FIRST })
    mocks.getSessionMessageCountByRole.mockReturnValue(1)
    mocks.getFirstSessionMessageByRole.mockReturnValue({ role: 'user', content: FIRST })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps polling past a derived placeholder and adopts the llm title', async () => {
    const getSessionTitle = vi.fn()
      .mockResolvedValueOnce({ ok: true, title: '', title_source: null })
      .mockResolvedValueOnce({ ok: true, title: '帮我把评审会的会议纪要整理好发给全团队', title_source: 'derived' })
      .mockResolvedValueOnce({ ok: true, title: '帮我把评审会的会议纪要整理好发给全团队', title_source: 'derived' })
      .mockResolvedValue({ ok: true, title: '整理三场评审会议纪要', title_source: 'llm' })
    const emit = vi.fn()

    const done = pollBridgeGeneratedTitleAfterRun({ getSessionTitle } as any, 's1', 'default', emit)
    await vi.advanceTimersByTimeAsync(5_000)
    await done

    expect(getSessionTitle).toHaveBeenCalledTimes(4)
    expect(mocks.updateSession).toHaveBeenCalledWith('s1', expect.objectContaining({ title: '整理三场评审会议纪要' }))
    expect(emit).toHaveBeenCalledWith('session.title.updated', {
      event: 'session.title.updated',
      session_id: 's1',
      title: '整理三场评审会议纪要',
    })
  })

  it('never adopts a derived title, even at the poll timeout', async () => {
    const getSessionTitle = vi.fn().mockResolvedValue({ ok: true, title: '帮我把评审会的会议纪…', title_source: 'derived' })
    const emit = vi.fn()

    const done = pollBridgeGeneratedTitleAfterRun({ getSessionTitle } as any, 's1', 'default', emit)
    await vi.advanceTimersByTimeAsync(50_000)
    await done

    expect(getSessionTitle.mock.calls.length).toBeGreaterThan(50)
    expect(mocks.updateSession).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it('stops at a user title and adopts it like before', async () => {
    const getSessionTitle = vi.fn().mockResolvedValue({ ok: true, title: '用户在 CLI 改的名', title_source: 'user' })
    const emit = vi.fn()
    const done = pollBridgeGeneratedTitleAfterRun({ getSessionTitle } as any, 's1', 'default', emit)
    await vi.advanceTimersByTimeAsync(2_000)
    await done
    expect(getSessionTitle).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('keeps the legacy stop-at-first-title behaviour for a bridge that reports no source', async () => {
    const getSessionTitle = vi.fn().mockResolvedValue({ ok: true, title: '旧 bridge 标题' })
    const emit = vi.fn()
    const done = pollBridgeGeneratedTitleAfterRun({ getSessionTitle } as any, 's1', 'default', emit)
    await vi.advanceTimersByTimeAsync(2_000)
    await done
    expect(getSessionTitle).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('stops without adopting an answer-shaped llm title (T3)', async () => {
    const getSessionTitle = vi.fn().mockResolvedValue({ ok: true, title: '好的，我已经帮你把会议纪要发给团队了。', title_source: 'llm' })
    const emit = vi.fn()
    const done = pollBridgeGeneratedTitleAfterRun({ getSessionTitle } as any, 's1', 'default', emit)
    await vi.advanceTimersByTimeAsync(2_000)
    await done
    expect(getSessionTitle).toHaveBeenCalledTimes(1)
    expect(mocks.updateSession).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it('also polls on the third user turn (Agent retries placeholders through turn 3)', async () => {
    mocks.getSessionMessageCountByRole.mockReturnValue(3)
    const getSessionTitle = vi.fn().mockResolvedValue({ ok: true, title: '整理三场评审会议纪要', title_source: 'llm' })
    const done = pollBridgeGeneratedTitleAfterRun({ getSessionTitle } as any, 's1', 'default', vi.fn())
    await vi.advanceTimersByTimeAsync(2_000)
    await done
    expect(getSessionTitle).toHaveBeenCalledTimes(1)

    mocks.getSessionMessageCountByRole.mockReturnValue(4)
    getSessionTitle.mockClear()
    await pollBridgeGeneratedTitleAfterRun({ getSessionTitle } as any, 's1', 'default', vi.fn())
    expect(getSessionTitle).not.toHaveBeenCalled()
  })

  // hermes-v051:T3 R3-14: the guard is for model output; a name the user set is synced as is.
  it('syncs a user-sourced title even when it looks answer-shaped', async () => {
    const emit = vi.fn()
    expect(syncBridgeGeneratedTitle('s1', '这是我自己起的名字。', emit, 'user')).toBe(true)
    expect(emit).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    const getSessionTitle = vi.fn().mockResolvedValue({ ok: true, title: '我在 CLI 里改的名字。', title_source: 'user' })
    const done = pollBridgeGeneratedTitleAfterRun({ getSessionTitle } as any, 's1', 'default', emit)
    await vi.advanceTimersByTimeAsync(2_000)
    await done
    expect(mocks.updateSession).toHaveBeenCalledWith('s1', expect.objectContaining({ title: '我在 CLI 里改的名字。' }))
  })

  it('still guards model titles that carry no source (legacy bridge / events)', () => {
    const emit = vi.fn()
    expect(syncBridgeGeneratedTitle('s1', '好的，我已经帮你转过去了。', emit)).toBe(false)
    expect(syncBridgeGeneratedTitle('s1', '好的，我已经帮你转过去了。', emit, null)).toBe(false)
    expect(emit).not.toHaveBeenCalled()
  })

  it('in-stream session.title.updated events ignore derived titles and answer-shaped titles', () => {
    const emit = vi.fn()
    expect(syncBridgeGeneratedTitle('s1', '帮我把评审会的…', emit, 'derived')).toBe(false)
    expect(syncBridgeGeneratedTitle('s1', '整理三场\n评审会议纪要', emit, 'llm')).toBe(false)
    expect(emit).not.toHaveBeenCalled()
    expect(syncBridgeGeneratedTitle('s1', '整理三场评审会议纪要', emit, 'llm')).toBe(true)
    expect(emit).toHaveBeenCalledTimes(1)
  })
})
