import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, access, symlink, chown } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, internalArgs } from '../../bin/claude-context/args.mjs';

const nativeId = '11111111-1111-4111-8111-111111111111';
const windowKey = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
const pctKey = 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE';
const base = ['-p', '--resume', nativeId, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wrapper-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, privateFile: join(dir, 'managed.json') };
}
test('root service can reuse private UID-10000 volumes after the supported Docker recreate', {skip:process.getuid?.()!==0}, async t=>{
 const {dir,privateFile}=await fixture(t);await chown(dir,10000,10000);
 const out=await prepare(parseArgs([...base,'--model','claude-opus-5-5']),{},privateFile);
 assert.equal(out.managed,true);assert.equal((await stat(dir)).uid,10000);
 assert.equal((await stat(dir)).mode&0o777,0o700);assert.equal((await stat(privateFile)).mode&0o777,0o600);
});

for (const mode of ['inline', 'file']) test(`preserves every ${mode} settings key and replaces early compression without exposing JSON in argv`, async t => {
  const { dir, privateFile } = await fixture(t);
  const settings = {
    model: 'claude-opus-5-5',
    env: { [pctKey]: '50', [windowKey]: '200000', ANTHROPIC_BASE_URL: 'https://scoped.invalid', ANTHROPIC_AUTH_TOKEN: 'fixture-scoped-token' },
    permissions: { allow: ['Read'], deny: ['Bash'] },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] },
    unknownFutureKey: { nested: ['preserve', 42] },
  };
  const text = JSON.stringify(settings, null, 2);
  const source = join(dir, 'original.json');
  await writeFile(source, text, { mode: 0o600 });
  const parsed = parseArgs([...base, `--settings=${mode === 'file' ? source : text}`, '--permission-mode', 'acceptEdits']);
  const env = { [pctKey]: '50', [windowKey]: '433000', ANTHROPIC_AUTH_TOKEN: 'fixture-parent-token' };
  const out = await prepare(parsed, env, privateFile);
  assert.equal(out.managed, true);
  assert.equal(out.parsed.get('--model'), 'claude-opus-5-5[1m]');
  assert.equal(out.parsed.get('--permission-mode'), 'acceptEdits');
  const overlay = JSON.parse(await readFile(privateFile, 'utf8'));
  assert.deepEqual(overlay, { ...settings, env: { ...settings.env, [windowKey]: '600000', [pctKey]: '100' } });
  assert.equal(await readFile(source, 'utf8'), text);
  assert.equal((await stat(source)).mode & 0o777, 0o600);
  assert.equal(out.env.ANTHROPIC_AUTH_TOKEN, 'fixture-parent-token');
  assert.equal(out.env[pctKey], '100');
  assert.doesNotMatch(out.parsed.groups.flat().join('\n'), /fixture-scoped-token|unknownFutureKey/);
  assert.equal(out.parsed.groups.filter(g => g[0] === '--settings').length, 1);
  assert.equal(parsed.get('--settings'), mode === 'file' ? source : text);
});

test('Claude 5+ opus/sonnet/fable families and explicitly suffixed models enter managed mode', async t => {
  for (const model of ['custom-proxy', 'opus', 'claude-opus-4-8', 'claude-haiku-5-0', 'claude-opus-5-5-preview', 'claude-opus-5-5 [1m]', '[1m]', '', undefined]) {
    const { dir } = await fixture(t);
    const privateFile = join(dir, 'must-not-be-created', 'managed.json');
    const parsed = parseArgs([...base, ...(model === undefined ? [] : [`--model=${model}`])]);
    const env = { [pctKey]: '50', ANTHROPIC_BASE_URL: 'https://original.invalid' };
    const out = await prepare(parsed, env, privateFile);
    assert.equal(out.managed, false, `must not invent 1m support for ${model}`);
    assert.strictEqual(out.parsed, parsed);
    assert.strictEqual(out.env, env);
    await assert.rejects(access(privateFile), { code: 'ENOENT' });
  }
  for (const model of ['claude-opus-5-5[1m]', 'explicit-proxy-model[1m]']) {
    const { privateFile } = await fixture(t);
    const out = await prepare(parseArgs([...base, '--model', model]), {}, privateFile);
    assert.equal(out.managed, true);
    assert.equal(out.parsed.get('--model'), model);
  }
  // A future model in the same family works without a release.
  for (const [model, launched] of [['claude-opus-5-6', 'claude-opus-5-6[1m]'], ['claude-opus-6', 'claude-opus-6[1m]'], ['claude-sonnet-5-1', 'claude-sonnet-5-1[1m]'], ['claude-fable-5-1', 'claude-fable-5-1[1m]']]) {
    const { privateFile } = await fixture(t);
    const out = await prepare(parseArgs([...base, '--model', model]), {}, privateFile);
    assert.equal(out.managed, true, model);
    assert.equal(out.parsed.get('--model'), launched);
  }
});

