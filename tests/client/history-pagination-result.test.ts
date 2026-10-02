import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import ts from 'typescript'

// Exercise the real view's pagination function without mounting the entire navigation shell.
const view = readFileSync(resolve('packages/client/src/views/hermes/HistoryView.vue'), 'utf8')
const start = view.indexOf('async function loadOlderHistoryMessages(')
const end = view.indexOf('\nasync function handleSessionClick(', start)
if (start < 0 || end < 0) throw new Error('History pagination function boundary not found')
const compiled = ts.transpileModule(view.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

function harness(page: unknown) {
  const target = { id: 'synthetic', profile: 'research', messages: [{ id: '2' }], loadedMessageCount: 1,
    hasMoreBefore: true, isLoadingOlderMessages: false, messageTotal: 3, messageCount: 3 }
  const current = { value: target }
  const fetchPage = vi.fn(async () => page)
  const load = new Function('historySession', 'fetchSessionMessagesPage', 'HISTORY_PAGE_SIZE', 'mapHistoryMessages',
    `${compiled}; return loadOlderHistoryMessages`)(current, fetchPage, 150, (messages: unknown[]) => messages)
  return { target, current, fetchPage, load }
}

describe('HistoryView older-page result semantics', () => {
  it('keeps earlier history retryable after a failed request', async () => {
    const { target, load } = harness(null)
    expect(await load('synthetic')).toBe(false)
    expect(target.hasMoreBefore).toBe(true)
    expect(target.loadedMessageCount).toBe(1)
    expect(target.isLoadingOlderMessages).toBe(false)
  })

  it('continues across a duplicate-only page when the server cursor advances', async () => {
    const { target, fetchPage, load } = harness({ messages: [{ id: '2' }], total: 3, hasMore: true })
    expect(await load('synthetic')).toBe(true)
    expect(fetchPage).toHaveBeenCalledWith('synthetic', 1, 150, 'research')
    expect(target.messages).toEqual([{ id: '2' }])
    expect(target.loadedMessageCount).toBe(2)
    expect(target.hasMoreBefore).toBe(true)
  })

  it('recognizes an empty terminal page', async () => {
    const { target, load } = harness({ messages: [], total: 1, hasMore: false })
    expect(await load('synthetic')).toBe(false)
    expect(target.hasMoreBefore).toBe(false)
  })

  it('does not declare completion for an empty nonterminal page', async () => {
    const { target, load } = harness({ messages: [], total: 3, hasMore: true })
    expect(await load('synthetic')).toBe(false)
    expect(target.hasMoreBefore).toBe(true)
  })

  it('discards a delayed page after the active session is cleared', async () => {
    const { target, current, load } = harness({ messages: [{ id: '1' }], total: 2, hasMore: false })
    const pending = load('synthetic')
    current.value = null as never
    expect(await pending).toBe(false)
    expect(target.messages).toEqual([{ id: '2' }])
    expect(target.loadedMessageCount).toBe(1)
  })
})
