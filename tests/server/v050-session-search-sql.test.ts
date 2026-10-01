import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// hermes-v050:S3 — session search SQL: snippet lookup in id order (no TEMP
// B-TREE), one scan per non-matching session, no LOWER() copies of message
// bodies, and results identical to the pre-v0.5.0 query.

const DB_MODULE = '../../packages/server/src/modules/studio/infrastructure/database/index'
const STORE_MODULE = '../../packages/server/src/modules/studio/repositories/session-store'

let raw: any = null
let prepared: string[] = []

function recordingDb(target: any) {
  return new Proxy(target, {
    get(obj, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          prepared.push(sql)
          return obj.prepare(sql)
        }
      }
      const value = obj[prop]
      return typeof value === 'function' ? value.bind(obj) : value
    },
  })
}

async function loadStore() {
  return await import(STORE_MODULE)
}

const SEARCH_OPTIONS = { sources: ['cli', 'coding_agent'], profiles: ['default'], includeArchived: false }

function explainDetails(sql: string, params: unknown[]): string[] {
  return (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map(row => row.detail)
}

// SQLite's built-in LIKE semantics for the test data: ASCII-only case folding,
// `%`, `_` and a single-character ESCAPE.
function sqliteLike(pattern: string, value: unknown, escape?: string): number {
  if (value == null || pattern == null) return 0
  const text = String(value)
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (escape && char === escape && index + 1 < pattern.length) {
      index += 1
      source += pattern[index].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    } else if (char === '%') {
      source += '[\\s\\S]*'
    } else if (char === '_') {
      source += '[\\s\\S]'
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  const foldAscii = (input: string) => input.replace(/[A-Z]/g, letter => letter.toLowerCase())
  return new RegExp(`${foldAscii(source)}$`, 'u').test(foldAscii(text)) ? 1 : 0
}

describe('hermes-v050:S3 session search SQL', () => {
  beforeEach(async () => {
    vi.resetModules()
    prepared = []
    const { DatabaseSync } = await import('node:sqlite')
    raw = new DatabaseSync(':memory:')
    const db = recordingDb(raw)
    vi.doMock(DB_MODULE, () => ({
      getDb: () => db,
      isSqliteAvailable: () => true,
      getStoragePath: () => ':memory:',
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
  })

  afterEach(() => {
    raw?.close()
    raw = null
    vi.doUnmock(DB_MODULE)
    vi.resetModules()
  })

  it('looks up the snippet message through the session index in id order without a TEMP B-TREE', async () => {
    const { addMessage, createSession, searchSessions } = await loadStore()
    createSession({ id: 's1', profile: 'default', source: 'cli', title: 'Unrelated title' })
    addMessage({ session_id: 's1', role: 'user', content: 'nothing here', timestamp: 10 })
    const matchId = addMessage({ session_id: 's1', role: 'assistant', content: 'Deploy with Docker compose', timestamp: 20 })
    prepared = []

    const results = searchSessions(undefined, 'docker', 10, SEARCH_OPTIONS)

    expect(results).toEqual([expect.objectContaining({ id: 's1', matched_message_id: matchId, rank: 3 })])
    const snippetSql = prepared.find(sql => /search_message\.session_id = \?/.test(sql) && /LIMIT 1\s*$/.test(sql.trim()))
    expect(snippetSql, 'snippet statement was not prepared').toBeTruthy()
    const plan = explainDetails(snippetSql!, ['s1', '%docker%', '%docker%'])
    expect(plan.join(' | ')).toMatch(/idx_messages_session_id/)
    expect(plan.join(' | ')).not.toMatch(/TEMP B-TREE/)
  })

  it('never copies message bodies through LOWER()', async () => {
    const { addMessage, createSession, searchSessions } = await loadStore()
    createSession({ id: 's1', profile: 'default', source: 'cli', title: 'Title' })
    addMessage({ session_id: 's1', role: 'assistant', content: 'BODY-ONE mentions Kubernetes', timestamp: 10 })
    addMessage({ session_id: 's1', role: 'tool', content: 'BODY-TWO output', tool_name: 'Bash', timestamp: 11 })
    const lowered: unknown[] = []
    raw.function('lower', { deterministic: true }, (value: unknown) => {
      lowered.push(value)
      return typeof value === 'string' ? value.replace(/[A-Z]/g, letter => letter.toLowerCase()) : value
    })

    expect(searchSessions(undefined, 'kubernetes', 10, SEARCH_OPTIONS)).toEqual([
      expect.objectContaining({ id: 's1', rank: 3 }),
    ])
    expect(searchSessions(undefined, 'zz-no-match', 10, SEARCH_OPTIONS)).toEqual([])

    expect(lowered.filter(value => typeof value === 'string' && value.startsWith('BODY-'))).toEqual([])
    expect(lowered).not.toContain('Bash')
  })

  it('visits each message of a non-matching session once instead of once per EXISTS', async () => {
    const { addMessage, createSession, searchSessions } = await loadStore()
    createSession({ id: 'miss', profile: 'default', source: 'cli', title: 'Nothing to see' })
    for (let index = 1; index <= 3; index += 1) {
      addMessage({ session_id: 'miss', role: 'tool', content: `content-${index}`, tool_name: `tool-${index}`, timestamp: index })
    }
    const visits: number[] = []
    raw.function('like', { deterministic: true, varargs: true }, (pattern: string, value: unknown, escape?: string) => {
      const match = /^(?:content|tool)-(\d)$/.exec(String(value ?? ''))
      if (match) {
        const row = Number(match[1])
        if (visits[visits.length - 1] !== row) visits.push(row)
      }
      return sqliteLike(pattern, value, escape)
    })

    expect(searchSessions(undefined, 'absent-term', 10, SEARCH_OPTIONS)).toEqual([])
    // Pre-v0.5.0: [1, 2, 3, 1, 2, 3] (content EXISTS, then tool_name EXISTS).
    expect(visits).toEqual([1, 2, 3])
  })

  it('keeps tool-name-only matches ranked after body matches', async () => {
    const { addMessage, createSession, searchSessions } = await loadStore()
    createSession({ id: 'tool-only', profile: 'default', source: 'cli', title: 'Ops' })
    addMessage({ session_id: 'tool-only', role: 'assistant', content: 'ran a command', timestamp: 1 })
    addMessage({ session_id: 'tool-only', role: 'tool', content: 'ok', tool_name: 'Bash', timestamp: 2 })
    createSession({ id: 'tool-then-body', profile: 'default', source: 'cli', title: 'Mixed' })
    addMessage({ session_id: 'tool-then-body', role: 'tool', content: 'ok', tool_name: 'Bash', timestamp: 1 })
    addMessage({ session_id: 'tool-then-body', role: 'assistant', content: 'I used bash above', timestamp: 2 })
    createSession({ id: 'body', profile: 'default', source: 'cli', title: 'Shell' })
    addMessage({ session_id: 'body', role: 'assistant', content: 'how do I write a BASH loop', timestamp: 1 })
    raw.prepare('UPDATE sessions SET last_active = ? WHERE id = ?').run(300, 'tool-only')
    raw.prepare('UPDATE sessions SET last_active = ? WHERE id = ?').run(200, 'tool-then-body')
    raw.prepare('UPDATE sessions SET last_active = ? WHERE id = ?').run(100, 'body')

    const results = searchSessions(undefined, 'bash', undefined, SEARCH_OPTIONS)

    expect(results.map((row: any) => [row.id, row.rank])).toEqual([
      ['tool-then-body', 3],
      ['body', 3],
      ['tool-only', 4],
    ])
    expect(results[2]).toEqual(expect.objectContaining({ snippet: 'Bash' }))
  })

  it('uses the first stored matching message for the snippet', async () => {
    const { addMessage, createSession, searchSessions } = await loadStore()
    createSession({ id: 's1', profile: 'default', source: 'cli', title: 'Title' })
    const firstStored = addMessage({ session_id: 's1', role: 'assistant', content: 'first stored needle', timestamp: 50 })
    addMessage({ session_id: 's1', role: 'assistant', content: 'second stored needle', timestamp: 10 })

    expect(searchSessions(undefined, 'needle', 10, SEARCH_OPTIONS)).toEqual([
      expect.objectContaining({ id: 's1', matched_message_id: firstStored, snippet: 'first stored needle' }),
    ])
  })

  it('returns exactly what the pre-v0.5.0 LOWER()/two-EXISTS query returned for mixed-case, CJK and accented text', async () => {
    const { addMessage, createSession, searchSessions } = await loadStore()
    const sessions: Array<[string, string | null, Array<[string, string, string | null]>]> = [
      ['en-upper', 'CLAUDE Code review', [['user', 'Please REVIEW this', null]]],
      ['en-mixed', null, [['user', 'ask cLaUdE about Docker', null], ['assistant', 'Docker-Compose ready', null]]],
      ['zh', '上下文压缩', [['user', '请帮我压缩上下文', null], ['assistant', '已完成压缩。Claude 回复', null]]],
      ['zh-body', '无关标题', [['assistant', '中文 压缩 内容 与 English Mix', null]]],
      ['accent-upper', 'Café ÄRGER', [['user', 'Ärger mit Straße', null]]],
      ['accent-lower', 'café ärger', [['assistant', 'straße und ärger', null]]],
      ['greek', 'ΣΟΦΙΑ', [['assistant', 'σοφια', null]]],
      ['kelvin', 'Temperature', [['assistant', '300 \u212A (Kelvin sign)', null]]],
      ['like-chars', '100% done_now', [['assistant', 'path C:\\tmp\\x and 50%_off', null]]],
      ['tools', 'Ops', [['tool', '{"ok":true}', 'Bash'], ['tool', 'listing', 'mcp__hermes-studio__read']]],
      ['nulls', null, [['assistant', '', null], ['tool', 'plain', null]]],
    ]
    let ts = 1
    for (const [id, title, messages] of sessions) {
      createSession({ id, profile: 'default', source: 'cli', ...(title ? { title } : {}) })
      for (const [role, content, toolName] of messages) {
        addMessage({ session_id: id, role, content, tool_name: toolName, timestamp: ts++ })
      }
      raw.prepare('UPDATE sessions SET last_active = ? WHERE id = ?').run(1000 + ts, id)
    }

    const queries = [
      'claude', 'CLAUDE', 'Claude', 'cLaUdE code', 'docker', 'DOCKER compose', 'review',
      '压缩', '上下文 压缩', '压缩 english', '中文', 'mix',
      'café', 'CAFÉ', 'ärger', 'ÄRGER', 'straße', 'STRASSE', 'σοφια', 'ΣΟΦΙΑ', 'k', '\u212A',
      '100%', 'done_now', '50%_off', 'c:\\tmp', 'bash', 'MCP__HERMES', 'plain', 'nothing-matches',
    ]
    for (const query of queries) {
      const actual = searchSessions(undefined, query, undefined, SEARCH_OPTIONS)
      const expected = legacySearch(raw, query, SEARCH_OPTIONS)
      expect(actual.map(pick), `query ${JSON.stringify(query)}`).toEqual(expected)
    }
  })
})

function pick(row: any) {
  return { id: row.id, rank: row.rank, snippet: row.snippet, matched_message_id: row.matched_message_id }
}

// Verbatim port of the pre-v0.5.0 searchSessions SQL (session-store.ts:652-744
// at v0.4.6), used as the oracle for result equivalence.
// hermes-v050:E-02 except ranks 0/1, which now match the displayed title.
function legacySearch(db: any, query: string, options: { sources: string[]; profiles: string[]; includeArchived: boolean }) {
  const trimmed = query.trim()
  const lowered = trimmed.toLowerCase()
  const normalized = trimmed.toLowerCase()
  const split = normalized.split(/\s+/u).filter(term => term && !/^[\p{P}\p{S}]+$/u.test(term))
  const terms = [...new Set(split.length > 0 ? split : [normalized])].slice(0, 20)
  const escape = (value: string) => value.replace(/[\\%_]/g, '\\$&')
  const patterns = terms.map(term => `%${escape(term)}%`)
  const match = (column: string) => terms.map(() => `LOWER(COALESCE(${column}, '')) LIKE ? ESCAPE '\\'`).join(' AND ')
  const filterSql = `s.profile IN (${options.profiles.map(() => '?').join(', ')}) AND s.source IN (${options.sources.map(() => '?').join(', ')}) AND COALESCE(s.is_archived, 0) = 0`
  // hermes-v050:E-02 ranks 0/1 compare the displayed title (mapSessionRow: title, else the
  // preview cut to 40 + '...'); the SQL form is exact here because this data is BMP-only.
  const displayTitle = `COALESCE(NULLIF(s.title, ''), CASE WHEN LENGTH(s.preview) > 40 THEN SUBSTR(s.preview, 1, 40) || '...' ELSE NULLIF(s.preview, '') END)`
  const rows = db.prepare(
    `WITH ranked_sessions AS (
       SELECT s.*,
         CASE
           WHEN LOWER(TRIM(COALESCE(${displayTitle}, ''))) = ? THEN 0
           WHEN ${match(displayTitle)} THEN 1
           WHEN ${match('s.preview')} THEN 2
           WHEN EXISTS (SELECT 1 FROM messages search_message WHERE search_message.session_id = s.id AND ${match('search_message.content')}) THEN 3
           WHEN EXISTS (SELECT 1 FROM messages search_message WHERE search_message.session_id = s.id AND ${match('search_message.tool_name')}) THEN 4
           ELSE 5
         END AS search_rank
       FROM sessions s
       WHERE ${filterSql}
     )
     SELECT * FROM ranked_sessions WHERE search_rank < 5 ORDER BY search_rank, last_active DESC`,
  ).all(lowered, ...patterns, ...patterns, ...patterns, ...patterns, ...options.profiles, ...options.sources) as any[]
  const msgQuery = db.prepare(
    `SELECT search_message.id, search_message.content, search_message.tool_name
     FROM messages search_message
     WHERE search_message.session_id = ? AND ${terms.map(() => `(LOWER(COALESCE(search_message.content, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(search_message.tool_name, '')) LIKE ? ESCAPE '\\')`).join(' AND ')}
     ORDER BY search_message.timestamp, search_message.id
     LIMIT 1`,
  )
  const firstIndex = (value: string) => {
    const low = value.toLowerCase()
    let first = -1
    for (const term of terms) {
      const index = low.indexOf(term)
      if (index >= 0 && (first < 0 || index < first)) first = index
    }
    return first
  }
  const matchesAll = (value: string) => terms.every(term => value.toLowerCase().includes(term))
  return rows.map(row => {
    const rawTitle = row.title != null ? String(row.title) : ''
    const preview = row.preview != null ? String(row.preview) : ''
    let snippet = ''
    let matched_message_id: number | null = null
    if (matchesAll(rawTitle)) {
      const index = firstIndex(rawTitle)
      snippet = rawTitle.substring(Math.max(0, index - 20), index + terms[0].length + 60)
    } else if (matchesAll(preview)) {
      const index = firstIndex(preview)
      snippet = preview.substring(Math.max(0, index - 20), index + terms[0].length + 60)
    } else {
      const msg = msgQuery.get(row.id, ...patterns.flatMap(pattern => [pattern, pattern])) as any
      if (msg) {
        matched_message_id = msg.id
        const index = firstIndex(msg.content)
        snippet = index >= 0 ? msg.content.substring(Math.max(0, index - 20), index + terms[0].length + 60) : (msg.tool_name || '')
      }
    }
    return { id: row.id, rank: Number(row.search_rank || 0), snippet, matched_message_id }
  })
}
