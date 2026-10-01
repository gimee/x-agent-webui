import { describe, expect, it, vi } from 'vitest'

const summarizerCalls: string[] = []
let summarizerReply: (prompt: string) => any = () => ({ status: 'completed', result: { completed: true, final_response: validSummary('S') } })
vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
  createPrimaryAgentBridge: () => ({
    request: async (req: any) => {
      const prompt = req.conversation_history.at(-1).content
      summarizerCalls.push(prompt)
      return summarizerReply(prompt)
    },
    destroy: async () => undefined,
  }),
}))
vi.mock('../../packages/server/src/modules/studio/repositories/compression-snapshot', () => ({
  getCompressionSnapshot: () => null,
  saveCompressionSnapshot: vi.fn(() => true),
  deleteCompressionSnapshot: vi.fn(),
}))

function validSummary(tag: string) { return `## Active Task\n${tag} ` + 'detail '.repeat(200) }
const { ChatContextCompressor, budgetTailStart, chunkForSummary, assertUsableSummary, countTokens, serializeForSummary } = await import('../../packages/server/src/modules/studio/services/context-compressor')
const { compressionBudgets } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')

const msg = (i: number, words: number) => ({ role: i % 2 ? 'assistant' : 'user', content: `M${i} ` + 'word '.repeat(words), cursorId: i + 1 }) as any

