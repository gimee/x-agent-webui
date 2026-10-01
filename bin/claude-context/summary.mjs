import { request } from 'node:http';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

// hermes-v051:A client for the WebUI's internal Claude-context endpoints (summary with
// 「模型 → 辅助模型 → 压缩」, live compression settings). Every unavailability,
// transport/HTTP error, timeout or invalid answer resolves {reason}: the caller keeps its
// fallback (Claude fork / launch env) in the same turn; only user cancellation rejects.
// Nothing is ever sent off the loopback interface.
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);
// hermes-v051:R1-06 a stalled settings endpoint may delay a turn by at most 2s.
const HEADER_MS = 30000, SETTINGS_MS = 2000, MAX_RESPONSE = 2 * 1024 * 1024, MAX_SUMMARY = 256 * 1024;
const code = value => typeof value === 'string' && /^[a-z0-9_]{1,40}$/.test(value) ? value : 'failed';
const label = value => typeof value === 'string' ? value.slice(0, 120) : null;

function endpoint(env, name) {
  let url;
  try { url = new URL(name, env.HERMES_CC_SUMMARY_URL); } catch { return null; }
  return url.protocol === 'http:' && LOOPBACK.has(url.hostname) && env.HERMES_CC_SUMMARY_TOKEN ? url : null;
}

/** POST JSON; resolves {answer} for a 200 JSON body, else {reason}. The server may extend the wait by announcing its deadline. */
function post(url, token, body, { signal, wait }) {
  if (signal?.aborted) return Promise.reject(new Error('Cancelled'));
  const data = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    let timer, settled = false, req;
    const finish = (value, error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); req?.destroy();
      error ? reject(error) : resolve(value);
    };
    const arm = ms => { clearTimeout(timer); timer = setTimeout(() => finish({ reason: 'aux_timeout' }), ms); };
    const abort = () => finish(null, new Error('Cancelled'));
    // agent:false: a fresh direct connection, never an env-configured proxy.
    req = request(url, { method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length, authorization: `Bearer ${token}` } }, res => {
      // Once the job is accepted the server announces its own deadline (the auxiliary timeout).
      const deadline = Number(res.headers['x-hermes-summary-deadline-ms']);
      if (Number.isSafeInteger(deadline) && deadline > 0) arm(deadline);
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > MAX_RESPONSE) finish({ reason: 'aux_invalid' }); else chunks.push(chunk); });
      res.on('error', () => finish({ reason: 'aux_error' }));
      res.on('end', () => {
        if (res.statusCode !== 200) return finish({ reason: `aux_http_${res.statusCode}` });
        try { finish({ answer: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch { finish({ reason: 'aux_invalid' }); }
      });
    });
    req.on('error', () => finish({ reason: 'aux_error' }));
    signal?.addEventListener('abort', abort, { once: true });
    arm(wait);
    req.end(data);
  });
}

export async function auxSummary({ env, stateDir, body, signal }) {
  if (signal?.aborted) throw new Error('Cancelled');
  // Operator switch: an empty <state root>/NATIVE_SUMMARY sends every summary back to Claude.
  try { await lstat(join(stateDir, 'NATIVE_SUMMARY')); return { reason: 'native_summary' }; }
  catch (error) { if (error.code !== 'ENOENT') return { reason: 'native_summary' }; }
  const url = endpoint(env, 'summary');
  if (!url) return { reason: 'aux_unconfigured' };
  const { answer, reason } = await post(url, env.HERMES_CC_SUMMARY_TOKEN, body, { signal, wait: HEADER_MS });
  if (reason) return { reason };
  if (answer?.ok !== true) return { reason: `aux_${code(answer?.reason)}` };
  const summary = typeof answer.summary === 'string' ? answer.summary.trim() : '';
  if (!summary || Buffer.byteLength(summary) > MAX_SUMMARY) return { reason: 'aux_invalid' };
  return { summary, model: label(answer.model), provider: label(answer.provider), seconds: Number(answer.seconds) || null, chunks: Number(answer.chunks) || null };
}

/**
 * hermes-v051:C effective compression settings for this turn. A Studio run (and its launch env)
 * outlives turns, so a main-settings change reaches the next message only by asking the WebUI.
 * Returns only the compaction env names; {} keeps the launch env.
 */
export async function liveSettings({ env, names, signal }) {
  const url = endpoint(env, 'settings');
  if (!url) return {};
  const { answer } = await post(url, env.HERMES_CC_SUMMARY_TOKEN, { session_id: env.HERMES_STUDIO_SESSION_ID }, { signal, wait: SETTINGS_MS });
  if (answer?.ok !== true || !answer.env || typeof answer.env !== 'object') return {};
  return Object.fromEntries(names.filter(name => typeof answer.env[name] === 'string').map(name => [name, answer.env[name]]));
}