test('model selection respects CLI then effective settings env then parent env then settings model', async t => {
  const cases = [
    { settings: { model: 'unknown-proxy' }, env: {}, managed: false },
    { settings: { model: 'unknown-proxy' }, env: { ANTHROPIC_MODEL: 'claude-opus-5-5' }, managed: true },
    { settings: { model: 'claude-opus-5-5' }, env: { ANTHROPIC_MODEL: 'unknown-proxy' }, managed: false },
    { settings: { model: 'claude-opus-5-5', env: { ANTHROPIC_MODEL: 'unknown-proxy' } }, env: { ANTHROPIC_MODEL: 'claude-opus-5-5' }, managed: false },
    { settings: { model: 'unknown-proxy', env: { ANTHROPIC_MODEL: 'claude-opus-5-5' } }, env: { ANTHROPIC_MODEL: 'unknown-proxy' }, managed: true },
    { model: 'unknown-proxy', settings: { model: 'claude-opus-5-5' }, env: {}, managed: false },
    { model: 'claude-opus-5-5', settings: { model: 'unknown-proxy' }, env: { ANTHROPIC_MODEL: 'unknown-proxy' }, managed: true },
  ];
  for (const c of cases) {
    const { privateFile } = await fixture(t);
    const parsed = parseArgs([...base, '--settings', JSON.stringify(c.settings), ...(c.model ? ['--model', c.model] : [])]);
    const out = await prepare(parsed, c.env, privateFile);
    assert.equal(out.managed, c.managed, JSON.stringify(c));
    if (c.managed) assert.equal(out.parsed.get('--model'), 'claude-opus-5-5[1m]');
    else assert.strictEqual(out.parsed, parsed);
  }
});

test('parseArgs retains exact original argv for unmanaged pass-through', () => {
  const raw = [...base, '--model=custom-proxy', '--settings={"model":"custom-proxy"}', '--tools', 'Read'];
  const parsed = parseArgs(raw);
  assert.deepEqual(parsed.raw, raw);
  assert.notStrictEqual(parsed.raw, raw);
});

test('disabled compaction passes through without overriding user intent in either env source', async t => {
  for (const key of ['DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT', 'CLAUDE_CODE_DISABLE_1M_CONTEXT']) {
    for (const value of ['1', 'true']) {
      for (const layer of ['parent', 'settings']) {
        const { privateFile } = await fixture(t);
        const env = layer === 'parent' ? { [key]: value } : {};
        const settings = { env: layer === 'settings' ? { [key]: value } : { [key]: '0' } };
        const parsed = parseArgs([...base, '--model', 'claude-opus-5-5', '--settings', JSON.stringify(settings)]);
        const out = await prepare(parsed, env, privateFile);
        assert.equal(out.managed, false, `${layer}.${key}=${value}`);
        assert.strictEqual(out.env, env);
        assert.strictEqual(out.parsed, parsed);
        await assert.rejects(access(privateFile), { code: 'ENOENT' });
      }
    }
  }
  for (const value of ['0', 'false', '']) {
    const { privateFile } = await fixture(t);
    const out = await prepare(parseArgs([...base, '--model', 'claude-opus-5-5']), { DISABLE_AUTO_COMPACT: value, DISABLE_COMPACT: value }, privateFile);
    assert.equal(out.managed, true);
    assert.equal(out.env.DISABLE_COMPACT, value);
  }
});

test('explicit disabled autocompact or unverified fallback stays native', async t => {
  for (const flags of [['--autocompact', 'false'], ['--fallback-model', 'unknown-proxy']]) {
    const { privateFile } = await fixture(t);
    const parsed = parseArgs([...base, '--model', 'claude-opus-5-5', ...flags]);
    const out = await prepare(parsed, {}, privateFile);
    assert.equal(out.managed, false);
    assert.strictEqual(out.parsed, parsed);
    await assert.rejects(access(privateFile), { code: 'ENOENT' });
  }
});

