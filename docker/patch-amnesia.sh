#!/usr/bin/env bash
# Hermes WebUI Claude Code / Codex native-session continuity patch.
#
# Commands:
#   bash patch-amnesia.sh check
#   bash patch-amnesia.sh apply
#   bash patch-amnesia.sh restore
#
# HERMES_INDEX_JS can point to a bundle copy for testing. The default target is
# /app/dist/server/index.js. Applying the patch does not restart Hermes WebUI.

set -euo pipefail

ACTION="${1:-}"
TARGET="${HERMES_INDEX_JS:-/app/dist/server/index.js}"

case "$ACTION" in
  check|apply|restore) ;;
  *)
    echo "Usage: $0 check|apply|restore" >&2
    exit 2
    ;;
esac

command -v node >/dev/null 2>&1 || {
  echo "node is required" >&2
  exit 1
}

node - "$ACTION" "$TARGET" <<'NODE'
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const [action, targetArg] = process.argv.slice(2);
const target = path.resolve(targetArg);
const manifestPath = `${target}.amnesia-patch.json`;
const markerA = 'hermes-amnesia-preserve-native-session-id';
const markerB = 'hermes-amnesia-relax-native-resume';

function fail(message) {
  throw new Error(message);
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function countToken(source, token) {
  return source.split(token).length - 1;
}

function syntaxCheck(file) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    fail(`node --check failed for ${file}:\n${result.stderr || result.stdout}`);
  }
}

function findMatches(source, regex, predicate = () => true) {
  const matches = [];
  regex.lastIndex = 0;
  for (let match; (match = regex.exec(source)) !== null;) {
    if (predicate(match)) matches.push(match);
    if (match[0].length === 0) regex.lastIndex += 1;
  }
  return matches;
}

const clearNativeIdPattern = /([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)&&\(\2\.model!==([A-Za-z_$][\w$]*)\|\|\2\.provider!==([A-Za-z_$][\w$]*)(?:\|\|([A-Za-z_$][\w$]*)&&\2\.api_mode!==\5)?\)&&\(([A-Za-z_$][\w$]*)\.agent_native_session_id=""\)/g;

// The optional wrapper covers WebUI v0.7.1+, where global coding-agent mode bypasses
// provider/model matching: (mode==="global"||<the original scoped checks>).
// Captures: 1 wrapper-open, 2 stored session, 3 launch input, 4 wrapper-close, 5 suffix.
const strictResumePattern = /&&(\([A-Za-z_$][\w$]*==="global"\|\|)?String\(([A-Za-z_$][\w$]*)\.provider\|\|""\)\.trim\(\)===String\(([A-Za-z_$][\w$]*)\.provider\|\|""\)\.trim\(\)&&String\(\2\.model\|\|""\)\.trim\(\)===String\(\3\.model\|\|""\)\.trim\(\)(?:&&\(!String\(\2\.api_mode\|\|""\)\.trim\(\)\|\|String\(\2\.api_mode\|\|""\)\.trim\(\)===String\(\3\.apiMode\|\|""\)\.trim\(\)\))?(\))?(:!1\)&&\2\?\.agent_native_session_id\|\|"")/g;

function analyze(source) {
  const markerACount = countToken(source, markerA);
  const markerBCount = countToken(source, markerB);

  if (markerACount === 1 && markerBCount === 1) {
    return { state: 'patched' };
  }
  if (markerACount !== 0 || markerBCount !== 0) {
    fail(`partial or duplicate patch markers: A=${markerACount}, B=${markerBCount}`);
  }

  const clearMatches = findMatches(source, clearNativeIdPattern);
  const resumeMatches = findMatches(source, strictResumePattern, (match) => {
    // The optional v0.7.1+ wrapper must be present as a balanced pair. Reject a
    // coincidental partial match instead of silently deleting unrelated logic.
    if (Boolean(match[1]) !== Boolean(match[4])) return false;
    // Hermes Agent v0.20.2 新增第三个 coding agent(Pi) 之后，上游把
    // `x==="codex"?"codex":"claude"` 这个二选一三元抽成了函数(压缩后形如 ohI(I))，
    // 该字面量永久消失 → predicate 恒 false → resume=0，补丁被自己的守门条件挡在门外
    // （正则裸匹配其实仍精确命中 1 处）。改用同函数开头 sessionSource 归一化里的
    // :"coding_agent"，它表达的正是「这段属于 coding agent 会话恢复判定」，
    // 不随 agent 种类增减而变。窗口 600→1200：该字面量实测在匹配点前约 520 字符，600 太贴边。
    const before = source.slice(Math.max(0, match.index - 1200), match.index);
    return before.includes(':"coding_agent"') &&
      before.includes('.agent===');
  });

  if (clearMatches.length !== 1 || resumeMatches.length !== 1) {
    fail(`semantic anchors are not unique: clear=${clearMatches.length}, resume=${resumeMatches.length}`);
  }

  return { state: 'patchable' };
}

