// hermes-v050:S8 resume 一次带够最近 N 个用户轮次：真实 SQLite（内存库）上验证行数计算、截断、分页元数据与上限。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Row = { role: string; content: string; display_role?: string | null; tool_call_id?: string | null }

// 13 个完整轮次（user + 40 tool + assistant），最后一轮进行到一半（user + 300 tool）：
// 最新 150 行全是 tool，原来客户端要先并一次最新页、再串行补 4 页才够 10 轮。
function transcript(): Row[] {
  const rows: Row[] = []
  for (let turn = 0; turn < 13; turn += 1) {
    rows.push({ role: turn === 5 ? 'command' : 'user', content: `question ${turn}` })
    for (let tool = 0; tool < 40; tool += 1) rows.push({ role: 'tool', content: `tool ${turn}.${tool}`, tool_call_id: `c${turn}.${tool}` })
    rows.push({ role: 'assistant', content: `answer ${turn}` })
  }
  rows.push({ role: 'user', content: 'question 13' })
  for (let tool = 0; tool < 300; tool += 1) {
    rows.push({ role: 'tool', content: tool === 7 ? 'x'.repeat(5_000) : `tool 13.${tool}`, tool_call_id: `c13.${tool}` })
  }
  return rows
}

function countTurns(messages: Array<{ role?: string; display_role?: string | null }>): number {
  return messages.filter(message => message.role !== 'tool' && ['user', 'command'].includes(String(message.display_role || message.role))).length
}

describe('resume turn window (S8)', () => {
  let db: any
  let ids: number[]

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      isSqliteAvailable: () => true,
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    const store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    store.createSession({ id: 's1', profile: 'default', source: 'coding_agent', model: 'test', provider: 'test' })
    const insert = db.prepare('INSERT INTO messages (session_id, role, content, display_role, tool_call_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
    ids = transcript().map((row, index) => Number(insert.run('s1', row.role, row.content, row.display_role ?? null, row.tool_call_id ?? null, index + 1).lastInsertRowid))
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })

  async function coldResumePage() {
    const store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const { handleMessage } = await import('../../packages/server/src/modules/studio/services/chat-run/message-format')
    const { buildResumeMessagePage } = await import('../../packages/server/src/modules/studio/services/chat-run/resume-payload')
    // 与 loadSessionStateFromDb 相同的冷启动快照
    const detail = store.getSessionDetailPaginated('s1')!
    const messages = handleMessage(detail.messages, 's1')
    return buildResumeMessagePage(messages, { limit: detail.limit, messageTotal: detail.total, messageStateBaselineCount: messages.length })
  }

  it('counts only id/role rows to find how far back N user turns start', async () => {
    const store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    // offset 150 起往前：第 13 轮的 user 在第 301 行（倒数），再往前每 42 行一轮
    expect(store.countSessionRowsForTurns('s1', 150, 1, 5_000)).toBe(151)
    expect(store.countSessionRowsForTurns('s1', 150, 3, 5_000)).toBe(151 + 42 * 2)
    // 上限：数不够也只到上限
    expect(store.countSessionRowsForTurns('s1', 150, 10, 100)).toBe(100)
    // 尽头：行数不足时返回剩余全部
    expect(store.countSessionRowsForTurns('s1', 150, 99, 5_000)).toBe(ids.length - 150)
  })

  it('prepends older display rows until the page carries N user turns', async () => {
    const { extendResumePageToMinTurns } = await import('../../packages/server/src/modules/studio/services/chat-run/resume-turn-window')
    const page = await coldResumePage()
    expect(countTurns(page.messages)).toBe(0)
    expect(page.messageLoadedCount).toBe(150)

    const extended = extendResumePageToMinTurns('s1', page, 10)
    // 最新页原样保留（旧客户端依赖的 messages 字段不变），更早的行单独给
    expect(extended.messages).toBe(page.messages)
    const older = extended.olderMessages!
    expect(countTurns([...older, ...extended.messages])).toBe(10)
    // 起点正好是第 10 个用户轮次（倒数），行按 id 升序连续
    expect(older[0].content).toBe('question 4')
    const all = [...older, ...extended.messages].map(message => Number(message.id))
    expect(all).toEqual(ids.slice(ids.length - all.length))
    expect(extended.messageLoadedCount).toBe(all.length)
    expect(extended.messageTotal).toBe(ids.length)
    expect(extended.hasMoreBefore).toBe(true)
    // 与 resume 同样的展示截断（持久化历史不变）
    const huge = [...older, ...extended.messages].find(message => String(message.content).startsWith('xxxx'))
    expect((huge as any)?.content_truncated).toBe(true)
  })

  it('treats command rows and display_role like the client turn counter', async () => {
    const { extendResumePageToMinTurns } = await import('../../packages/server/src/modules/studio/services/chat-run/resume-turn-window')
    const extended = extendResumePageToMinTurns('s1', await coldResumePage(), 9)
    // 第 5 轮是 command，也算一个轮次
    expect(extended.olderMessages![0].content).toBe('question 5')
    expect(extended.olderMessages![0].role).toBe('command')
  })

  it('leaves the page alone when it already has enough turns or nothing older exists', async () => {
    const { extendResumePageToMinTurns } = await import('../../packages/server/src/modules/studio/services/chat-run/resume-turn-window')
    const page = await coldResumePage()
    expect(extendResumePageToMinTurns('s1', page, 0)).toBe(page)
    const noMore = { ...page, hasMoreBefore: false }
    expect(extendResumePageToMinTurns('s1', noMore, 10)).toBe(noMore)
    const full = { ...page, messages: [...page.messages, { id: 1, session_id: 's1', role: 'user', content: 'q', timestamp: 1 } as any] }
    expect(extendResumePageToMinTurns('s1', full, 1)).toBe(full)
  })

  it('caps the extra rows so a pathological session cannot build an unbounded payload', async () => {
    const { extendResumePageToMinTurns } = await import('../../packages/server/src/modules/studio/services/chat-run/resume-turn-window')
    const page = await coldResumePage()
    const extended = extendResumePageToMinTurns('s1', page, 10, { maxRows: 200 })
    expect(extended.messageLoadedCount).toBe(200)
    expect(extended.olderMessages).toHaveLength(50)
    expect(extended.hasMoreBefore).toBe(true)
  })

  it('parses the optional min_turns request field defensively', async () => {
    const { parseResumeMinTurns, RESUME_MIN_TURNS_MAX } = await import('../../packages/server/src/modules/studio/services/chat-run/resume-turn-window')
    expect(parseResumeMinTurns(undefined)).toBeUndefined()
    expect(parseResumeMinTurns('10')).toBeUndefined()
    expect(parseResumeMinTurns(0)).toBeUndefined()
    expect(parseResumeMinTurns(Number.NaN)).toBeUndefined()
    expect(parseResumeMinTurns(10)).toBe(10)
    expect(parseResumeMinTurns(10.7)).toBe(10)
    expect(parseResumeMinTurns(10_000)).toBe(RESUME_MIN_TURNS_MAX)
  })
})
