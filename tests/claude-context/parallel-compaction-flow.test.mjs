import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fixture, summaryServer, json, native } from './flow-fixture.mjs';

// Synthetic Claude parallel-result topology: each result belongs to its own assistant row.
async function parallelHistory(f, { missing = false } = {}) {
  const original = (await readFile(f.source, 'utf8')).trim().split('\n').map(JSON.parse);
  const row = (uuid, parentUuid, type, content, extra = {}) => ({
    uuid, parentUuid, type, sessionId: native, cwd: f.dir,
    isSidechain: false, message: { role: type, content }, ...extra,
  });
  const calls = [0,1,2].map(i => row(`call-${i}`, i ? `call-${i-1}` : 'a', 'assistant', [
    { type: 'tool_use', id: `use-${i}`, name: 'WebSearch', input: { query: `synthetic-${i}` } },
  ]));
  const results = [1,0,2].filter(i => !missing || i !== 0).map(i => row(`result-${i}`, `call-${i}`, 'user', [
    { type: 'tool_result', tool_use_id: `use-${i}`, content: `PARALLEL_RESULT_${i}` },
  ], { sourceToolAssistantUUID: `call-${i}` }));
  const rows = [...original, ...calls, ...results, row('answer', 'result-2', 'assistant', [{ type: 'text', text: 'All searches read.' }])];
  await writeFile(f.source, rows.map(JSON.stringify).join('\n')+'\n');
  return readFile(f.source, 'utf8');
}
const ok = (_entry, res) => json(res, 200, {
  ok: true, summary: 'Synthetic auxiliary summary of parallel search results.', model: 'fixture', provider: 'custom:fixture', seconds: 0, chunks: 1,
});
const stages = async f => (await f.calls()).filter(c => c.stage).map(c => c.stage);

for (const auxiliary of [true, false]) test(`parallel results survive compaction end-to-end (${auxiliary ? 'auxiliary' : 'native fallback'})`, async t => {
  const f = await fixture(t, { tokens: 410000 });
  const before = await parallelHistory(f);
  const aux = await summaryServer(t, ok);
  const out = await f.start('NEW_INSTRUCTION_NOT_A_REPLAY', auxiliary ? aux.env : {}).done;
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(await stages(f), auxiliary ? ['context','request'] : ['context','summary','request']);
  assert.equal(aux.requests.length, auxiliary ? 1 : 0);
  if (auxiliary) {
    const sent = aux.requests[0].body.rows.flatMap(r => Array.isArray(r.content) ? r.content : []);
    assert.deepEqual(sent.filter(b => b.type === 'tool_result').map(b => b.tool_use_id).sort(), ['use-0','use-1','use-2']);
  }
  const cp = await f.records('checkpoint');
  assert.equal(cp.generation, 1);
  assert.notEqual(cp.current, native);
  assert.equal(await f.records('pending'), null);
  const delivered = (await f.calls()).at(-1).input;
  const recent = delivered.split('=== [4/4]')[1];
  for (const i of [0,1,2]) assert.match(recent, new RegExp(`PARALLEL_RESULT_${i}`));
  assert.match(delivered, /NEW_INSTRUCTION_NOT_A_REPLAY/);
  assert.equal(await readFile(f.source, 'utf8'), before);
  assert.equal(await readFile(cp.archive.at(-1).path, 'utf8'), before);
});

for (const auxiliary of [true, false]) test(`truly missing results stop before any summary or task (${auxiliary ? 'auxiliary' : 'native fallback'})`, async t => {
  const f = await fixture(t, { tokens: 410000 });
  const before = await parallelHistory(f, { missing: true });
  const aux = await summaryServer(t, ok);
  const out = await f.start('MUST_NOT_EXECUTE', auxiliary ? aux.env : {}).done;
  assert.equal(out.code, 75);
  assert.match(out.stderr, /Unpaired native tool use/);
  assert.equal(aux.requests.length, 0, 'invalid input must not spend minutes generating a summary');
  assert.deepEqual(await stages(f), ['context']);
  assert.equal(await f.records('checkpoint'), null);
  assert.equal(await f.records('pending'), null);
  assert.equal(await readFile(f.source, 'utf8'), before);
  assert.doesNotMatch(out.stdout, /"type":"result"/);
});

test('parallel history below the compaction threshold stays on the native session', async t => {
  const f = await fixture(t, { tokens: 100000 });
  await parallelHistory(f);
  const aux = await summaryServer(t, ok);
  const out = await f.start('ordinary follow-up', aux.env).done;
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(await stages(f), ['context','request']);
  assert.equal(aux.requests.length, 0);
  assert.equal((await f.records('checkpoint')).current, native);
  assert.equal((await f.records('checkpoint')).generation, 0);
  assert.equal((await f.calls()).at(-1).input, 'ordinary follow-up');
});
