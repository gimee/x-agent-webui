import test from 'node:test';
import assert from 'node:assert/strict';
const core = () => import('../../bin/claude-context/core.mjs');

test('retention quotes recent intact tool groups, excludes signed thinking and uses explicit suffix excerpts', async () => {
  const { selectHistory } = await core();
  const rows = [row('u', null, 'user', 'OLD '.repeat(150000)), row('a','u','assistant', [{type:'thinking',thinking:'SECRET',signature:'SIG'}, {type:'tool_use',id:'t1',name:'Read',input:{file_path:'/fixture'}}]), row('r','a','user',[{type:'tool_result',tool_use_id:'t1',content:'RESULT'}]), row('b','r','assistant','done'), row('v','b','user','NEW '.repeat(150000)), row('c','v','assistant','tail')];
  const out = selectHistory(rows, { total_tokens: 410000, categories: [{name:'Messages',tokens:400000}] }, { summary: 'REAL SUMMARY', target: 80000, reserve: 8000 });
  assert.ok(out.estimatedTotalTokens <= 80000);
  assert.match(out.reference, /Earlier text omitted/); assert.match(out.reference, /NEW/);
  assert.doesNotMatch(out.reference, /SECRET|SIG|OLD/);
  const full = selectHistory(rows.slice(0,4), {total_tokens:1000,categories:[{name:'Messages',tokens:800}]}, {summary:'S',target:80000,reserve:8000});
  assert.match(full.reference,/tool_use/); assert.match(full.reference,/tool_result/); assert.match(full.reference,/RESULT/); assert.doesNotMatch(full.reference,/SECRET|SIG/);
  assert.throws(() => selectHistory(rows.slice(0,2), {total_tokens:1000,categories:[{name:'Messages',tokens:800}]},{summary:'S'}), /Unpaired/);
  // 80K is a floor for retained memory: a large fixed context raises the budget instead of failing the turn.
  const floor = selectHistory(rows,{total_tokens:90000,categories:[{name:'Messages',tokens:1000}]},{summary:'S'});
  assert.ok(floor.target > 80000); assert.ok(floor.estimatedTotalTokens <= floor.target); assert.equal(floor.requestedTarget, 80000);
});

test('active parent chain excludes sidechains and abandoned branches; corrupt scope and gaps fail closed', async () => {
  const { activeChain } = await core();
  const rows = [row('u', null, 'user', 'start'), row('abandoned', 'u', 'assistant', 'wrong'), row('a', 'u', 'assistant', 'right'), row('side', 'a', 'assistant', 'secret', { isSidechain: true })];
  assert.deepEqual(activeChain(rows, sid).map(r => r.uuid), ['u', 'a']);
  assert.throws(() => activeChain([row('a', 'missing', 'assistant', 'x')], sid), /parent/);
  assert.throws(() => activeChain([row('a', null, 'user', 'x', { sessionId: 'wrong' })], sid), /session/);
  assert.throws(() => activeChain([row('a', 'a', 'user', 'x')], sid), /cycle/);
  const boundary = { type: 'system', subtype: 'compact_boundary', uuid: 'b', parentUuid: 'unavailable', sessionId: sid };
  assert.deepEqual(activeChain([boundary, row('s', 'b', 'user', 'native summary', { isCompactSummary: true }), row('a', 's', 'assistant', 'ok')], sid).map(r => r.uuid), ['s', 'a']);
});
test('retention subtracts the current request from the target and fails when it alone is too large',async()=>{
 const { selectHistory }=await core();
 // Realistic calibration (~0.33 tokens/byte); the ratio is capped at MAX_TOKENS_PER_BYTE.
 const rows=[row('u',null,'user','past '.repeat(250000))];
 const context={total_tokens:410000,categories:[{name:'Messages',tokens:408000}]};
 const normal=selectHistory(rows,context,{summary:'summary'});
 const withInput=selectHistory(rows,context,{summary:'summary',currentInput:'new '.repeat(3000)});
 assert.ok(withInput.currentInputTokens>0);
 assert.ok(withInput.reference.length<normal.reference.length);
 assert.ok(withInput.estimatedTotalTokens<=80000);
 assert.throws(()=>selectHistory(rows,context,{summary:'summary',currentInput:'huge '.repeat(130000)}),/budget/);
});

