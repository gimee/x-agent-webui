import { lstat, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { parseArgs } from './args.mjs';
import { managedModel as capable, readModelOverrides } from './models.mjs';

// The host compacts at the configured trigger (default 400K) on user-turn boundaries.
// Native compaction only catches one very long tool loop; its window (default 600K,
// ~567K after native buffers) bounds cost/quality there instead of letting a single
// turn grow to ~1M.
const backstop = window => ({
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window),
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '100',
});

// hermes-v051:C Claude compression settings (Agent 管理 → Claude → 压缩设置) arrive as env.
// Names mirror CLAUDE_COMPRESSION_ENV in packages/server/src/modules/coding-agents/services/
// claude-compression-settings.ts (keep in sync; the server bundle cannot be imported here).
export const COMPACT_ENV = Object.freeze({
  enabled: 'HERMES_CC_COMPACT_ENABLED', threshold: 'HERMES_CC_COMPACT_THRESHOLD', targetRatio: 'HERMES_CC_COMPACT_TARGET_RATIO',
  protectLastN: 'HERMES_CC_COMPACT_PROTECT_LAST_N', protectFirstN: 'HERMES_CC_COMPACT_PROTECT_FIRST_N',
});
const WINDOW = 1000000;
const setting = (value, fallback, min, max, int = false) => {
  const n = typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, int ? Math.floor(n) : n)) : fallback;
};
/**
 * Missing or non-numeric values keep the v0.5.0 numbers (400K trigger, 80K retained, /context
 * skipped below 380K, 600K native backstop); out-of-range values clamp to the Hermes
 * getRunChatCompressionConfig ranges. The threshold is applied at most 0.8 of the 1M window.
 */
export function compactionSettings(env) {
  const trigger = Math.round(WINDOW * Math.min(0.8, setting(env[COMPACT_ENV.threshold], 0.4, 0.05, 0.95)));
  const retain = Math.min(Math.round(WINDOW * setting(env[COMPACT_ENV.targetRatio], 0.08, 0.01, 0.8)), Math.floor(trigger * 0.8));
  return {
    // enabled=0 stops threshold compaction only: manual /compact and the native backstop remain.
    enabled: !['0', 'false'].includes(String(env[COMPACT_ENV.enabled] ?? '').trim().toLowerCase()),
    trigger, retain, hardLimit: Math.floor(trigger * 0.9), cheapBelow: trigger - 20000,
    // hermes-v051:C protect_last_n may grow retention past the target, but only to half the trigger:
    // a 1MB paste otherwise filled the tail up to the 0.9 hard limit and the successor re-compacted.
    protectLimit: Math.max(retain, Math.floor(trigger * 0.5)),
    backstopWindow: Math.min(WINDOW, Math.max(600000, trigger + 200000)),
    protectLastN: setting(env[COMPACT_ENV.protectLastN], 20, 0, 500, true),
    protectFirstN: setting(env[COMPACT_ENV.protectFirstN], 3, 0, 100, true),
    summaryBudget: Math.min(16000, Math.max(4000, Math.floor(retain * 0.1))),
  };
}
/**
 * hermes-v051:A the summary endpoint/token and the settings are left out of every native child's env.
 * A same-user process can still read /proc/<wrapper pid>/environ: hiding it is defence in depth.
 */
export const nativeEnv = env => Object.fromEntries(Object.entries(env).filter(([key]) => !/^HERMES_CC_(?:SUMMARY|COMPACT)_/.test(key)));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const disabled = value => value !== undefined && !['', '0', 'false'].includes(String(value).toLowerCase());
async function readSettings(source, { optional = false, inline = false } = {}) {
  let text;
  try { text = inline && source.trimStart().startsWith('{') ? source : await readFile(source, 'utf8'); }
  catch (error) {
    if (optional && error.code === 'ENOENT') return {};
    throw new Error('Cannot read wrapper settings');
  }
  // JSON parser messages can quote credentials; never retain their message/cause.
  let settings;
  try { settings = JSON.parse(text); } catch { throw new Error('Invalid wrapper settings JSON'); }
  if (!object(settings) || (settings.env !== undefined && !object(settings.env))) throw new Error('Invalid wrapper settings object');
  return settings;
}

