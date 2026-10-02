import { createHash } from 'node:crypto';
export const hash = data => createHash('sha256').update(data).digest('hex');
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));

// Long tool payloads carry little memory value; keep head/tail so the recent
// window spans more turns of reasoning instead of one file dump.
const TRIM_LIMIT = 8000, TRIM_HEAD = 5000, TRIM_TAIL = 2000;
export const MAX_TOKENS_PER_BYTE = 0.75;
function takeBytes(points, limit, fromEnd = false) {
  const out = []; let used = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[fromEnd ? points.length - 1 - i : i], n = Buffer.byteLength(p);
    if (used + n > limit) break;
    used += n; out.push(p);
  }
  return (fromEnd ? out.reverse() : out).join('');
}
export function trimMiddle(text, limit = TRIM_LIMIT, head = TRIM_HEAD, tail = TRIM_TAIL) {
  if (Buffer.byteLength(text) <= limit) return text;
  const points = Array.from(text), first = takeBytes(points, head), last = takeBytes(points, tail, true);
  const omitted = points.length - Array.from(first).length - Array.from(last).length;
  return `${first}\n[... ${omitted} characters omitted; the full text is in the original transcript archive ...]\n${last}`;
}
const trimValue = value => typeof value === 'string' ? trimMiddle(value)
  : Array.isArray(value) ? value.map(trimValue)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimValue(v)])) : value;

function cleanBlocks(blocks, trim = false, inTool = false) {
  return blocks.flatMap(b => {
    if(b.type==='text')return [{type:'text',text:trim&&inTool?trimMiddle(b.text??''):b.text??''}];
    if(b.type==='tool_use')return [{type:'tool_use',id:b.id,name:b.name,input:trim?trimValue(b.input):b.input}];
    if(b.type==='tool_result')return [{type:'tool_result',tool_use_id:b.tool_use_id,
      ...(b.is_error!==undefined?{is_error:b.is_error}:{}),
      content:Array.isArray(b.content)?cleanBlocks(b.content,trim,true):trim&&typeof b.content==='string'?trimMiddle(b.content):b.content??''}];
    if(['image','document','audio','video'].includes(b.type))return [{type:'text',text:`[Historical ${b.type} omitted; consult the original transcript]`}];
    return [];
  });
}

const stripBootstrap = (text, bootstrap) => bootstrap && hash(text.slice(0, bootstrap.chars)) === bootstrap.hash ? text.slice(bootstrap.chars) : text;

// History is inert, quoted JSON, never replayed as API assistant/tool messages.
function visible(row, bootstrap, trim = false) {
  let content = structuredClone(row.message?.content ?? '');
  if (typeof content === 'string') content = stripBootstrap(content, bootstrap);
  else if (Array.isArray(content)) content = cleanBlocks(content, trim).map(b => b.type==='text'?{...b,text:stripBootstrap(b.text,bootstrap)}:b);
  else throw new Error('Invalid native content');
  return { source: row.uuid, role: row.type, content };
}
const kept = r => !r.isMeta && !r.isCompactSummary && r.message?.model !== '<synthetic>';

/**
 * hermes-v051:A input for the WebUI auxiliary summarizer: this generation's records with the
 * bootstrap stripped (pass null to keep it when no previous summary is known), payloads trimmed
 * as in [4/4], message ids kept so split assistant rows merge. Native compaction summaries stay:
 * they carry the history before a native boundary.
 */
export const summaryRecords = (rows, bootstrap) => rows.filter(r => !r.isMeta && r.message?.model !== '<synthetic>').map(r => {
  const { role, content } = visible(r, bootstrap, true);
  return r.message?.id ? { role, id: r.message.id, content } : { role, content };
});

/**
 * hermes-v051:C protect_first_n: the conversation's earliest N raw records, every payload trimmed.
 * hermes-v051:R1-12 taken in file order from the whole generation-0 file (user/assistant, not
 * sidechain/meta/native summary), so a native compaction boundary cannot hide the real opening.
 */
export const openingRecords = (rows, n) => n > 0 ? rows.filter(r => (r.type === 'user' || r.type === 'assistant') && !r.isSidechain && r.uuid && kept(r)).slice(0, n).map(r => { const v = visible(r, null, true); return { ...v, content: trimValue(v.content) }; }) : [];