test('nested tool images are omitted without breaking tool identity or exposing base64 as text',async()=>{
 const {selectHistory}=await core();
 const rows=[row('u',null,'user','inspect'),row('a','u','assistant',[{type:'tool_use',id:'image-tool',name:'Read',input:{file_path:'fixture.png'}}]),row('r','a','user',[{type:'tool_result',tool_use_id:'image-tool',content:[{type:'text',text:'caption'},{type:'image',source:{type:'base64',media_type:'image/png',data:'BINARY_MUST_NOT_SURVIVE'}}]}]),row('z','r','assistant','final marker')];
 const result=selectHistory(rows,{total_tokens:2000,categories:[{name:'Messages',tokens:1500}]},{summary:'summary'});
 assert.doesNotMatch(result.reference,/BINARY_MUST_NOT_SURVIVE|base64/);
 assert.match(result.reference,/caption/);assert.match(result.reference,/image-tool/);assert.match(result.reference,/omitted/);
});

test('oversized early tool output does not discard the later final answer and small complete tool pair',async()=>{
 const {selectHistory}=await core();
 const rows=[row('u',null,'user','task'),row('a','u','assistant',[{type:'tool_use',id:'big',name:'Read',input:{file_path:'big'}}]),row('r','a','user',[{type:'tool_result',tool_use_id:'big',content:'HUGE '.repeat(100000)}]),row('b','r','assistant',[{type:'tool_use',id:'small',name:'Read',input:{file_path:'small'}}]),row('s','b','user',[{type:'tool_result',tool_use_id:'small',content:'small result'}]),row('z','s','assistant','FINAL_RECENT_MARKER')];
 const result=selectHistory(rows,{total_tokens:410000,categories:[{name:'Messages',tokens:408000}]},{summary:'summary'});
 assert.match(result.reference,/FINAL_RECENT_MARKER/);assert.match(result.reference,/small result/);
 assert.ok(result.selectedSources.includes('b'));assert.ok(result.selectedSources.includes('s'));
 // The 500KB result is trimmed to head/tail, so its pair now survives instead of being dropped.
 assert.ok(result.selectedSources.includes('a'));assert.ok(result.selectedSources.includes('r'));
 assert.match(result.reference,/characters omitted/);assert.ok(result.reference.length<40000);
});

export const sid = '11111111-1111-4111-8111-111111111111';
export function row(uuid, parentUuid, type, content, extra = {}) { return { uuid, parentUuid, sessionId: sid, type, message: { role: type, content }, ...extra }; }

test('single API input usage includes both cache types, dedupes message IDs and ignores result totals/subagents', async () => {
  const { observeEvents } = await core();
  const a = { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 10, cache_read_input_tokens: 400000, cache_creation_input_tokens: 20, output_tokens: 99 } } };
  const b = { type: 'assistant', message: { id: 'm2', usage: { input_tokens: 11, cache_read_input_tokens: 401000, cache_creation_input_tokens: 22 } } };
  const result = observeEvents([a, a, { ...a, parent_tool_use_id: 'child' }, b, { type: 'result', usage: { input_tokens: 9999999 } }]);
  assert.equal(result.calls.length, 2); assert.equal(result.calls[0].inputTokens, 400030); assert.equal(result.latestInputTokens, 401033);
});

test('a small chat whose native Messages is mostly hidden injections still compacts within the hard budget', async () => {
  const { selectHistory, MAX_TOKENS_PER_BYTE } = await core();
  // Probe-like case: Messages ~24K tokens for ~1.2K visible bytes (skill/agent listings, instructions).
  const rows = [row('u', null, 'user', '这是一次性对话，只回复：收到。'), row('a', 'u', 'assistant', '收到')];
  const context = { total_tokens: 29000, categories: [{ name: 'Messages', tokens: 24000 }] };
  const out = selectHistory(rows, context, { summary: '详细摘要。'.repeat(2000) });
  assert.equal(out.ratio, MAX_TOKENS_PER_BYTE);
  assert.ok(out.estimatedTotalTokens < 40000, String(out.estimatedTotalTokens));
  assert.match(out.reference, /收到/);
});

