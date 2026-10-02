import test from 'node:test';
import assert from 'node:assert/strict';

const core = () => import('../../bin/claude-context/core.mjs');
const sid = '22222222-2222-4222-8222-222222222222';

function row(uuid, parentUuid, type, content, extra = {}) {
  return {
    uuid,
    parentUuid,
    sessionId: sid,
    type,
    message: { role: type, content },
    ...extra,
  };
}
function use(id, name = 'WebSearch') {
  return { type: 'tool_use', id, name, input: { query: id } };
}
function result(id, text = `result:${id}`) {
  return { type: 'tool_result', tool_use_id: id, content: text };
}
function resultRow(uuid, callUuid, blocks, extra = {}) {
  return row(uuid, callUuid, 'user', blocks, { sourceToolAssistantUUID: callUuid, ...extra });
}
function assistant(uuid, parentUuid, blocks) {
  return row(uuid, parentUuid, 'assistant', blocks);
}

const context = { total_tokens: 20000, categories: [{ name: 'Messages', tokens: 10000 }] };

// Regression: activeChain follows one parent edge, while native results are
// sibling rows whose parent/source both point at their tool-use assistant.
test('closes two split assistant calls whose results complete out of order without reordering source rows', async () => {
  const { activeChain, validateHistory, selectHistory } = await core();
  const rows = [
    row('root', null, 'user', 'task'),
    assistant('call-1', 'root', [use('tool-1')]),
    assistant('call-2', 'call-1', [use('tool-2')]),
    resultRow('result-2', 'call-2', [result('tool-2')]),
    resultRow('result-1', 'call-1', [result('tool-1')]),
    row('final', 'result-2', 'assistant', 'final'),
  ];

  const closed = activeChain(rows, sid);
  assert.deepEqual(closed.map(r => r.uuid), ['root', 'call-1', 'call-2', 'result-2', 'result-1', 'final']);
  assert.equal(validateHistory(closed), closed);
  assert.doesNotThrow(() => selectHistory(closed, context, { summary: 'summary' }));
});

test('closes four calls from split assistant rows and one multi-call assistant row', async () => {
  const { activeChain, validateHistory } = await core();
  const rows = [
    row('root', null, 'user', 'task'),
    assistant('call-1', 'root', [use('tool-1')]),
    assistant('call-2', 'call-1', [use('tool-2'), use('tool-3')]),
    assistant('call-4', 'call-2', [use('tool-4')]),
    resultRow('result-3', 'call-2', [result('tool-3')]),
    resultRow('result-4', 'call-4', [result('tool-4')]),
    resultRow('result-1', 'call-1', [result('tool-1')]),
    resultRow('result-2', 'call-2', [result('tool-2')]),
    row('final', 'result-4', 'assistant', 'final'),
  ];

  const closed = activeChain(rows, sid);
  assert.deepEqual(closed.map(r => r.uuid), rows.map(r => r.uuid));
  assert.doesNotThrow(() => validateHistory(closed));
});

test('does not import sidechains or abandoned branches into the active closure', async () => {
  const { activeChain, validateHistory } = await core();
  const rows = [
    row('root', null, 'user', 'task'),
    assistant('abandoned-call', 'root', [use('abandoned-tool')]),
    resultRow('abandoned-result', 'abandoned-call', [result('abandoned-tool')]),
    assistant('active-call', 'root', [use('active-tool')]),
    assistant('side-call', 'active-call', [use('side-tool')],),
    resultRow('side-result', 'side-call', [result('side-tool')], { isSidechain: true }),
    resultRow('active-result', 'active-call', [result('active-tool')]),
    row('final', 'active-result', 'assistant', 'final'),
  ];
  rows[4].isSidechain = true;

  const closed = activeChain(rows, sid);
  assert.deepEqual(closed.map(r => r.uuid), ['root', 'active-call', 'active-result', 'final']);
  assert.doesNotThrow(() => validateHistory(closed));
});

test('respects the compact boundary and only closes the current generation', async () => {
  const { activeChain } = await core();
  const rows = [
    row('old-root', null, 'user', 'old'),
    assistant('old-call', 'old-root', [use('reused-tool')]),
    resultRow('old-result', 'old-call', [result('reused-tool')]),
    { type: 'system', subtype: 'compact_boundary', uuid: 'boundary', parentUuid: 'old-result', sessionId: sid },
    row('new-root', 'boundary', 'user', 'new'),
    assistant('new-call', 'new-root', [use('reused-tool')]),
    resultRow('new-result', 'new-call', [result('reused-tool')]),
    row('final', 'new-result', 'assistant', 'final'),
  ];

  const closed = activeChain(rows, sid);
  assert.deepEqual(closed.map(r => r.uuid), ['new-root', 'new-call', 'new-result', 'final']);
});