describe('Settings → Context compression semantics', () => {
  it('retained history follows target_ratio (summary slice + verbatim tail), capped below the trigger', () => {
    // User settings: 512K window, threshold 0.8, target 0.5 → 256K retained.
    expect(compressionBudgets(512_000, 0.8, 0.5)).toEqual({ summaryBudget: 16_000, tailTokenBudget: 240_000, summaryInputTokens: 120_000, summarizationTimeoutMs: 900_000 })
    // Ratio above threshold cannot re-trigger: capped at 80% of the trigger.
    const b = compressionBudgets(200_000, 0.5, 0.8)
    expect(b.summaryBudget + b.tailTokenBudget).toBe(80_000)
    expect(compressionBudgets(100_000, 0.5, 0.05).summaryBudget).toBe(4_000)
  })

  it('verbatim tail is chosen by token budget, protect_last_n is a floor, tool pairs stay whole', () => {
    const messages = Array.from({ length: 40 }, (_, i) => msg(i, 100))
    const per = countTokens(`M1 ` + 'word '.repeat(100))
    const start = budgetTailStart(messages, 0, 3, per * 10.5)
    expect(40 - start).toBeGreaterThanOrEqual(9)
    expect(40 - start).toBeLessThanOrEqual(11)
    expect(budgetTailStart(messages, 0, 20, per * 2)).toBe(20)
    const withTool = [msg(0, 10), { role: 'assistant', content: '', tool_calls: [{ id: 't', function: { name: 'x', arguments: '{}' } }] }, { role: 'tool', content: 'r'.repeat(50), tool_call_id: 't', name: 'x' }, msg(3, 10)] as any
    const s = budgetTailStart(withTool, 0, 2, 1)
    expect(withTool[s].role).not.toBe('tool')
  })

  it('full compression keeps the budgeted tail verbatim instead of only protect_last_n messages', async () => {
    summarizerCalls.length = 0
    const messages = Array.from({ length: 200 }, (_, i) => msg(i, 200))
    const per = countTokens(`M1 ` + 'word '.repeat(200))
    const compressor = new ChatContextCompressor({ config: { triggerTokens: per * 150, summaryBudget: 4_000, tailTokenBudget: per * 60, tailMessageCount: 5, headMessageCount: 3, summaryInputTokens: 0 } })
    const out = await compressor.compress(messages, '', undefined, 's1')
    const verbatimTail = out.messages.filter((m: any) => typeof m.content === 'string' && /^M\d+ /.test(m.content)).length - 3
    expect(verbatimTail).toBeGreaterThanOrEqual(55)
    expect(verbatimTail).toBeLessThanOrEqual(62)
    expect(out.meta.llmCompressed).toBe(true)
  })

  it('a span larger than the summarizer input budget is summarized in chunks, each within the budget', async () => {
    summarizerCalls.length = 0
    const messages = Array.from({ length: 120 }, (_, i) => msg(i, 300))
    const chunks = chunkForSummary(messages.slice(3, 100), 20_000)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(countTokens(c)).toBeLessThanOrEqual(20_000)
    const compressor = new ChatContextCompressor({ config: { triggerTokens: 50_000, summaryBudget: 4_000, tailTokenBudget: 5_000, tailMessageCount: 5, headMessageCount: 3, summaryInputTokens: 20_000 } })
    await compressor.compress(messages, '', undefined, 's2')
    expect(summarizerCalls.length).toBeGreaterThan(1)
  })

  it('real-size chunks (>256 KB of CJK text) reach the summarizer whole; only a single oversized message is cut', () => {
    // countTokens switches to a UTF-8 byte estimate above 256 KB; chunk sizing must not compare that against the token budget.
    const cjk = (i: number, chars: number) => ({ role: i % 2 ? 'assistant' : 'user', content: `M${i}# ` + '压缩后保留历史 target 42 行 /app/x.ts; '.repeat(Math.ceil(chars / 30)).slice(0, chars) + ` #END${i}` }) as any
    const messages = Array.from({ length: 90 }, (_, i) => cjk(i, 7_000))
    const chunks = chunkForSummary(messages, 150_000)
    expect(chunks.length).toBeGreaterThan(1)
    expect(Math.max(...chunks.map(c => Buffer.byteLength(c)))).toBeGreaterThan(256 * 1024)
    for (const c of chunks) expect(c).not.toContain('[Summary truncated')
    const joined = chunks.join('\n\n')
    for (let i = 0; i < 90; i++) expect(joined).toContain(`#END${i}`)
    expect(joined).toBe(serializeForSummary(messages))

    const oversized = chunkForSummary([cjk(0, 2_000), cjk(1, 60_000), cjk(2, 2_000)], 20_000)
    expect(oversized.join('')).toContain('#END0')
    expect(oversized.join('')).toContain('#END2')
    expect(oversized.join('')).not.toContain('#END1')
    expect(oversized.join('')).toContain('[Summary truncated')
  }, 60_000)

  it('a failed summarizer turn or error notice is never stored as the summary; history stays verbatim', async () => {
    const notice = 'Context overflow and auto-compaction is disabled (compression.enabled: false). Run /compress to compact manually, /new to start fresh, or switch to a larger-context model.'
    expect(() => assertUsableSummary(notice, 50_000)).toThrow(/error notice/)
    expect(() => assertUsableSummary('ok', 50_000)).toThrow(/too short/)
    expect(assertUsableSummary(validSummary('fine'), 50_000)).toContain('fine')
    const { saveCompressionSnapshot } = await import('../../packages/server/src/modules/studio/repositories/compression-snapshot') as any
    saveCompressionSnapshot.mockClear()
    for (const reply of [{ status: 'completed', result: { completed: true, final_response: notice } }, { status: 'completed', result: { completed: false, failed: true, final_response: notice } }, { status: 'running', output: validSummary('PARTIAL') }, { status: 'interrupted', output: validSummary('PARTIAL') }]) {
      summarizerReply = () => reply
      const messages = Array.from({ length: 60 }, (_, i) => msg(i, 400))
      const out = await new ChatContextCompressor({ config: { triggerTokens: 20_000, summaryBudget: 4_000, tailTokenBudget: 5_000, tailMessageCount: 5, headMessageCount: 3 } }).compress(messages, '', undefined, 's3')
      expect(out.meta.llmCompressed).toBe(false)
      expect(JSON.stringify(out.messages)).not.toContain('auto-compaction is disabled')
      expect(JSON.stringify(out.messages)).not.toContain('PARTIAL')
    }
    expect(saveCompressionSnapshot).not.toHaveBeenCalled()
    summarizerReply = () => ({ status: 'completed', result: { completed: true, final_response: validSummary('S') } })
  })
})
