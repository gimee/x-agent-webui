// Guard test for the community live chat turn window.
// Maintain this behavior directly in the checked-in source.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const CHAT_STORE = 'packages/client/src/stores/hermes/chat.ts'
const MESSAGE_LIST = 'packages/client/src/components/hermes/chat/MessageList.vue'

function extractFunctionBody(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}`)
  if (start < 0) throw new Error(`${name} no longer has the patched shape`)
  let i = start
  let parens = 0
  let angles = 0
  let seenParen = false
  while (i < source.length) {
    const char = source[i]
    if (char === '(') {
      parens += 1
      seenParen = true
    } else if (char === ')') parens -= 1
    else if (char === '<' && !seenParen) angles += 1
    else if (char === '>' && angles > 0) angles -= 1
    else if (char === '{' && parens === 0 && angles === 0 && seenParen) {
      i += 1
      break
    }
    i += 1
  }
  const bodyStart = i
  let depth = 1
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') depth -= 1
    i += 1
  }
  return source.slice(bodyStart, i - 1)
}

function loadTurnHelpers() {
  const source = readFileSync(CHAT_STORE, 'utf8')
  const minMatch = source.match(/export const LIVE_CHAT_MIN_VISIBLE_TURNS = (\d+)/)
  if (!minMatch) throw new Error('LIVE_CHAT_MIN_VISIBLE_TURNS missing')
  const LIVE_CHAT_MIN_VISIBLE_TURNS = Number(minMatch[1])
  const countLiveChatTurns = new Function('messages', extractFunctionBody(source, 'countLiveChatTurns')) as (
    messages: Array<{ role?: string }> | null | undefined,
  ) => number
  const liveChatShouldArchiveOlder = ((messages, hasMoreBefore) =>
    new Function('countLiveChatTurns', 'LIVE_CHAT_MIN_VISIBLE_TURNS', 'messages', 'hasMoreBefore', extractFunctionBody(source, 'liveChatShouldArchiveOlder'))(
      countLiveChatTurns,
      LIVE_CHAT_MIN_VISIBLE_TURNS,
      messages,
      hasMoreBefore,
    )) as (
    messages: Array<{ role?: string }> | null | undefined,
    hasMoreBefore?: boolean,
  ) => boolean
  const liveChatNeedsPersistedNewestMerge = ((messages, hasMoreBefore) =>
    new Function('countLiveChatTurns', 'messages', 'hasMoreBefore', extractFunctionBody(source, 'liveChatNeedsPersistedNewestMerge'))(
      countLiveChatTurns,
      messages,
      hasMoreBefore,
    )) as (
    messages: Array<{ role?: string }> | null | undefined,
    hasMoreBefore?: boolean,
  ) => boolean
  return { LIVE_CHAT_MIN_VISIBLE_TURNS, countLiveChatTurns, liveChatShouldArchiveOlder, liveChatNeedsPersistedNewestMerge }
}

describe('live chat turn-window helpers', () => {
  it('counts only user and command messages as turns', () => {
    const { countLiveChatTurns } = loadTurnHelpers()
    expect(countLiveChatTurns(null)).toBe(0)
    expect(countLiveChatTurns([])).toBe(0)
    expect(countLiveChatTurns([
      { role: 'user' },
      { role: 'tool' },
      { role: 'tool' },
      { role: 'assistant' },
      { role: 'command' },
      { role: 'system' },
    ])).toBe(2)
  })

  it('does not archive a single long tool-call turn even with hundreds of messages', () => {
    const { liveChatShouldArchiveOlder } = loadTurnHelpers()
    const messages = [
      { role: 'user' as const },
      ...Array.from({ length: 560 }, () => ({ role: 'tool' as const })),
      { role: 'assistant' as const },
    ]
    expect(liveChatShouldArchiveOlder(messages, true)).toBe(false)
    expect(liveChatShouldArchiveOlder(messages, false)).toBe(false)
  })

  it('archives only at 10 turns when older messages still exist', () => {
    const { liveChatShouldArchiveOlder, LIVE_CHAT_MIN_VISIBLE_TURNS } = loadTurnHelpers()
    expect(LIVE_CHAT_MIN_VISIBLE_TURNS).toBe(10)
    const nine = Array.from({ length: 9 }, () => ({ role: 'user' as const }))
    const ten = Array.from({ length: 10 }, () => ({ role: 'user' as const }))
    expect(liveChatShouldArchiveOlder(nine, true)).toBe(false)
    expect(liveChatShouldArchiveOlder(ten, true)).toBe(true)
    expect(liveChatShouldArchiveOlder(ten, false)).toBe(false)
  })

  it('detects a tool-only in-flight resume that still has older persisted turns', () => {
    const { liveChatNeedsPersistedNewestMerge } = loadTurnHelpers()
    const tools = Array.from({ length: 150 }, () => ({ role: 'tool' as const }))
    expect(liveChatNeedsPersistedNewestMerge(tools, true)).toBe(true)
    expect(liveChatNeedsPersistedNewestMerge([{ role: 'user' }, ...tools], true)).toBe(false)
    expect(liveChatNeedsPersistedNewestMerge(tools, false)).toBe(false)
  })
})

describe('live chat turn-window source shape', () => {
  it('removes the raw 300-message archive cap from live chat', () => {
    const store = readFileSync(CHAT_STORE, 'utf8')
    const list = readFileSync(MESSAGE_LIST, 'utf8')

    expect(store).not.toContain('export const LIVE_CHAT_MAX_LOADED_MESSAGES = 300')
    expect(store).not.toContain('offset >= LIVE_CHAT_MAX_LOADED_MESSAGES')
    expect(store).toContain('countLiveChatTurns(target.messages) >= LIVE_CHAT_MIN_VISIBLE_TURNS')
    expect(list).not.toContain('LIVE_CHAT_MAX_LOADED_MESSAGES')
    expect(list).toContain('liveChatShouldArchiveOlder(session?.messages || [], session?.hasMoreBefore)')
  })

  it('refills the 10-turn window after every resume path and merges by identity', () => {
    const store = readFileSync(CHAT_STORE, 'utf8')
    expect(store).toContain('refill after switchSession resume')
    expect(store).toContain('refill after reconnect resume')
    expect(store).toContain('refill after visibility resume')
    expect(store).toContain('liveChatNeedsPersistedNewestMerge(target.messages, target.hasMoreBefore)')
    expect(store).toContain('.filter(message => !target.messages.some(current => messageSnapshotMatch(current, message)))')
    // The legacy text+time heuristic is retired; identity comes from client_message_id.
    expect(store).not.toContain('mergeResumeMessageWindow')
    expect(store).toContain('reconcileMessageSnapshot(')
  })
})