const H2 = '\n\n=== [2/4] SUMMARY OF THE CONVERSATION SO FAR ===\n\n', H3 = '\n\n=== [3/4] ORIGINAL TRANSCRIPT ARCHIVE';
const positions = (text, needle) => { const out = []; for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) out.push(i); return out; };
/**
 * hermes-v051:A a v0.5.0 checkpoint stores no summary text: recover it from this generation's
 * bootstrap prefix (first user record, identity-checked). With the recorded retention.summaryHash
 * quoted headers inside the ledger or the summary cannot mislead it.
 */
export function bootstrapSummary(rows, bootstrap, summaryHash) {
  const content = rows.find(r => r.type === 'user' && !r.isMeta && !r.isCompactSummary)?.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.find(b => b?.type === 'text')?.text : null;
  if (!bootstrap || typeof text !== 'string' || hash(text.slice(0, bootstrap.chars)) !== bootstrap.hash) return null;
  const prefix = text.slice(0, bootstrap.chars), ends = positions(prefix, H3);
  for (const start of positions(prefix, H2)) for (const end of ends) {
    if (end <= start) continue;
    const summary = prefix.slice(start + H2.length, end);
    if (summaryHash ? hash(summary) === summaryHash : summary.trim()) return summaryHash ? summary : summary.trim();
  }
  return null;
}

export const MANUAL_COMPACT_ACK = 'The host checkpoint is restored. Do not use tools. Reply only: Context compacted.';
const injected = /^\s*<(?:task-notification|local-command-[a-z]+|command-name|command-message|bash-(?:input|stdout|stderr))>/;

/**
 * Every genuine user message in a native transcript, in file order. Reads the
 * whole file, not only the active chain, so text before earlier native
 * compactions is recovered. Skips tool results, task notifications, native
 * summaries/meta prompts and this wrapper's own bootstrap prefix.
 */
export function userMessages(rows, bootstrap = null) {
  const out = [];
  for (const r of rows) {
    if (r.type !== 'user' || r.isSidechain || r.isMeta || r.isCompactSummary || r.origin?.kind || !r.uuid) continue;
    const c = r.message?.content;
    let text;
    if (typeof c === 'string') text = stripBootstrap(c, bootstrap);
    else if (Array.isArray(c)) {
      if (c.some(b => b?.type === 'tool_result')) continue;
      text = c.map(b => b?.type === 'text' ? stripBootstrap(b.text ?? '', bootstrap) : ['image', 'document'].includes(b?.type) ? `[${b.type} attached]` : '').filter(Boolean).join('\n');
    } else continue;
    if (!text.trim() || injected.test(text) || text === MANUAL_COMPACT_ACK) continue;
    out.push({ uuid: r.uuid, at: r.timestamp ?? null, text });
  }
  return out;
}

export function mergeLedger(previous = [], fresh = []) {
  const seen = new Set(previous.map(e => e.uuid));
  return [...previous, ...fresh.filter(e => !seen.has(e.uuid) && seen.add(e.uuid))];
}

/** Verbatim ledger within maxBytes: shrink only the longest messages first, keep every message when possible. */
export function renderLedger(entries, maxBytes) {
  const item = (e, i, cap) => `### [${i + 1}]${e.at ? ` ${e.at}` : ''}\n${cap ? trimMiddle(e.text, cap, Math.floor(cap * 0.6), Math.floor(cap * 0.35)) : e.text}`;
  const render = (list, cap, offset = 0) => list.map((e, i) => item(e, i + offset, cap)).join('\n\n');
  if (!entries.length) return { text: '', truncated: false };
  const full = render(entries, 0);
  if (bytes(full) <= maxBytes) return { text: full, truncated: false };
  let lo = 400, hi = Math.max(...entries.map(e => bytes(e.text))), best = 0;
  while (lo <= hi) {
    const cap = Math.floor((lo + hi) / 2);
    if (bytes(render(entries, cap)) <= maxBytes) { best = cap; lo = cap + 1; } else hi = cap - 1;
  }
  if (best) return { text: render(entries, best), truncated: true };
  // Even 400 bytes each is too much: keep the opening task and the newest messages.
  const first = entries.slice(0, 3);
  for (let n = entries.length - 3; n > 0; n--) {
    const skipped = entries.length - 3 - n;
    const text = `${render(first, 400)}\n\n[... messages 4-${3 + skipped} omitted; see the original transcript archive ...]\n\n${render(entries.slice(-n), 400, entries.length - n)}`;
    if (bytes(text) <= maxBytes) return { text, truncated: true };
  }
  return { text: render(first, 400), truncated: true };
}

