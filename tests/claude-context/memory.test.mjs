import test from 'node:test';
import assert from 'node:assert/strict';
const sid = '11111111-1111-4111-8111-111111111111';
const row = (uuid, parentUuid, type, content, extra = {}) => ({ uuid, parentUuid, sessionId: sid, type, message: { role: type, content }, ...extra });
const core = () => import('../../bin/claude-context/core.mjs');
const context = { total_tokens: 410000, categories: [{ name: 'Messages', tokens: 400000 }] };

test('user ledger keeps genuine user text only: no tool results, notifications, native summaries, meta prompts or wrapper prefix', async () => {
  const { userMessages, hash, MANUAL_COMPACT_ACK } = await core();
  const prefix = '[HOST CONTINUATION: fixture]\nCURRENT USER REQUEST:\n';
  const bootstrap = { hash: hash(prefix), chars: prefix.length };
  const rows = [
    row('u1', null, 'user', 'FIRST_TASK 先做代码审查', { timestamp: '2026-09-30T01:00:00Z' }),
    row('t', 'u1', 'user', [{ type: 'tool_result', tool_use_id: 'x', content: 'TOOL_OUTPUT' }]),
    row('n', 't', 'user', '<task-notification>\n<status>completed</status>', { origin: { kind: 'task-notification' } }),
    row('s', 'n', 'user', 'NATIVE_SUMMARY', { isCompactSummary: true }),
    row('m', 's', 'user', 'META_PROMPT', { isMeta: true }),
    row('side', 'm', 'user', 'SIDECHAIN', { isSidechain: true }),
    row('b', 'm', 'user', [{ type: 'text', text: prefix }, { type: 'text', text: 'SECOND_REQUEST' }, { type: 'image', source: { type: 'base64', data: 'BINARY' } }]),
    row('c', 'b', 'user', prefix + 'THIRD_REQUEST'),
    row('ack', 'c', 'user', MANUAL_COMPACT_ACK),
    row('a', 'ack', 'assistant', 'ASSISTANT_TEXT'),
  ];
  const out = userMessages(rows, bootstrap);
  assert.deepEqual(out.map(e => e.uuid), ['u1', 'b', 'c']);
  assert.equal(out[0].text, 'FIRST_TASK 先做代码审查');
  assert.equal(out[0].at, '2026-09-30T01:00:00Z');
  assert.equal(out[1].text, 'SECOND_REQUEST\n[image attached]');
  assert.equal(out[2].text, 'THIRD_REQUEST');
  assert.doesNotMatch(JSON.stringify(out), /HOST CONTINUATION|BINARY|TOOL_OUTPUT|NATIVE_SUMMARY|META_PROMPT|SIDECHAIN|task-notification/);
});

test('ledger merge carries earlier generations forward without duplicates', async () => {
  const { mergeLedger } = await core();
  const merged = mergeLedger([{ uuid: 'a', text: 'A' }, { uuid: 'b', text: 'B' }], [{ uuid: 'b', text: 'B' }, { uuid: 'c', text: 'C' }, { uuid: 'c', text: 'C' }]);
  assert.deepEqual(merged.map(e => e.uuid), ['a', 'b', 'c']);
});

test('ledger rendering keeps every message; over budget only long messages are trimmed; extreme cases keep the opening task and newest', async () => {
  const { renderLedger } = await core();
  const small = [{ uuid: 'a', text: '短消息一' }, { uuid: 'b', text: '短消息二' }];
  assert.deepEqual(renderLedger(small, 10000), { text: '### [1]\n短消息一\n\n### [2]\n短消息二', truncated: false });
  const mixed = [{ uuid: 'a', text: 'KEEP_SHORT_1' }, { uuid: 'b', text: 'HEAD' + '长'.repeat(20000) + 'TAIL' }, { uuid: 'c', text: 'KEEP_SHORT_3' }];
  const out = renderLedger(mixed, 6000);
  assert.equal(out.truncated, true);
  assert.ok(Buffer.byteLength(out.text) <= 6000);
  assert.match(out.text, /KEEP_SHORT_1/); assert.match(out.text, /KEEP_SHORT_3/);
  assert.match(out.text, /HEAD/); assert.match(out.text, /TAIL/); assert.match(out.text, /characters omitted/);
  const many = Array.from({ length: 400 }, (_, i) => ({ uuid: String(i), text: `MSG_${i} ` + 'x'.repeat(600) }));
  const extreme = renderLedger(many, 20000);
  assert.ok(Buffer.byteLength(extreme.text) <= 20000);
  assert.match(extreme.text, /MSG_0 /); assert.match(extreme.text, /MSG_399 /); assert.match(extreme.text, /omitted; see the original transcript archive/);
});

test('retained context puts user messages, summary and archive before recent history, and they survive a huge recent window', async () => {
  const { selectHistory } = await core();
  const rows = [row('u', null, 'user', 'recent '.repeat(200000)), row('a', 'u', 'assistant', 'RECENT_ANSWER')];
  const ledger = [{ uuid: 'x', at: '2026-09-01T00:00:00Z', text: 'OLDEST_USER_RULE 不许改 JSONL' }, { uuid: 'y', text: 'LATER_USER_CORRECTION' }];
  const archive = [{ generation: 0, path: '/state/archive/gen0.jsonl' }, { generation: 1, path: '/state/archive/gen1.jsonl' }];
  const out = selectHistory(rows, context, { summary: 'DETAILED_SUMMARY', ledger, archive });
  const r = out.reference;
  for (const marker of ['OLDEST_USER_RULE 不许改 JSONL', 'LATER_USER_CORRECTION', 'DETAILED_SUMMARY', '/state/archive/gen0.jsonl', '/state/archive/gen1.jsonl', 'RECENT_ANSWER']) assert.ok(r.includes(marker), marker);
  assert.ok(r.indexOf('OLDEST_USER_RULE') < r.indexOf('DETAILED_SUMMARY'));
  assert.ok(r.indexOf('DETAILED_SUMMARY') < r.indexOf('gen0.jsonl'));
  assert.ok(r.indexOf('gen1.jsonl') < r.indexOf('RECENT_ANSWER'));
  assert.equal(out.ledgerMessages, 2); assert.equal(out.ledgerTruncated, false);
  assert.ok(out.estimatedTotalTokens <= 80000);
});

test('large tool inputs and results are trimmed in retained history, but token calibration uses the untrimmed transcript', async () => {
  const { selectHistory } = await core();
  const big = 'W'.repeat(60000);
  const rows = [row('u', null, 'user', 'write it'), row('a', 'u', 'assistant', [{ type: 'tool_use', id: 't', name: 'Write', input: { file_path: '/f', content: big } }]), row('r', 'a', 'user', [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'R'.repeat(60000) }] }]), row('z', 'r', 'assistant', 'done')];
  const untrimmedBytes = Buffer.byteLength(JSON.stringify(rows.map(r => ({ source: r.uuid, role: r.type, content: r.message.content }))));
  const out = selectHistory(rows, { total_tokens: 60000, categories: [{ name: 'Messages', tokens: 50000 }] }, { summary: 'S' });
  assert.ok(Math.abs(out.ratio - 50000 / untrimmedBytes) / out.ratio < 0.01);
  assert.ok(out.selectedSources.includes('a') && out.selectedSources.includes('r'));
  assert.ok(out.reference.length < 30000);
  assert.match(out.reference, /"file_path":"\/f"/);
  assert.match(out.reference, /characters omitted/);
});
