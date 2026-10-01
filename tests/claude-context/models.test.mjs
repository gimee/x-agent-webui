import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { managedModel, readModelOverrides } from '../../bin/claude-context/models.mjs';
import { prepareManagedPolicy } from '../../bin/claude-context/policy.mjs';
import { parseArgs } from '../../bin/claude-context/args.mjs';

const base = ['-p', '--resume', '11111111-1111-4111-8111-111111111111', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
async function dir(t) { const d = await mkdtemp(join(tmpdir(), 'wrapper-models-')); t.after(() => rm(d, { recursive: true, force: true })); return d; }

test('capability rule covers current and future Claude 5+ opus/sonnet/fable ids, not older or small models', () => {
  for (const [model, launched] of [['claude-opus-5-5', 'claude-opus-5-5[1m]'], ['claude-opus-5-6', 'claude-opus-5-6[1m]'], ['claude-opus-6', 'claude-opus-6[1m]'], ['claude-opus-10-1', 'claude-opus-10-1[1m]'], ['claude-sonnet-5-5', 'claude-sonnet-5-5[1m]'], ['claude-fable-5-1', 'claude-fable-5-1[1m]'], ['anything[1m]', 'anything[1m]']]) {
    assert.equal(managedModel(model), launched, model);
  }
  for (const model of ['claude-opus-4-8', 'claude-haiku-5-0', 'claude-haiku-4-5-20251001', 'claude-opus-5-5-preview', 'gpt-5', 'opus', '', undefined, null, 'claude-opus-5-5 [1m]']) {
    assert.equal(managedModel(model), null, String(model));
  }
});

test('operator overrides include a proxy alias or exclude a model without rebuilding; malformed files are ignored', async t => {
  const state = await dir(t);
  assert.deepEqual(readModelOverrides(state), { include: [], exclude: [] });
  await writeFile(join(state, 'models.json'), JSON.stringify({ include: ['my-proxy-opus'], exclude: ['claude-opus-5-6', 'x[1m]'] }));
  const o = readModelOverrides(state);
  assert.equal(managedModel('my-proxy-opus', o), 'my-proxy-opus[1m]');
  assert.equal(managedModel('claude-opus-5-6', o), null);
  assert.equal(managedModel('claude-opus-5-6[1m]', o), null);
  assert.equal(managedModel('x[1m]', o), null);
  assert.equal(managedModel('claude-opus-5-5', o), 'claude-opus-5-5[1m]');
  await writeFile(join(state, 'models.json'), '{not json');
  assert.deepEqual(readModelOverrides(state), { include: [], exclude: [] });
  assert.deepEqual(readModelOverrides(undefined), { include: [], exclude: [] });
});

test('policy honours models.json from the wrapper state root', async t => {
  const state = await dir(t);
  await writeFile(join(state, 'models.json'), JSON.stringify({ exclude: ['claude-opus-5-5'] }));
  const out = await prepareManagedPolicy(parseArgs([...base, '--model', 'claude-opus-5-5']), { HERMES_CC_STATE_DIR: state }, join(state, 'unused.json'));
  assert.equal(out.managed, false);
  assert.equal(out.reason, 'unsupported-model');
});

test('PreCompact hook is appended to existing --settings hooks in the private overlay only', async t => {
  const d = await dir(t);
  const settings = { hooks: { PreCompact: [{ hooks: [{ type: 'command', command: 'existing' }] }], Stop: [{ hooks: [{ type: 'command', command: 'stop' }] }] } };
  const privateFile = join(d, 'overlay.json');
  const out = await prepareManagedPolicy(parseArgs([...base, '--model', 'claude-opus-5-5', '--settings', JSON.stringify(settings)]), {}, privateFile, { preCompactHook: "'/node' '/hook.mjs'" });
  assert.equal(out.managed, true);
  const overlay = JSON.parse(await readFile(privateFile, 'utf8'));
  assert.deepEqual(overlay.hooks.Stop, settings.hooks.Stop);
  assert.deepEqual(overlay.hooks.PreCompact.map(g => g.hooks[0].command), ['existing', "'/node' '/hook.mjs'"]);
  const plain = join(d, 'plain.json');
  await prepareManagedPolicy(parseArgs([...base, '--model', 'claude-opus-5-5']), {}, plain);
  assert.equal(JSON.parse(await readFile(plain, 'utf8')).hooks, undefined);
});

test('PreCompact hook prints memory-first instructions with the transcript path, stays under the inline limit and never blocks', () => {
  const hook = fileURLToPath(new URL('../../bin/claude-context/precompact-hook.mjs', import.meta.url));
  const ok = spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'auto', transcript_path: '/root/.claude/projects/x/abc.jsonl' }), encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /verbatim/); assert.match(ok.stdout, /\/root\/\.claude\/projects\/x\/abc\.jsonl/);
  assert.ok(ok.stdout.length < 10000);
  for (const input of ['not json', '', JSON.stringify({ transcript_path: 'relative\nINJECT' })]) {
    const bad = spawnSync(process.execPath, [hook], { input, encoding: 'utf8' });
    assert.equal(bad.status, 0);
    assert.match(bad.stdout, /verbatim/); assert.doesNotMatch(bad.stdout, /INJECT/);
  }
});