test('rejects a true missing result, duplicate result, and ambiguous result provenance', async () => {
  const { activeChain, validateHistory } = await core();
  const missing = [row('root', null, 'user', 'task'), assistant('call', 'root', [use('missing')]), row('final', 'call', 'assistant', 'final')];
  const partial = activeChain(missing, sid);
  assert.deepEqual(partial.map(r => r.uuid), ['root', 'call', 'final']);
  assert.throws(() => validateHistory(partial), /Unpaired native tool use/);

  const duplicate = [
    row('root', null, 'user', 'task'),
    assistant('call', 'root', [use('duplicate')]),
    resultRow('result-a', 'call', [result('duplicate')]),
    resultRow('result-b', 'call', [result('duplicate')]),
    row('final', 'result-a', 'assistant', 'final'),
  ];
  assert.throws(() => activeChain(duplicate, sid), /duplicate|ambiguous/i);

  const ambiguous = [
    row('root', null, 'user', 'task'),
    assistant('call', 'root', [use('ambiguous')]),
    resultRow('result-a', 'call', [result('ambiguous')]),
    resultRow('result-b', 'call', [result('ambiguous')], { sourceToolAssistantUUID: 'other-call' }),
    row('final', 'result-a', 'assistant', 'final'),
  ];
  assert.throws(() => activeChain(ambiguous, sid), /duplicate|ambiguous|Unpaired/i);
});

test('retains ordinary result chains whose parent is another result', async () => {
  const { activeChain, validateHistory } = await core();
  const rows = [row('root', null, 'user', 'task'), assistant('call', 'root', [use('one'), use('two')]),
    resultRow('r1', 'call', [result('one')]),
    resultRow('r2', 'r1', [result('two')], { sourceToolAssistantUUID: 'call' }),
    row('final', 'r2', 'assistant', 'done')];
  assert.deepEqual(activeChain(rows, sid), rows);
  assert.doesNotThrow(() => validateHistory(activeChain(rows, sid)));
});

test('does not guess a sibling result without sourceToolAssistantUUID', async () => {
  const { activeChain, validateHistory } = await core();
  const rows = [row('root', null, 'user', 'task'), assistant('call', 'root', [use('one')]),
    row('unproven', 'call', 'user', [result('one')]), row('final', 'call', 'assistant', 'done')];
  assert.throws(() => validateHistory(activeChain(rows, sid)), /Unpaired|Ambiguous/);
});

test('does not import sidechain rows sharing a main-chain UUID or UUID-less records', async () => {
  const { activeChain, validateHistory } = await core();
  const rows = [row('root', null, 'user', 'task'), assistant('call', 'root', [use('one'),use('two')]),
    resultRow('r1', 'call', [result('one')]), resultRow('r2', 'call', [result('two')]),
    row('final', 'r2', 'assistant', 'done')];
  rows.splice(4, 0, { ...rows[2], isSidechain: true, message: {content:'SIDECHAIN_SECRET'} });
  assert.equal(activeChain(rows,sid).filter(r=>r.isSidechain).length,0);
  const withoutId = { ...rows[2], uuid: undefined };
  assert.throws(() => validateHistory(activeChain([...rows.slice(0,2), withoutId, ...rows.slice(3)],sid)), /Unpaired|Missing|uuid|Ambiguous/);
});

test('early validation uses the same retained-row filter as selectHistory', async () => {
  const { validateHistory, selectHistory } = await core();
  const rows = [row('root',null,'user','task'), assistant('call','root',[use('one')]),
    resultRow('r1','call',[result('one')], {isMeta:true}), row('final','r1','assistant','done')];
  assert.throws(() => selectHistory(rows,context,{summary:'summary'}), /Unpaired/);
  assert.throws(() => validateHistory(rows), /Unpaired/);
});

test('keeps the original parent-chain order when storage order differs', async () => {
  const {activeChain} = await core();
  const a=row('root',null,'user','task'),b=row('middle','root','assistant','done'),c=row('final','middle','user','next');
  assert.deepEqual(activeChain([b,a,c],sid),[a,b,c]);
});

test('validateHistory rejects unknown and repeated results instead of silently skipping them', async () => {
  const { validateHistory } = await core();
  const unknown = [row('call', null, 'assistant', [use('known')]), row('result', 'call', 'user', [result('unknown')])];
  assert.throws(() => validateHistory(unknown), /Unpaired native tool result/);

  const repeated = [
    row('call', null, 'assistant', [use('known')]),
    row('result', 'call', 'user', [result('known'), result('known')]),
  ];
  assert.throws(() => validateHistory(repeated), /duplicate|ambiguous/i);
});