test('global settings supply a model only when user settings are enabled, while scoped model stays authoritative', async t => {
  const { dir } = await fixture(t);
  const globalFile = join(dir, 'settings.json');
  const text = JSON.stringify({ model: 'claude-opus-5-5', env: { [pctKey]: '50', ANTHROPIC_AUTH_TOKEN: 'fixture-global-token' } });
  await writeFile(globalFile, text);
  const env = { CLAUDE_CONFIG_DIR: dir };
  const out = await prepare(parseArgs(base), env, join(dir, 'global-managed.json'));
  assert.equal(out.managed, true);
  assert.equal(out.parsed.get('--model'), 'claude-opus-5-5[1m]');
  assert.equal(await readFile(globalFile, 'utf8'), text);
  assert.equal(out.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.deepEqual(JSON.parse(await readFile(out.parsed.get('--settings'), 'utf8')), { env: { [windowKey]: '600000', [pctKey]: '100' } });
  for (const flags of [['--settings', '{"model":"custom-proxy"}'], ['--setting-sources', 'project,local'], ['--setting-sources', '']]) {
    const parsed = parseArgs([...base, ...flags]);
    const result = await prepare(parsed, env, join(dir, 'unused.json'));
    assert.equal(result.managed, false);
    assert.strictEqual(result.parsed, parsed);
  }
  await writeFile(globalFile, JSON.stringify({ model: 'claude-opus-5-5', env: { DISABLE_AUTO_COMPACT: '1' } }));
  const disabled = await prepare(parseArgs([...base, '--model', 'claude-opus-5-5']), env, join(dir, 'unused.json'));
  assert.equal(disabled.managed, false);
});

test('unknown explicit models pass through even when settings cannot be read', async t => {
  const { dir, privateFile } = await fixture(t);
  const parsed = parseArgs([...base, '--model', 'unknown-proxy', '--settings', join(dir, 'missing.json')]);
  const out = await prepare(parsed, {}, privateFile);
  assert.equal(out.managed, false);
  assert.strictEqual(out.parsed, parsed);
});

test('malformed settings fail clearly without exposing secrets and never create the overlay', async t => {
  for (const content of ['{"env":{"ANTHROPIC_API_KEY":"fixture-secret"}, bad}', 'null', '[]', '{"env":[]}', '{"env":"fixture-secret"}']) {
    const { dir, privateFile } = await fixture(t);
    const source = join(dir, 'invalid.json');
    await writeFile(source, content);
    const parsed = parseArgs([...base, '--model', 'claude-opus-5-5', '--settings', source]);
    await assert.rejects(prepare(parsed, {}, privateFile), error => {
      assert.match(error.message, /settings/i);
      assert.doesNotMatch(error.message, /fixture-secret|ANTHROPIC_API_KEY/);
      return true;
    });
    await assert.rejects(access(privateFile), { code: 'ENOENT' });
  }
});

test('overlay destination must be an existing private directory, not a symlink or public directory', async t => {
  const { dir } = await fixture(t);
  const parsed = parseArgs([...base, '--model', 'claude-opus-5-5']);
  const publicDir = join(dir, 'public');
  await mkdir(publicDir, { mode: 0o755 });
  const alias = join(dir, 'alias');
  await symlink(dir, alias);
  for (const target of [join(publicDir, 'managed.json'), join(alias, 'linked.json'), join(dir, 'missing', 'managed.json')]) {
    await assert.rejects(prepare(parsed, {}, target), /private.*directory/i);
    await assert.rejects(access(target), { code: 'ENOENT' });
  }
});

test('exclusive overlay creation never overwrites original files or follows destination symlinks', async t => {
  const { dir, privateFile } = await fixture(t);
  const original = '{"model":"claude-opus-5-5","env":{"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE":"50"}}';
  await writeFile(privateFile, original);
  const parsed = parseArgs([...base, '--settings', privateFile]);
  await assert.rejects(prepare(parsed, {}, privateFile));
  assert.equal(await readFile(privateFile, 'utf8'), original);
  const alias = join(dir, 'alias.json');
  await symlink(privateFile, alias);
  await assert.rejects(prepare(parsed, {}, alias));
  assert.equal(await readFile(privateFile, 'utf8'), original);
});

async function prepare(...args) {
  const { prepareManagedPolicy } = await import('../../bin/claude-context/policy.mjs');
  return prepareManagedPolicy(...args);
}

test('verified model gets 1m and finite native backstop in child env and private settings', async t => {
  const { privateFile } = await fixture(t);
  const parsed = parseArgs([...base, '--model', 'claude-opus-5-5', '--include-partial-messages']);
  const env = { [windowKey]: '200000', [pctKey]: '50', ANTHROPIC_BASE_URL: 'https://fixture.invalid', ANTHROPIC_API_KEY: 'test-only-not-a-real-secret' };
  const originalGroups = structuredClone(parsed.groups);
  const out = await prepare(parsed, env, privateFile);
  assert.equal(out.managed, true);
  assert.equal(out.parsed.get('--model'), 'claude-opus-5-5[1m]');
  assert.equal(out.parsed.get('--settings'), privateFile);
  assert.equal(out.env[windowKey], '600000');
  assert.equal(out.env[pctKey], '100');
  assert.equal(out.env.ANTHROPIC_BASE_URL, env.ANTHROPIC_BASE_URL);
  assert.equal(out.env.ANTHROPIC_API_KEY, env.ANTHROPIC_API_KEY);
  assert.equal(out.parsed.inputFormat, 'stream-json');
  assert.ok(out.parsed.base.includes('--include-partial-messages'));
  assert.deepEqual(parsed.groups, originalGroups);
  assert.equal(env[pctKey], '50');
  assert.equal((await stat(privateFile)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(privateFile, 'utf8')), { env: { [windowKey]: '600000', [pctKey]: '100' } });
  const internal = internalArgs(out.parsed, nativeId);
  assert.equal(internal[internal.indexOf('--model') + 1], 'claude-opus-5-5[1m]');
  assert.equal(internal[internal.indexOf('--settings') + 1], privateFile);
  assert.equal(internal[internal.indexOf('--input-format') + 1], 'text');
});