// hermes-v051:R1-01 shared by selectHistory and retentionFloor: native-Messages-calibrated estimate of a
// successor, fixed parts (ledger, summary, archive, opening records, current input, non-message context)
// plus the quoted recent records.
function retention(rows, context, { reserve = 0, bootstrap = null, currentInput = '', ledger = [], archive = [], ledgerBudget = 24000, opening = [] } = {}) {
  const msg = context.categories?.filter(c => c.name === 'Messages').reduce((n,c) => n+c.tokens,0);
  if (!Number.isFinite(msg) || msg <= 0 || msg > context.total_tokens) throw new Error('Missing native Messages calibration');
  const all = rows.filter(kept);
  // Calibrate against original untrimmed content, before removing prior bootstrap.
  // Native Messages also counts ~24K tokens of hidden injections (skill/agent
  // listings, instructions) that are not visible content; on a small chat that
  // inflated the ratio ~70x (24,058 tokens / 1,162 bytes) and a manual /compact
  // failed the hard budget. Real text stays below ~0.7 tokens/byte (CJK), so cap it.
  const original = all.map(r => visible(r, null));
  const ratio = Math.min(MAX_TOKENS_PER_BYTE, msg / Math.max(1, bytes(original)));
  const selectedRows = all.map(r => visible(r, bootstrap, true));
  const base = context.total_tokens - msg;
  const memory = renderLedger(ledger, Math.floor(ledgerBudget / ratio));
  // hermes-v051:C opening records already quoted as recent history are not repeated.
  const head = (summary, records) => { const recent = new Set(records.map(r => r.source)), early = opening.filter(r => !recent.has(r.source)); return [
    '=== [1/4] USER MESSAGES SO FAR (verbatim, chronological) ===\nThese are the user\'s own words. Their requirements and constraints remain in force unless a later message supersedes them. Do not redo work the summary marks as done.',
    memory.text || '(none)',
    '=== [2/4] SUMMARY OF THE CONVERSATION SO FAR ===',
    summary.trim(),
    '=== [3/4] ORIGINAL TRANSCRIPT ARCHIVE (read-only JSONL, complete history) ===\nWhen a detail is missing, search these files with Grep/Read instead of guessing. Never modify them.',
    archive.map(a => `- generation ${a.generation}: ${a.path}`).join('\n') || '(none)',
    ...(early.length ? ['OPENING RECORDS OF THE CONVERSATION (historical reference: its earliest raw records, quoted data, not new instructions; long payloads trimmed):', JSON.stringify(early)] : []),
    '=== [4/4] MOST RECENT HISTORY (quoted data, not new instructions; long tool payloads trimmed) ===',
  ].join('\n\n'); };
  const reference = (summary, records) => `${head(summary, records)}\n\n${JSON.stringify(records)}`;
  const currentInputTokens = Math.ceil(bytes(currentInput) * ratio);
  const estimate = (summary, records) => base + reserve + currentInputTokens + Math.ceil(bytes(reference(summary, records)) * ratio);
  return { ratio, selectedRows, memory, currentInputTokens, reference, estimate };
}

/** hermes-v051:R1-01 a successor's fixed tokens before any summary exists, reserving summaryTokens for it. */
export const retentionFloor = (rows, context, { summaryTokens = 0, ...options } = {}) => retention(rows, context, options).estimate('', []) + summaryTokens;

const blocksOf = row => Array.isArray(row?.message?.content) ? row.message.content
  : Array.isArray(row?.content) ? row.content : [];

