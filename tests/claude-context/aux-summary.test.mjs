import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
// hermes-v051:A/C/B3 auxiliary-model summaries, compression settings and failure status.
import { fixture, summaryServer, json, native } from './flow-fixture.mjs';

const AUX = 'AUX SUMMARY: the auxiliary model kept FIXTURE_MARKER.';
const FORK = 'SYNTHETIC SUMMARY: remember FIXTURE_MARKER.';
const ok = (summary = AUX) => (entry, res) => json(res, 200, { ok: true, summary, model: 'grok-fixture', provider: 'custom:fixture', seconds: 1.5, chunks: 1 });
const host = out => out.stdout.trim().split('\n').filter(Boolean).map(JSON.parse).filter(e => e.subtype === 'host_compaction');
const stages = async f => (await f.calls()).filter(c => c.stage).map(c => c.stage);
const until = async (check, what) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error(`Timed out waiting for ${what}`);
};
const COMPACT = { HERMES_CC_COMPACT_ENABLED: '1', HERMES_CC_COMPACT_THRESHOLD: '0.4', HERMES_CC_COMPACT_TARGET_RATIO: '0.08', HERMES_CC_COMPACT_PROTECT_LAST_N: '20', HERMES_CC_COMPACT_PROTECT_FIRST_N: '3' };

test('the auxiliary summary replaces the Claude fork: loopback bearer request, no fork, summarizer aux', async t => {
  const f = await fixture(t, { tokens: 410000 }), aux = await summaryServer(t, ok());
  const out = await f.start('CURRENT_REQUEST_NOT_SUMMARIZED', aux.env).done;
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(await stages(f), ['context', 'request']);
  const request = (await f.calls()).at(-1);
  assert.match(request.input, /AUX SUMMARY: the auxiliary model/);
  assert.match(request.input, /CURRENT_REQUEST_NOT_SUMMARIZED/);
  assert.equal(aux.requests.length, 1);
  const [sent] = aux.requests;
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, '/api/coding-agents/claude-context/summary');
  assert.equal(sent.headers.authorization, 'Bearer fixture-summary-token');
  assert.equal(sent.body.session_id, 'studio-fixture');
  assert.equal(sent.body.previous_summary, null);
  assert.equal(sent.body.focus, null);
  assert.equal(sent.body.summary_budget, 8000);
  assert.deepEqual(sent.body.rows.map(r => r.role), ['user', 'assistant']);
  assert.match(sent.body.rows[0].content, /FIXTURE_MARKER/);
  assert.doesNotMatch(JSON.stringify(sent.body), /CURRENT_REQUEST_NOT_SUMMARIZED/);
  const lines = host(out);
  assert.deepEqual(lines.map(e => e.status), ['started', 'completed']);
  assert.equal(lines[1].summarizer, 'aux');
  assert.equal('reason' in lines[1], false);
  const cp = await f.records('checkpoint');
  assert.equal(cp.summary, AUX);
  assert.equal(cp.retention.summarizer, 'aux');
  assert.equal(cp.retention.summaryHash !== undefined, true);
  assert.equal(cp.generation, 1);
  assert.doesNotMatch(out.stderr + out.stdout, /fixture-summary-token/);
});

test('manual /compact focus is sent to the auxiliary summarizer and the successor gets only the acknowledgement', async t => {
  const f = await fixture(t, { tokens: 100000 }), aux = await summaryServer(t, ok());
  const out = await f.start('/compact keep the gate numbers', aux.env).done;
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(await stages(f), ['context', 'request']);
  assert.equal(aux.requests[0].body.focus, 'keep the gate numbers');
  assert.match((await f.calls()).at(-1).input, /Context compacted/);
});

