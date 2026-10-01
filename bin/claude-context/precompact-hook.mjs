#!/usr/bin/env node
// Native PreCompact hook for the rare mid-tool-loop fallback compaction.
// stdout becomes extra summary instructions (native compaction's contract).
// Must never block compaction: every path exits 0, and any error just means
// the native default summary is used. Output stays far below the 10,000
// character limit where Claude Code externalizes hook output to a file.
const chunks = [];
let transcript = '';
try {
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof input?.transcript_path === 'string' && /^\/[^\n]*$/.test(input.transcript_path)) transcript = input.transcript_path;
} catch { /* fall through with generic instructions */ }
process.stdout.write([
  'Memory-first compaction requirements (the user repeatedly loses context after short summaries):',
  '- Write a detailed, structured summary; do not trade detail for brevity. Aim for 8,000-15,000 tokens when the history supports it.',
  '- Quote EVERY genuine user message verbatim in chronological order (skip tool results and system notifications). For very long pasted content keep the first and last parts and mark the omission.',
  '- For each user requirement, constraint, correction or decision, state whether it is done, in progress, superseded or pending.',
  '- Preserve exact file paths, commands, identifiers, versions, numbers, error messages and the reasons behind decisions.',
  '- Record failed approaches and pitfalls so they are not repeated.',
  '- End with: current work in progress, the immediate next step, and open questions.',
  transcript ? `- Add a final line: "Full pre-compaction transcript (read-only JSONL, search it with Grep/Read when a detail is missing): ${transcript}"` : '',
  'Write the summary in the language the user writes in.',
].filter(Boolean).join('\n') + '\n');