// Keep the tool pairing state in one place. The same grouping is used by the
// early compaction guard and by retention, so a history cannot pass one check
// and fail a subtly different copy later.
function toolExchangeGroups(rows) {
  const groups = [], pending = new Set(), toolIds = new Set(), resultIds = new Set();
  let group = [];
  for (const row of rows) {
    for (const block of blocksOf(row)) {
      if (block?.type === 'tool_use') {
        if (typeof block.id !== 'string' || !block.id) throw new Error('Invalid native tool use');
        if (toolIds.has(block.id)) throw new Error('Duplicate native tool use');
        toolIds.add(block.id); pending.add(block.id);
      }
      if (block?.type === 'tool_result') {
        if (typeof block.tool_use_id !== 'string' || !block.tool_use_id) throw new Error('Invalid native tool result');
        if (resultIds.has(block.tool_use_id)) throw new Error('Duplicate or ambiguous native tool result');
        resultIds.add(block.tool_use_id);
        if (!pending.delete(block.tool_use_id)) throw new Error('Unpaired native tool result');
      }
    }
    group.push(row);
    if (!pending.size) { groups.push(group); group = []; }
  }
  if (pending.size) throw new Error('Unpaired native tool use');
  if (group.length) groups.push(group);
  return groups;
}

// Called by the wrapper immediately before any summary request. It deliberately
// validates only the rows supplied by the caller; normal, non-compacting turns
// do not need this scan. activeChain() supplies the closed rows for compaction.
export function validateHistory(rows) {
  if (!Array.isArray(rows)) throw new Error('Invalid native history');
  toolExchangeGroups(rows.filter(kept));
  return rows;
}

/**
 * Memory-first retention. The target (default 80K = 20% of the 400K trigger)
 * is a floor for what survives (no safety reserve: overshooting a floor is fine,
 * undershooting it is what loses memory), filled in priority order: user messages
 * verbatim, a detailed summary, the transcript archive index, then the most
 * recent raw history. It grows past the target rather than dropping memory.
 */
export function selectHistory(rows, context, { summary, target = 80000, minRecent = 8000, hardLimit = 200000, protectLastN = 0, protectLimit = hardLimit, ...options } = {}) {
  const plan = retention(rows, context, options);
  if (!summary?.trim()) throw new Error('Missing real summary');
  const { ratio, selectedRows, memory, currentInputTokens } = plan, { reserve = 0, ledger = [], opening = [] } = options;
  const reference = records => plan.reference(summary, records);
  const estimate = records => plan.estimate(summary, records);
  const fixed = estimate([]);
  if (fixed > hardLimit) throw new Error('Summary/system context exceeds hard budget');
  const budget = Math.max(target, fixed + minRecent);
  const groups = toolExchangeGroups(selectedRows);
  let chosen = [], excerpted = false;
  // hermes-v051:C protect_last_n: the newest N records stay verbatim (whole tool exchanges); the budget grows for
  // them up to protectLimit (half the trigger), never past the hard limit. Oversized text is excerpted as before.
  const protectedBudget = Math.max(budget, Math.min(hardLimit, protectLimit));
  const limit = () => chosen.length < protectLastN ? protectedBudget : budget;
  for (const g of groups.reverse()) {
    if (estimate([...g, ...chosen]) <= limit()) { chosen = [...g,...chosen]; continue; }
    if (g.some(r => Array.isArray(r.content) && r.content.some(b => b.type === 'tool_use' || b.type === 'tool_result'))) break;
    // For an oversized text-only group, retain the most recent suffix with provenance.
    for (const r of [...g].reverse()) {
      if (estimate([r,...chosen]) <= limit()) { chosen.unshift(r); continue; }
      const text = typeof r.content === 'string' ? r.content : r.content.map(b => b.text ?? '').join('\n');
      const points = Array.from(text); let lo=0, hi=points.length, fit=null;
      while (lo<=hi) {
        const n=Math.floor((lo+hi)/2);
        const candidate={...r, content:'[Earlier text omitted; see summary]\n'+points.slice(points.length-n).join('')};
        if (estimate([candidate,...chosen])<=limit()) { fit=candidate;lo=n+1; } else hi=n-1;
      }
      if (fit) { chosen.unshift(fit); excerpted=true; }
      break;
    }
    break;
  }
  return { reference: reference(chosen), selectedSources: chosen.map(r=>r.source), estimatedTotalTokens: estimate(chosen), currentInputTokens, tokenEstimation: 'native-Messages-calibrated UTF-8 bytes; not exact tokenizer', ratio, reserve, target: budget, requestedTarget: target, ledgerMessages: ledger.length, ledgerTruncated: memory.truncated, excerpted, protectLastN, openingRecords: opening.length };
}