const fallbacks = [
  ['unavailable (auto / unset auxiliary model)', 'aux_unavailable', (e, res) => json(res, 200, { ok: false, reason: 'unavailable' })],
  ['HTTP error', 'aux_http_500', (e, res) => json(res, 500, { ok: false, reason: 'failed' })],
  ['unauthorized', 'aux_http_401', (e, res) => json(res, 401, { ok: false, reason: 'unauthorized' })],
  ['empty summary', 'aux_invalid', (e, res) => json(res, 200, { ok: true, summary: '   ' })],
  ['server-side validation failure', 'aux_invalid_summary', (e, res) => json(res, 200, { ok: false, reason: 'invalid_summary' })],
  ['non-JSON body', 'aux_invalid', (e, res) => { res.writeHead(200); res.end('<html>'); }],
  ['timeout after the announced deadline', 'aux_timeout', (e, res) => { res.writeHead(200, { 'content-type': 'application/json', 'x-hermes-summary-deadline-ms': '300' }); res.flushHeaders(); }],
];
for (const [name, reason, reply] of fallbacks) test(`${name} falls back to the Claude fork in the same turn`, async t => {
  const f = await fixture(t, { tokens: 410000 }), aux = await summaryServer(t, reply);
  const started = Date.now();
  const out = await f.start('SAME_TURN_REQUEST', aux.env).done;
  assert.equal(out.code, 0, out.stderr);
  assert.ok(Date.now() - started < 10000);
  assert.equal(aux.requests.length, 1);
  assert.deepEqual(await stages(f), ['context', 'summary', 'request']);
  assert.match((await f.calls()).at(-1).input, /SYNTHETIC SUMMARY/);
  const lines = host(out);
  assert.deepEqual(lines.map(e => e.status), ['started', 'completed']);
  assert.equal(lines[1].summarizer, 'claude');
  assert.equal(lines[1].reason, reason);
  assert.equal((await f.records('checkpoint')).summary, FORK);
});

for (const [name, env, reason] of [
  ['unreachable endpoint', { HERMES_CC_SUMMARY_URL: 'http://127.0.0.1:1/api/coding-agents/claude-context/summary', HERMES_CC_SUMMARY_TOKEN: 'fixture-summary-token' }, 'aux_error'],
  ['non-loopback endpoint', { HERMES_CC_SUMMARY_URL: 'http://example.invalid/api/coding-agents/claude-context/summary', HERMES_CC_SUMMARY_TOKEN: 'fixture-summary-token' }, 'aux_unconfigured'],
  ['missing endpoint (older launch)', {}, 'aux_unconfigured'],
]) test(`${name} falls back to the Claude fork`, async t => {
  const f = await fixture(t, { tokens: 410000 });
  const out = await f.start('request', env).done;
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(await stages(f), ['context', 'summary', 'request']);
  assert.equal(host(out)[1].reason, reason);
});

test('NATIVE_SUMMARY switches summaries back to Claude without contacting the endpoint', async t => {
  const f = await fixture(t, { tokens: 410000 }), aux = await summaryServer(t, ok());
  await writeFile(join(f.state, 'NATIVE_SUMMARY'), '');
  const out = await f.start('request', aux.env).done;
  assert.equal(out.code, 0, out.stderr);
  assert.equal(aux.requests.length, 0);
  assert.deepEqual(await stages(f), ['context', 'summary', 'request']);
  assert.deepEqual(host(out)[1], { type: 'system', subtype: 'host_compaction', status: 'completed', pre_tokens: 410000, post_tokens: (await f.records('checkpoint')).retention.estimatedTotalTokens, summarizer: 'claude', reason: 'native_summary' });
});

// hermes-v051:R1-13 checks each native child's own env only (not /proc/<wrapper pid>/environ).
test('summary endpoint, token and compaction settings are absent from every native child env', async t => {
  const f = await fixture(t, { tokens: 410000 }), aux = await summaryServer(t, ok());
  const scoped = { ...aux.env, ...COMPACT };
  // Managed turn with a Claude fork (endpoint unavailable), then an auxiliary turn.
  await writeFile(join(f.state, 'NATIVE_SUMMARY'), '');
  assert.equal((await f.start('fork turn', scoped).done).code, 0);
  await rm(join(f.state, 'NATIVE_SUMMARY'));
  assert.equal((await f.start('aux turn', { ...scoped, HERMES_CC_COMPACT_THRESHOLD: '0.2' }).done).code, 0);
  assert.equal(aux.requests.length, 1);
  // Unmanaged pass-through and a non-print native invocation.
  const unmanaged = f.args.map(v => v === 'claude-opus-5-5[1m]' ? 'unverified-model' : v);
  assert.equal((await f.start('unmanaged', { ...scoped, HERMES_CC_PROFILE_ID: '', HERMES_STUDIO_SESSION_ID: '', HERMES_CC_STATE_DIR: '' }, unmanaged).done).code, 0);
  assert.equal((await f.start('interactive', scoped, ['--resume', native, '--output-format', 'stream-json']).done).code, 0);
  const calls = (await f.calls()).filter(c => c.stage);
  assert.ok(calls.length >= 7, String(calls.length));
  for (const call of calls) assert.deepEqual(call.hostEnv, [], call.stage);
});