/**
 * Caller owns a pre-created 0700 directory and a fresh absolute file path.
 * managed:false returns the untouched inputs; forward parsed.raw with env.
 * managed:true requires BOTH returned parsed and env on every child, including
 * internalArgs forks. Keep the file through all children and unlink in finally.
 * Settings/credentials are never logged; only the private file goes on argv.
 * Model/disable lookup covers CLI, env, --settings and user settings.json, not
 * native project/local/enterprise merging. Callers with those extra sources
 * must resolve them first or stay unmanaged rather than guess their policy.
 */
export async function prepareManagedPolicy(parsed, env, privateConfigPath, { preCompactHook, backstopWindow = 600000 } = {}) {
  const overrides = readModelOverrides(env.HERMES_CC_STATE_DIR);
  const managedModel = model => capable(model, overrides);
  const unmanaged = reason => ({ managed: false, parsed, env, reason });
  const explicitModel = parsed.get('--model');
  if (explicitModel !== undefined && !managedModel(explicitModel)) return unmanaged('unsupported-model');
  // A fallback changes model mid-call; leave that native strategy untouched.
  if (parsed.get('--fallback-model') !== undefined) return unmanaged('native-fallback');
  const source = parsed.get('--settings');
  const settings = source === undefined ? {} : await readSettings(source, { inline: true });
  const sources = parsed.get('--setting-sources')?.split(',');
  const configDir = env.CLAUDE_CONFIG_DIR || (env.HOME ? join(env.HOME, '.claude') : undefined);
  const global = configDir && (!sources || sources.includes('user')) ? await readSettings(join(configDir, 'settings.json'), { optional: true }) : {};
  if (['DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT', 'CLAUDE_CODE_DISABLE_1M_CONTEXT'].some(key => [env, global.env, settings.env].some(layer => disabled(layer?.[key])))) {
    return unmanaged('compaction-disabled');
  }
  if (parsed.get('--autocompact') !== undefined && !['true', '1'].includes(parsed.get('--autocompact'))) return unmanaged('compaction-disabled');
  const effectiveEnv = { ...env, ...global.env, ...settings.env };
  const model = managedModel(explicitModel ?? effectiveEnv.ANTHROPIC_MODEL ?? settings.model ?? global.model);
  if (!model) return unmanaged('unsupported-model');
  const groups = parsed.groups.filter(g => !['--model', '--settings'].includes(g[0]));
  groups.push(['--model', model], ['--settings', privateConfigPath]);
  let parent;
  if (typeof privateConfigPath === 'string' && isAbsolute(privateConfigPath)) {
    try { parent = await lstat(dirname(privateConfigPath)); } catch { /* fail closed below */ }
  }
  // Supported containers run as root while recreate preserves volume UID 10000.
  // Keep the private-directory/no-symlink requirement; do not chown user state.
  if (!parent?.isDirectory() || (parent.mode & 0o077) !== 0 || (process.getuid && process.getuid() !== 0 && parent.uid !== process.getuid())) {
    throw new Error('Wrapper settings require an existing private owned directory and absolute path');
  }
  const native = backstop(backstopWindow);
  const overlay = { ...settings, env: { ...settings.env, ...native } };
  // Native fallback compaction gets the same memory-first instructions; the
  // hook adds to (never replaces) hooks already present in --settings.
  if (preCompactHook) {
    const hooks = object(settings.hooks) ? settings.hooks : {};
    const existing = Array.isArray(hooks.PreCompact) ? hooks.PreCompact : [];
    overlay.hooks = { ...hooks, PreCompact: [...existing, { hooks: [{ type: 'command', command: preCompactHook, timeout: 10 }] }] };
  }
  await writeFile(privateConfigPath, JSON.stringify(overlay), { flag: 'wx', mode: 0o600 });
  return { managed: true, parsed: parseArgs(groups.flat()), env: { ...env, ...native } };
}