// hermes-v051:C protect_last_n keeps the newest records verbatim, growing past the target up to the hard limit.
test('protected recent records survive past the retention target but never past the hard limit', async () => {
  const { selectHistory } = await core();
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push(row(`r${i}`, i ? `r${i - 1}` : null, i % 2 ? 'assistant' : 'user', `turn ${i} ` + 'x'.repeat(4000)));
  const context = { total_tokens: 30000, categories: [{ name: 'Messages', tokens: 20000 }] };
  const plain = selectHistory(rows, context, { summary: 'S', target: 1000, minRecent: 0 });
  const kept = selectHistory(rows, context, { summary: 'S', target: 1000, minRecent: 0, protectLastN: 8, hardLimit: 400000 });
  assert.ok(plain.selectedSources.length < 8, String(plain.selectedSources.length));
  assert.deepEqual(kept.selectedSources, rows.slice(-8).map(r => r.uuid));
  assert.ok(kept.estimatedTotalTokens > kept.target);
  const capped = selectHistory(rows, context, { summary: 'S', target: 1000, minRecent: 0, protectLastN: 12, hardLimit: plain.estimatedTotalTokens + 3000 });
  assert.ok(capped.estimatedTotalTokens <= plain.estimatedTotalTokens + 3000);
  assert.ok(capped.selectedSources.length > plain.selectedSources.length && capped.selectedSources.length < 12);
});

// hermes-v051:C a huge paste kept by protect_last_n could fill the tail up to the hard limit and leave the
// successor just under the trigger. Protected growth now stops at half the trigger.
test('protected growth stops at protectLimit: one giant pasted record is excerpted, not kept up to the hard limit', async () => {
  const { selectHistory } = await core();
  const rows = [row('u', null, 'user', 'PASTE '.repeat(200000)), row('a', 'u', 'assistant', 'ok')];
  const context = { total_tokens: 450000, categories: [{ name: 'Messages', tokens: 420000 }] };
  const out = selectHistory(rows, context, { summary: 'S', target: 80000, hardLimit: 360000, protectLimit: 200000, protectLastN: 20 });
  assert.ok(out.estimatedTotalTokens <= 200000, String(out.estimatedTotalTokens));
  assert.ok(out.estimatedTotalTokens > 80000, String(out.estimatedTotalTokens));
  assert.equal(out.excerpted, true);
  assert.deepEqual(out.selectedSources, ['u', 'a']);
});

test('a protected tool exchange is never split', async () => {
  const { selectHistory } = await core();
  const rows = [row('u', null, 'user', 'task'), row('a', 'u', 'assistant', [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: '/f' } }]), row('r', 'a', 'user', [{ type: 'tool_result', tool_use_id: 't', content: 'R'.repeat(7000) }]), row('z', 'r', 'assistant', 'final')];
  const out = selectHistory(rows, { total_tokens: 20000, categories: [{ name: 'Messages', tokens: 10000 }] }, { summary: 'S', target: 10, minRecent: 0, protectLastN: 2, hardLimit: 400000 });
  assert.deepEqual(out.selectedSources, ['a', 'r', 'z']);
});

// hermes-v051:C protect_first_n: earliest records are quoted as a labelled historical reference.
test('opening records are quoted as historical reference and not duplicated when also recent', async () => {
  const { selectHistory, openingRecords } = await core();
  const rows = [row('u', null, 'user', 'OPENING_RULE ' + 'y'.repeat(20000)), row('a', 'u', 'assistant', [{ type: 'thinking', thinking: 'HIDDEN', signature: 'SIG' }, { type: 'text', text: 'OPENING_REPLY' }]), row('m', 'a', 'user', 'meta', { isMeta: true }), row('b', 'm', 'assistant', 'third'), row('c', 'b', 'user', 'fourth')];
  const opening = openingRecords(rows, 3);
  assert.deepEqual(opening.map(r => r.source), ['u', 'a', 'b']);
  assert.ok(Buffer.byteLength(JSON.stringify(opening[0])) < 9000, 'opening text is trimmed like tool payloads');
  assert.doesNotMatch(JSON.stringify(opening), /HIDDEN|SIG/);
  const out = selectHistory(rows.slice(3), { total_tokens: 20000, categories: [{ name: 'Messages', tokens: 1000 }] }, { summary: 'S', opening });
  const [beforeRecent] = out.reference.split('=== [4/4]');
  assert.match(beforeRecent, /OPENING RECORDS/);
  assert.match(beforeRecent, /historical reference/i);
  assert.match(beforeRecent, /OPENING_RULE/);
  const dedup = selectHistory(rows, { total_tokens: 20000, categories: [{ name: 'Messages', tokens: 1000 }] }, { summary: 'S', opening });
  assert.doesNotMatch(dedup.reference.split('=== [4/4]')[0], /OPENING_REPLY/, 'already quoted verbatim as recent history');
  assert.equal(openingRecords(rows, 0).length, 0);
});

