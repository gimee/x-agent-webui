import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../bin/claude-context/args.mjs';
// hermes-v051:C Claude compression settings → wrapper numbers.
import { COMPACT_ENV, compactionSettings, nativeEnv, prepareManagedPolicy } from '../../bin/claude-context/policy.mjs';

const env = values => Object.fromEntries(Object.entries(values).map(([k, v]) => [COMPACT_ENV[k], v]));
const v050 = { enabled: true, trigger: 400000, retain: 80000, cheapBelow: 380000, backstopWindow: 600000 };
const pick = (s, keys) => Object.fromEntries(keys.map(k => [k, s[k]]));

// hermes-v051:R1-02 defaults match v0.5.0 in trigger, retention target, /context skip and native backstop, and
// the Claude fork keeps its v0.5.0 summary prompt (the 8K budget belongs to the new auxiliary path). New are
// the protect-last-20 / protect-first-3 floors and the hard limit 200K → trigger × 0.9.
test('missing, invalid or default settings keep v0.5.0 trigger, retention target, cheap check and backstop; add protect 20/3 and hard limit trigger × 0.9', () => {
  const defaults = env({ enabled: '1', threshold: '0.4', targetRatio: '0.08', protectLastN: '20', protectFirstN: '3' });
  const invalid = env({ enabled: 'maybe', threshold: 'abc', targetRatio: '', protectLastN: 'x', protectFirstN: 'NaN' });
  for (const input of [{}, defaults, invalid]) {
    const s = compactionSettings(input);
    assert.deepEqual(pick(s, Object.keys(v050)), v050, JSON.stringify(input));
    assert.equal(s.hardLimit, 360000);
    assert.equal(s.protectLimit, 200000);
    assert.equal(s.protectLastN, 20);
    assert.equal(s.protectFirstN, 3);
    assert.equal(s.summaryBudget, 8000);
  }
});

test('following main settings 0.8/0.5 moves every derived number', () => {
  const s = compactionSettings(env({ threshold: '0.8', targetRatio: '0.5' }));
  assert.deepEqual(pick(s, ['trigger', 'retain', 'hardLimit', 'cheapBelow', 'backstopWindow', 'summaryBudget']),
    { trigger: 800000, retain: 500000, hardLimit: 720000, cheapBelow: 780000, backstopWindow: 1000000, summaryBudget: 16000 });
  assert.equal(s.protectLimit, 500000);
});

test('threshold is applied at most 0.8; out-of-range values clamp to the Hermes settings ranges', () => {
  assert.equal(compactionSettings(env({ threshold: '0.95' })).trigger, 800000);
  assert.equal(compactionSettings(env({ threshold: '0.95' })).backstopWindow, 1000000);
  const low = compactionSettings(env({ threshold: '0.01', targetRatio: '0.9' }));
  assert.equal(low.trigger, 50000);
  assert.equal(low.retain, 40000, 'retention never exceeds 80% of the trigger');
  assert.equal(low.backstopWindow, 600000);
  assert.equal(low.summaryBudget, 4000);
  assert.equal(compactionSettings(env({ threshold: '0.6', targetRatio: '0.2' })).retain, 200000);
  assert.equal(compactionSettings(env({ protectLastN: '9999', protectFirstN: '-4' })).protectLastN, 500);
  assert.equal(compactionSettings(env({ protectFirstN: '-4' })).protectFirstN, 0);
  assert.equal(compactionSettings(env({ protectLastN: '2.7' })).protectLastN, 2);
});

test('enabled=0/false only turns off threshold compaction', () => {
  for (const value of ['0', 'false', 'FALSE']) assert.equal(compactionSettings(env({ enabled: value })).enabled, false);
  for (const value of ['1', 'true', undefined, 'garbage']) assert.equal(compactionSettings(env({ enabled: value })).enabled, true);
  const off = compactionSettings(env({ enabled: '0', threshold: '0.8' }));
  assert.equal(off.backstopWindow, 1000000, 'the native backstop cannot be switched off');
});

test('env names are the frozen server contract in claude-compression-settings.ts', async () => {
  const ts = await readFile(new URL('../../packages/server/src/modules/coding-agents/services/claude-compression-settings.ts', import.meta.url), 'utf8');
  assert.equal(Object.keys(COMPACT_ENV).length, 5);
  for (const [key, name] of Object.entries(COMPACT_ENV)) assert.match(ts, new RegExp(`\\b${key}: '${name}'`), key);
});

test('native child env drops the summary endpoint, token and every compaction setting, nothing else', () => {
  const parent = { PATH: '/bin', HERMES_CC_STATE_DIR: '/state', HERMES_CC_SUMMARY_URL: 'http://127.0.0.1:1/x', HERMES_CC_SUMMARY_TOKEN: 'fixture-token', ...env({ enabled: '1', threshold: '0.4', targetRatio: '0.08', protectLastN: '20', protectFirstN: '3' }), HERMES_CC_COMPACT_FUTURE: 'x' };
  assert.deepEqual(nativeEnv(parent), { PATH: '/bin', HERMES_CC_STATE_DIR: '/state' });
  assert.equal(parent.HERMES_CC_SUMMARY_TOKEN, 'fixture-token', 'the parent env is not mutated');
});

test('policy overlay uses the derived native backstop window', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wrapper-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const parsed = parseArgs(['-p', '--resume', '11111111-1111-4111-8111-111111111111', '--output-format', 'stream-json', '--verbose', '--model', 'claude-opus-5-5']);
  const out = await prepareManagedPolicy(parsed, {}, join(dir, 'managed.json'), { backstopWindow: 1000000 });
  assert.equal(out.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1000000');
  assert.equal(JSON.parse(await readFile(join(dir, 'managed.json'), 'utf8')).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1000000');
});
