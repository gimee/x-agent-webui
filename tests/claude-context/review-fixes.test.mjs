import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readdir } from 'node:fs/promises';
// hermes-v051:R1 review fixes: over-budget compactions, settings wait, opening records in file order.
import { fixture, summaryServer, json, native } from './flow-fixture.mjs';

const host = out => out.stdout.trim().split('\n').filter(Boolean).map(JSON.parse).filter(e => e.subtype === 'host_compaction');
const stages = async f => (await f.calls()).filter(c => c.stage).map(c => c.stage);
const PASTE = 'PASTE '.repeat(10000); // 60KB
const LOW = { HERMES_CC_COMPACT_THRESHOLD: '0.1', HERMES_CC_COMPACT_TARGET_RATIO: '0.08' }; // trigger 100K, hard limit 90K
const bigSummary = (e, res) => json(res, 200, { ok: true, summary: 'S '.repeat(15000), model: 'm', provider: 'p', seconds: 1, chunks: 1 }); // ~22K tokens
const unchanged = async f => {
  const cp = await f.records('checkpoint');
  assert.equal(cp.current, native);
  assert.equal(cp.generation, 0);
  assert.equal(cp.bootstrap, null);
  assert.equal(cp.retention, null);
  assert.deepEqual(cp.ledger, []);
  assert.deepEqual(cp.archive, []);
  assert.equal('summary' in cp, false);
  assert.equal('firstRecords' in cp, false);
  assert.deepEqual(cp.known, [native]);
  assert.equal(await f.records('pending'), null);
};

// hermes-v051:R1-01 (a) the fixed part plus the summary budget already exceeds the hard limit (0.1 → 90K):
// no summary is requested and the threshold compaction is skipped, so the user's turn still runs.
test('an over-budget threshold compaction is detected before any summary and the turn continues uncompacted, every turn', async t => {
  const f = await fixture(t, { tokens: 150000, base: 25000 }), aux = await summaryServer(t, bigSummary);
  for (const round of [1, 2]) {
    const out = await f.start(PASTE, { ...aux.env, ...LOW }).done;
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(host(out).map(e => [e.status, e.reason]), [['started', undefined], ['failed', 'over_budget']], `round ${round}`);
    const request = (await f.calls()).at(-1);
    assert.equal(request.stage, 'request');
    assert.equal(request.input, PASTE);
    assert.equal(request.args[request.args.indexOf('--resume') + 1], native);
    assert.match(out.stdout, /"type":"result"/);
    await unchanged(f);
  }
  assert.equal(aux.requests.length, 0, 'no summary request when the pre-check already fails');
  assert.deepEqual(await stages(f), ['context', 'request', 'context', 'request']);
});

// hermes-v051:R1-01 (b) the summary itself is too long for the hard limit: same outcome, nothing recorded.
test('a summary that does not fit the hard limit skips the compaction for this turn and records nothing', async t => {
  const f = await fixture(t, { tokens: 150000 }), aux = await summaryServer(t, bigSummary);
  for (const round of [1, 2]) {
    const out = await f.start(PASTE, { ...aux.env, ...LOW }).done;
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(host(out).map(e => [e.status, e.reason]), [['started', undefined], ['failed', 'over_budget']], `round ${round}`);
    assert.equal((await f.calls()).at(-1).input, PASTE);
    await unchanged(f);
  }
  assert.equal(aux.requests.length, 2, 'the pre-check passed, the summary was too long');
});

// hermes-v051:R1-01 (c) an explicit /compact still fails as before (user request), without a summary call.
test('manual /compact over the hard limit still fails, without requesting a summary', async t => {
  const f = await fixture(t, { tokens: 150000, base: 95000 }), aux = await summaryServer(t, bigSummary);
  const out = await f.start('/compact', { ...aux.env, ...LOW }).done;
  assert.equal(out.code, 75);
  assert.deepEqual(host(out).map(e => [e.status, e.reason]), [['started', undefined], ['failed', 'over_budget']]);
  assert.equal(aux.requests.length, 0);
  assert.deepEqual(await stages(f), ['context']);
  assert.equal(await f.records('checkpoint'), null);
  assert.equal(await f.records('pending'), null);
  assert.deepEqual((await readdir(f.state)).filter(x => x.startsWith('lock-')), []);
});

// hermes-v051:R1-06 a stalled settings endpoint delays a turn by at most ~2s.
test('a stalled settings endpoint is abandoned after 2 seconds and the launch env applies', async t => {
  const f = await fixture(t, { tokens: 100000 }), aux = await summaryServer(t, bigSummary, () => {});
  const started = Date.now();
  const out = await f.start('small turn', aux.env).done;
  const elapsed = Date.now() - started;
  assert.equal(out.code, 0, out.stderr);
  assert.equal(aux.settingsRequests.length, 1);
  assert.ok(elapsed >= 1900 && elapsed < 4000, String(elapsed));
});

// hermes-v051:R1-12 opening records are the conversation's first records in file order, not the active
// chain's (a generation-0 native compaction boundary hides the real opening from the chain).
test('opening records come from the whole generation-0 file, before a native compaction boundary', async t => {
  const f = await fixture(t, { tokens: 410000 });
  const rows = [
    { type: 'user', uuid: 'u0', parentUuid: null, sessionId: native, cwd: f.dir, message: { role: 'user', content: 'OPENING_RULE never touch prod' } },
    { type: 'assistant', uuid: 'a0', parentUuid: 'u0', sessionId: native, cwd: f.dir, message: { role: 'assistant', content: 'OPENING_REPLY understood' } },
    { type: 'user', uuid: 'side', parentUuid: 'a0', sessionId: native, isSidechain: true, message: { role: 'user', content: 'SIDECHAIN' } },
    { type: 'user', uuid: 'meta', parentUuid: 'a0', sessionId: native, isMeta: true, message: { role: 'user', content: 'META' } },
    { type: 'system', subtype: 'compact_boundary', uuid: 'cb', parentUuid: null, logicalParentUuid: 'a0', sessionId: native },
    { type: 'user', uuid: 's', parentUuid: 'cb', sessionId: native, isCompactSummary: true, message: { role: 'user', content: 'NATIVE_SUMMARY_TEXT' } },
    { type: 'user', uuid: 'u1', parentUuid: 's', sessionId: native, message: { role: 'user', content: 'AFTER_BOUNDARY' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: native, message: { role: 'assistant', content: 'filler '.repeat(200000) } },
  ];
  await writeFile(f.source, rows.map(JSON.stringify).join('\n') + '\n');
  const out = await f.start('GEN1_REQUEST').done;
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual((await f.records('checkpoint')).firstRecords.map(r => r.source), ['u0', 'a0', 'u1']);
  const opening = (await f.calls()).at(-1).input.split('=== [4/4]')[0].split('OPENING RECORDS')[1];
  assert.match(opening, /OPENING_RULE/);
  assert.match(opening, /OPENING_REPLY/);
  assert.doesNotMatch(opening, /SIDECHAIN|META|NATIVE_SUMMARY_TEXT/);
});