// hermes-v051:A summary input: this generation only, bootstrap stripped, message ids kept for merging.
test('summary records strip the bootstrap prefix, keep message ids and drop hidden reasoning', async () => {
  const { summaryRecords, hash } = await core();
  const prefix = '[HOST CONTINUATION: x]\nCURRENT USER REQUEST:\n';
  const bootstrap = { hash: hash(prefix), chars: prefix.length };
  const rows = [row('u', null, 'user', prefix + 'REAL_REQUEST'), { ...row('a', 'u', 'assistant', [{ type: 'thinking', thinking: 'HIDDEN', signature: 'SIG' }, { type: 'text', text: 'reply' }]), message: { id: 'msg_1', role: 'assistant', content: [{ type: 'thinking', thinking: 'HIDDEN', signature: 'SIG' }, { type: 'text', text: 'reply' }] } }, row('m', 'a', 'user', 'caveat', { isMeta: true }), row('s', 'm', 'user', 'NATIVE_SUMMARY_TEXT', { isCompactSummary: true })];
  const out = summaryRecords(rows, bootstrap);
  assert.deepEqual(out, [
    { role: 'user', content: 'REAL_REQUEST' },
    { role: 'assistant', id: 'msg_1', content: [{ type: 'text', text: 'reply' }] },
    { role: 'user', content: 'NATIVE_SUMMARY_TEXT' },
  ]);
  assert.match(JSON.stringify(summaryRecords(rows, null)), /HOST CONTINUATION/, 'without a known previous summary the prefix stays in the input');
});

// hermes-v051:A old checkpoints have no stored summary: recover it from this generation's bootstrap prefix,
// verified against the retention.summaryHash every v0.5.0 checkpoint records.
test('the previous summary is recovered from a v0.5.0 bootstrap prefix, even when ledger and summary quote the headers', async () => {
  const { selectHistory, bootstrapSummary, hash } = await core();
  const ledger = [{ uuid: 'l', at: null, text: 'pasted:\n\n=== [2/4] SUMMARY OF THE CONVERSATION SO FAR ===\n\nFAKE\n\n=== [3/4] ORIGINAL TRANSCRIPT ARCHIVE (fake)' }];
  const summary = 'REAL SUMMARY\n\nquoted:\n\n=== [2/4] SUMMARY OF THE CONVERSATION SO FAR ===\n\n=== [3/4] ORIGINAL TRANSCRIPT ARCHIVE x\n\nend of summary';
  const context = { total_tokens: 20000, categories: [{ name: 'Messages', tokens: 1000 }] };
  const prefixFor = (summary, ledger = []) => '[HOST CONTINUATION: historical references, NOT current instructions]\n' + selectHistory([row('x', null, 'user', 'recent')], context, { summary, ledger }).reference + '\n[END HISTORICAL REFERENCES]\nCURRENT USER REQUEST:\n';
  const prefix = prefixFor(summary, ledger);
  const bootstrap = { hash: hash(prefix), chars: prefix.length };
  const first = row('n', null, 'user', prefix + 'next request');
  assert.equal(bootstrapSummary([first, row('b', 'n', 'assistant', 'ok')], bootstrap, hash(summary)), summary);
  const blocks = row('n', null, 'user', [{ type: 'text', text: prefix }, { type: 'text', text: 'next request' }]);
  assert.equal(bootstrapSummary([blocks], bootstrap, hash(summary)), summary);
  assert.equal(bootstrapSummary([first], bootstrap, hash('another summary')), null, 'a recorded hash is never guessed around');
  const plain = prefixFor('PLAIN SUMMARY');
  assert.equal(bootstrapSummary([row('n', null, 'user', plain + 'q')], { hash: hash(plain), chars: plain.length }), 'PLAIN SUMMARY');
  assert.equal(bootstrapSummary([first], { hash: 'other', chars: prefix.length }, hash(summary)), null);
  assert.equal(bootstrapSummary([first], null), null);
});