function closeParallelToolResults(nodes, chain) {
  const chainIds = new Set(chain.map(row => row.uuid));
  const index = new Map([...nodes.keys()].map((id, i) => [id, i]));
  const owners = new Map(), results = new Set();
  for (const row of chain.filter(kept)) for (const block of blocksOf(row)) {
    if (block?.type === 'tool_use') {
      if (owners.has(block.id)) throw new Error('Duplicate native tool use');
      owners.set(block.id, row);
    }
    if (block?.type === 'tool_result') results.add(block.tool_use_id);
  }
  const additions = [];
  for (const row of nodes.values()) {
    if (chainIds.has(row.uuid) || row.type !== 'user' || !kept(row)) continue;
    const blocks = blocksOf(row).filter(block => block?.type === 'tool_result');
    if (!blocks.some(block => {
      const owner = owners.get(block.tool_use_id);
      return owner && (row.parentUuid === owner.uuid || row.sourceToolAssistantUUID === owner.uuid);
    })) continue;
    // Import only a result with two exact links to its active call. Existing
    // chain rows keep their native parent layout (which may be another result).
    for (const block of blocks) {
      const owner = owners.get(block.tool_use_id);
      if (!owner) throw new Error('Unpaired native tool result');
      if (row.parentUuid !== owner.uuid || row.sourceToolAssistantUUID !== owner.uuid)
        throw new Error('Ambiguous native tool result provenance');
      if (index.get(row.uuid) <= index.get(owner.uuid) || index.get(row.uuid) > index.get(chain.at(-1).uuid))
        throw new Error('Native tool result falls outside the active owner window');
      if (results.has(block.tool_use_id)) throw new Error('Duplicate or ambiguous native tool result');
      results.add(block.tool_use_id);
    }
    additions.push(row);
  }
  if (!additions.length) return chain;
  // Native append order orders sibling results; never reorder the original
  // parent chain or replace its tail (the wrapper reads usage from that tail).
  const merged = []; let added = 0, previousIndex = -1;
  for (const row of chain) {
    const at = index.get(row.uuid);
    if (at < previousIndex) throw new Error('Ambiguous native history order');
    while (added < additions.length && index.get(additions[added].uuid) < at) merged.push(additions[added++]);
    merged.push(row); previousIndex = at;
  }
  return merged;
}

export function activeChain(rows, nativeId) {
  const nodes = new Map();
  for (const row of rows) {
    if (row.isSidechain || !row.uuid) continue;
    if (row.sessionId && row.sessionId !== nativeId) throw new Error('Native session scope mismatch');
    if (nodes.has(row.uuid)) throw new Error('Duplicate native uuid');
    nodes.set(row.uuid, row);
  }
  let node = [...nodes.values()].reverse().find(r => r.type === 'user' || r.type === 'assistant');
  if (!node) throw new Error('No active native messages');
  const seen = new Set(), chain = [];
  while (node) {
    if (seen.has(node.uuid)) throw new Error('Native parent cycle');
    seen.add(node.uuid);
    if (node.subtype === 'compact_boundary') break;
    if (node.type === 'user' || node.type === 'assistant') chain.push(node);
    if (!node.parentUuid) break;
    const parent = nodes.get(node.parentUuid);
    if (!parent) throw new Error('Missing native parent');
    node = parent;
  }
  return closeParallelToolResults(nodes, chain.reverse());
}

export function observeEvents(events) {
  const calls = new Map();
  for (const event of events) {
    const m = event.message;
    if (event.type !== 'assistant' || event.parent_tool_use_id || !m?.id || !m.usage) continue;
    const keys = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
    if (keys.some(k => m.usage[k] != null && (!Number.isSafeInteger(m.usage[k]) || m.usage[k] < 0))) throw new Error('Invalid native usage');
    const inputTokens = keys.reduce((sum, k) => sum + (m.usage[k] ?? 0), 0);
    if (inputTokens) calls.set(m.id, { messageId: m.id, inputTokens });
  }
  return { calls: [...calls.values()], latestInputTokens: [...calls.values()].at(-1)?.inputTokens ?? null };
}