function patchSource(source) {
  analyze(source);

  const withPatchA = source.replace(
    clearNativeIdPattern,
    (whole, codingSession, storedSession, model, provider, apiMode, update) => {
      const apiClause = apiMode
        ? `||${apiMode}&&${storedSession}.api_mode!==${apiMode}`
        : '';
      return `${codingSession}&&${storedSession}&&(${storedSession}.model!==${model}||${storedSession}.provider!==${provider}${apiClause})&&/*${markerA}*/!1&&(${update}.agent_native_session_id="")`;
    },
  );

  const patched = withPatchA.replace(
    strictResumePattern,
    (whole, wrapperOpen, storedSession, launch, wrapperClose, suffix) =>
      `&&/*${markerB}*/!0${suffix}`,
  );

  if (countToken(patched, markerA) !== 1 || countToken(patched, markerB) !== 1) {
    fail('patch markers were not written exactly once');
  }
  return patched;
}

function writeAtomic(file, content, mode) {
  const temp = `${file}.amnesia-tmp-${process.pid}`;
  try {
    fs.writeFileSync(temp, content, { mode });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }
}

function applyPatch() {
  if (!fs.existsSync(target)) fail(`target does not exist: ${target}`);
  const source = fs.readFileSync(target, 'utf8');
  const analysis = analyze(source);
  if (analysis.state === 'patched') {
    syntaxCheck(target);
    console.log(`Patch already applied: ${target}`);
    return;
  }
  // A manifest left over from a previous bundle is expected whenever the server
  // bundle gets rebuilt or restored in place: the old manifest describes a file
  // that no longer exists.  Refusing to patch here used to leave the WebUI
  // running unpatched (entrypoint only warns), i.e. amnesia silently returns —
  // far worse than dropping a manifest we are about to supersede anyway.
  if (fs.existsSync(manifestPath)) {
    const stale = `${manifestPath}.stale-${Date.now()}`;
    fs.renameSync(manifestPath, stale);
    console.log(`Superseded stale manifest -> ${stale}`);
  }

  const stat = fs.statSync(target);
  const originalHash = sha256File(target);
  const backup = `${target}.bak-amnesia.${originalHash}`;
  if (fs.existsSync(backup)) {
    if (sha256File(backup) !== originalHash) fail(`backup hash mismatch: ${backup}`);
  } else {
    fs.copyFileSync(target, backup);
    fs.chmodSync(backup, stat.mode);
  }

  const patched = patchSource(source);
  const temp = `${target}.amnesia-check-${process.pid}.js`;
  let targetChanged = false;
  try {
    fs.writeFileSync(temp, patched, { mode: stat.mode });
    syntaxCheck(temp);
    fs.renameSync(temp, target);
    targetChanged = true;
    const patchedHash = sha256File(target);
    const manifest = {
      format: 1,
      target,
      backup,
      originalSha256: originalHash,
      patchedSha256: patchedHash,
      createdAt: new Date().toISOString(),
    };
    writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    console.log(`Patch applied to ${target}`);
    console.log(`Backup: ${backup}`);
  } catch (error) {
    if (targetChanged || !fs.existsSync(target)) {
      fs.copyFileSync(backup, target);
      fs.chmodSync(target, stat.mode);
    }
    fs.rmSync(manifestPath, { force: true });
    throw error;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function restorePatch() {
  if (!fs.existsSync(target)) fail(`target does not exist: ${target}`);
  const source = fs.readFileSync(target, 'utf8');
  const markerACount = countToken(source, markerA);
  const markerBCount = countToken(source, markerB);
  if (markerACount === 0 && markerBCount === 0 && !fs.existsSync(manifestPath)) {
    console.log(`Target is not patched: ${target}`);
    return;
  }
  if (markerACount !== 1 || markerBCount !== 1) {
    fail(`cannot restore partial or duplicate patch markers: A=${markerACount}, B=${markerBCount}`);
  }
  if (!fs.existsSync(manifestPath)) fail(`manifest does not exist: ${manifestPath}`);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (path.resolve(manifest.target) !== target) fail('manifest target does not match');
  if (!fs.existsSync(manifest.backup)) fail(`backup does not exist: ${manifest.backup}`);
  if (sha256File(target) !== manifest.patchedSha256) {
    fail('current target differs from the file produced by this patch; refusing restore');
  }
  if (sha256File(manifest.backup) !== manifest.originalSha256) {
    fail('backup differs from the original SHA-256; refusing restore');
  }

  const stat = fs.statSync(target);
  const original = fs.readFileSync(manifest.backup);
  const temp = `${target}.amnesia-restore-${process.pid}.js`;
  try {
    fs.writeFileSync(temp, original, { mode: stat.mode });
    syntaxCheck(temp);
    fs.renameSync(temp, target);
    if (sha256File(target) !== manifest.originalSha256) fail('restored target hash mismatch');
    fs.rmSync(manifestPath, { force: true });
    console.log(`Patch restored from ${manifest.backup}`);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

try {
  if (action === 'check') {
    if (!fs.existsSync(target)) fail(`target does not exist: ${target}`);
    const result = analyze(fs.readFileSync(target, 'utf8'));
    syntaxCheck(target);
    console.log(`${result.state}: ${target}`);
  } else if (action === 'apply') {
    applyPatch();
  } else {
    restorePatch();
  }
} catch (error) {
  console.error(`patch-amnesia: ${error.message}`);
  process.exit(1);
}
NODE