test('the second compaction sends only the previous summary and this generation\'s new rows', async t => {
  const f = await fixture(t, { tokens: 410000 });
  let n = 0;
  const aux = await summaryServer(t, (e, res) => ok(`AUX SUMMARY ${++n} ` + 'detail '.repeat(20))(e, res));
  assert.equal((await f.start('GEN1_REQUEST', aux.env).done).code, 0);
  const second = await f.start('GEN2_REQUEST', aux.env).done;
  assert.equal(second.code, 0, second.stderr);
  const [first, next] = aux.requests;
  assert.equal(first.body.previous_summary, null);
  assert.match(JSON.stringify(first.body.rows), /FIXTURE_MARKER/);
  assert.match(next.body.previous_summary, /^AUX SUMMARY 1 /);
  const rows = JSON.stringify(next.body.rows);
  assert.match(rows, /GEN1_REQUEST/);
  assert.match(rows, /SYNTHETIC USER RESPONSE/);
  assert.doesNotMatch(rows, /HOST CONTINUATION|FIXTURE_MARKER|AUX SUMMARY 1|GEN2_REQUEST/);
  const cp = await f.records('checkpoint');
  assert.equal(cp.generation, 2);
  assert.match(cp.summary, /^AUX SUMMARY 2 /);
  assert.equal((await f.records('pending')), null);
});

test('an old checkpoint without the new fields recovers its summary from the bootstrap and its opening records from the archive', async t => {
  const f = await fixture(t, { tokens: 410000 });
  assert.equal((await f.start('GEN1_REQUEST').done).code, 0);
  // Simulate a v0.5.0 checkpoint: only the new optional fields are absent.
  const path = await f.recordPath('checkpoint'), cp = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(cp.summary, FORK);
  assert.deepEqual(cp.firstRecords.map(r => r.source), ['u', 'a']);
  delete cp.summary; delete cp.firstRecords;
  await writeFile(path, JSON.stringify(cp));
  const aux = await summaryServer(t, ok());
  const out = await f.start('GEN2_REQUEST', aux.env).done;
  assert.equal(out.code, 0, out.stderr);
  assert.equal(aux.requests[0].body.previous_summary, FORK);
  assert.doesNotMatch(JSON.stringify(aux.requests[0].body.rows), /HOST CONTINUATION/);
  const gen2 = (await f.calls()).at(-1).input.split('=== [4/4]')[0];
  assert.match(gen2, /OPENING RECORDS/);
  assert.match(gen2, /"source":"u"/);
  const after = await f.records('checkpoint');
  assert.equal(after.summary, AUX);
  assert.deepEqual(after.firstRecords.map(r => r.source), ['u', 'a']);
});

test('protect_first_n opening records are taken from generation 0 and carried by later compactions', async t => {
  const f = await fixture(t, { tokens: 410000 });
  assert.equal((await f.start('GEN1_REQUEST').done).code, 0);
  assert.equal((await f.start('GEN2_REQUEST').done).code, 0);
  const gen2 = (await f.calls()).at(-1).input.split('=== [4/4]')[0];
  assert.match(gen2, /OPENING RECORDS/);
  assert.match(gen2, /"source":"u"/);
  assert.equal((await f.records('checkpoint')).generation, 2);
  assert.equal((await f.start('GEN3_REQUEST', { HERMES_CC_COMPACT_PROTECT_FIRST_N: '0' }).done).code, 0);
  assert.doesNotMatch((await f.calls()).at(-1).input, /OPENING RECORDS/);
});

test('user cancellation aborts the in-flight summary request and reports failed', async t => {
  const f = await fixture(t, { tokens: 410000 });
  const aux = await summaryServer(t, (e, res) => { res.writeHead(200, { 'x-hermes-summary-deadline-ms': '60000' }); res.flushHeaders(); });
  const run = f.start('CANCEL_ME', aux.env);
  await until(() => aux.requests.length === 1, 'summary request');
  run.child.kill('SIGTERM');
  const out = await run.done;
  assert.equal(out.code, 143);
  await until(() => aux.requests[0].closed, 'aborted HTTP request');
  assert.deepEqual(host(out).map(e => [e.status, e.reason]), [['started', undefined], ['failed', 'cancelled']]);
  assert.deepEqual(await stages(f), ['context']);
  assert.equal(await f.records('checkpoint'), null);
  assert.equal(await f.records('pending'), null);
  assert.deepEqual((await readdir(f.state)).filter(x => x.startsWith('lock-')), []);
});

test('when neither the auxiliary model nor Claude writes a summary the turn reports failed', async t => {
  const f = await fixture(t, { tokens: 410000, fail: 'summary' }), aux = await summaryServer(t, (e, res) => json(res, 200, { ok: false, reason: 'unavailable' }));
  const out = await f.start('request', aux.env).done;
  assert.equal(out.code, 75);
  assert.deepEqual(host(out).map(e => [e.status, e.reason]), [['started', undefined], ['failed', 'summary_failed']]);
  assert.doesNotMatch(JSON.stringify(host(out)), /SYNTHETIC|FIXTURE_MARKER/);
});

