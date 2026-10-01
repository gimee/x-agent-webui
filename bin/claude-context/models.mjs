import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Capability rule, not a name list: every Claude 5+ opus/sonnet/fable id is a
// 1M-context model, so a future claude-opus-5-6 is managed without a release.
// Keep in sync with claude-context-launch.ts (server bundle cannot import bin/).
const family = /^claude-(?:opus|sonnet|fable)-(\d+)(?:-\d+)?$/;
const suffixed = /^[^\s\[\]]+\[1m\]$/;

// <stateRoot>/models.json {"include":[...],"exclude":[...]} lets an operator
// add a proxy alias or back one out without rebuilding. Unreadable or malformed
// overrides are ignored: a typo there must never break every Claude chat.
export function readModelOverrides(stateRoot) {
  if (!stateRoot) return { include: [], exclude: [] };
  try {
    const value = JSON.parse(readFileSync(join(stateRoot, 'models.json'), 'utf8'));
    const list = key => Array.isArray(value?.[key]) ? value[key].filter(x => typeof x === 'string') : [];
    return { include: list('include'), exclude: list('exclude') };
  } catch { return { include: [], exclude: [] }; }
}

/** Returns the model id to launch (with [1m]) or null when it stays native. */
export function managedModel(model, overrides = { include: [], exclude: [] }) {
  if (typeof model !== 'string' || !model) return null;
  const bare = model.endsWith('[1m]') ? model.slice(0, -4) : model;
  if (overrides.exclude.includes(model) || overrides.exclude.includes(bare)) return null;
  if (suffixed.test(model)) return model;
  const match = family.exec(model);
  if ((match && Number(match[1]) >= 5) || overrides.include.includes(model)) return `${model}[1m]`;
  return null;
}