test('following main settings 0.8/0.5 moves the trigger, retention target and native backstop', async t => {
  const f = await fixture(t, { tokens: 410000 });
  const follow = { HERMES_CC_COMPACT_THRESHOLD: '0.8', HERMES_CC_COMPACT_TARGET_RATIO: '0.5' };
  const below = await f.start('below the new trigger', follow).done;
  assert.equal(below.code, 0, below.stderr);
  assert.deepEqual(await stages(f), ['context', 'request']);
  assert.deepEqual(host(below), []);
  await f.setScenario({ tokens: 810000 });
  const above = await f.start('above the new trigger', follow).done;
  assert.equal(above.code, 0, above.stderr);
  assert.deepEqual((await stages(f)).slice(2), ['context', 'summary', 'request']);
  assert.equal(host(above)[0].pre_tokens, 810000);
  assert.equal((await f.records('checkpoint')).retention.requestedTarget, 500000);
  for (const call of (await f.calls()).filter(c => c.stage)) {
    assert.equal(call.envWindow, '1000000');
    assert.equal(call.settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1000000');
  }
});

test('a threshold above 0.8 is applied as 0.8', async t => {
  const f = await fixture(t, { tokens: 800000 });
  const out = await f.start('request', { HERMES_CC_COMPACT_THRESHOLD: '0.95' }).done;
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(host(out).map(e => e.status), ['started', 'completed']);
});

test('enabled=0 never compacts by threshold (no /context fork) but manual /compact still does', async t => {
  const f = await fixture(t, { tokens: 900000 }), off = { HERMES_CC_COMPACT_ENABLED: '0' };
  const auto = await f.start('stays native', off).done;
  assert.equal(auto.code, 0, auto.stderr);
  assert.deepEqual(await stages(f), ['request']);
  assert.deepEqual(host(auto), []);
  const manual = await f.start('/compact', off).done;
  assert.equal(manual.code, 0, manual.stderr);
  assert.deepEqual((await stages(f)).slice(1), ['context', 'summary', 'request']);
  assert.deepEqual(host(manual).map(e => e.status), ['started', 'completed']);
  assert.equal((await f.records('checkpoint')).generation, 1);
  for (const call of (await f.calls()).filter(c => c.stage)) assert.equal(call.envWindow, '600000', 'the native backstop stays on');
});

// hermes-v051:C the run (and so its launch env) outlives turns: settings are re-read from the WebUI on
// every managed turn so a main-settings change applies to the next message; the launch env is the fallback.
test('compression settings are re-read from the WebUI on every turn, with the launch env as fallback', async t => {
  const f = await fixture(t, { tokens: 410000 });
  let live = { HERMES_CC_COMPACT_THRESHOLD: '0.8', HERMES_CC_COMPACT_TARGET_RATIO: '0.5' };
  const aux = await summaryServer(t, ok(), (entry, res) => live ? json(res, 200, { ok: true, env: { ...COMPACT, ...live, UNRELATED_KEY: 'ignored' } }) : json(res, 500, { ok: false }));
  const launch = { ...aux.env, ...COMPACT };
  const first = await f.start('main settings say 0.8', launch).done;
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(host(first), [], '410K is below the live 800K trigger although the launch env says 0.4');
  assert.equal(aux.settingsRequests.length, 1);
  assert.equal(aux.settingsRequests[0].url, '/api/coding-agents/claude-context/settings');
  assert.equal(aux.settingsRequests[0].headers.authorization, 'Bearer fixture-summary-token');
  assert.deepEqual(aux.settingsRequests[0].body, { session_id: 'studio-fixture' });
  assert.ok((await f.calls()).every(c => !c.stage || c.envWindow === '1000000'));
  live = { HERMES_CC_COMPACT_THRESHOLD: '0.4' };
  const second = await f.start('main settings back to 0.4', launch).done;
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(host(second).map(e => e.status), ['started', 'completed']);
  live = null;
  await f.setScenario({ tokens: 410000 });
  const third = await f.start('settings endpoint down', { ...launch, HERMES_CC_COMPACT_THRESHOLD: '0.2' }).done;
  assert.equal(third.code, 0, third.stderr);
  assert.deepEqual(host(third).map(e => e.status), ['started', 'completed'], 'launch env (0.2) applies when the endpoint fails');
  assert.equal(aux.settingsRequests.length, 3);
});
