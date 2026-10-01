// hermes-v051:T0/T2 R3-15 — integration with the REAL Hermes title code (/opt/hermes) against a fake local relay:
// T0 400 -> floor -> retry, the floor memo on the next call, T2 derived -> llm on a real SessionDB, and the /skill
// instruction reaching the wire (R3-02). Temp HERMES_HOME with a fake key; nothing touches the real Hermes home.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const HERMES_ROOT = '/opt/hermes'
const HERMES_PYTHON = '/opt/hermes/.venv/bin/python'
const available = existsSync(`${HERMES_ROOT}/agent/title_generator.py`) && existsSync(HERMES_PYTHON)

function runHermesPython(script: string): any {
  // Clean env: no provider keys from the host leak in; no bytecode written into the source tree.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: process.env.HOME || '/tmp',
    PYTHONDONTWRITEBYTECODE: '1',
  }
  try {
    const out = execFileSync(HERMES_PYTHON, ['-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: 'pipe',
      env,
      timeout: 120_000,
    })
    const line = out.trim().split('\n').filter(l => l.startsWith('RESULT ')).pop()
    if (!line) throw new Error(`no RESULT line:\n${out}`)
    return JSON.parse(line.slice('RESULT '.length))
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    throw new Error([
      err.message || 'Hermes integration script failed',
      err.stdout ? `stdout:\n${err.stdout}` : '',
      err.stderr ? `stderr:\n${String(err.stderr).slice(-4000)}` : '',
    ].filter(Boolean).join('\n\n'))
  }
}

const harness = String.raw`
import json
import os
import shutil
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

requests = []
state = {"mode": "reasoning", "n": 0}

class Relay(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        state["n"] += 1
        user = next((m.get("content") for m in body.get("messages", []) if m.get("role") == "user"), "")
        requests.append({"reasoning_effort": body.get("reasoning_effort"), "model": body.get("model"), "user": user})
        thinking_off = str(body.get("reasoning_effort", "")).lower() == "none"
        if state["mode"] == "always400" or (state["mode"] == "reasoning" and thinking_off):
            payload, status = {"error": {"message": "Upstream error: 400", "type": "invalid_request_error"}}, 400
        else:
            payload, status = {
                "id": "x", "object": "chat.completion", "created": 0, "model": body.get("model"),
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": json.dumps({"title": "集成标题" + str(state["n"])}, ensure_ascii=False)}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            }, 200
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

relay = ThreadingHTTPServer(("127.0.0.1", 0), Relay)
threading.Thread(target=relay.serve_forever, daemon=True).start()
port = relay.server_address[1]

home = Path(tempfile.mkdtemp(prefix="v051-r3-15-home-"))
(home / "config.yaml").write_text(f"""
model:
  default: m1
  provider: custom:fake
custom_providers:
  - name: fake
    base_url: http://127.0.0.1:{port}/v1
    api_key: fake-test-key
    model: m1
    api_mode: chat_completions
auxiliary:
  title_generation:
    provider: custom:fake
    model: m1
    timeout: 10
""", encoding="utf-8")
os.environ["HERMES_HOME"] = str(home)
sys.path.insert(0, "/opt/hermes")
sys.path.insert(0, str(Path("packages/server/src/modules/hermes/services/bridge/python").resolve()))
import logging
logging.basicConfig(level=logging.CRITICAL)

import bridge_title
from agent import auxiliary_reasoning_floor as floor

def done(result):
    relay.shutdown()
    shutil.rmtree(home, ignore_errors=True)
    print("RESULT " + json.dumps(result, ensure_ascii=False))
`

describe.skipIf(!available)('hermes-v051:T0/T2 R3-15 real Hermes integration', () => {
  it('T0: opaque 400 on reasoning_effort none -> floor -> retry at low; the next call starts at the floor', () => {
    const result = runHermesPython(`${harness}
title, reason = bridge_title.generate_title_with_reasoning_floor(bridge_title.title_input_text("帮我把 README 的错别字修一下"))
first_wire = [r["reasoning_effort"] for r in requests]
floored = sorted(list(k) for k in floor._FLOORED_ROUTES)
requests.clear()
title2, reason2 = bridge_title.generate_title_with_reasoning_floor(bridge_title.title_input_text("另一个会话的第一句话"))
done({"title": title, "reason": reason, "first_wire": first_wire, "floored": floored,
      "title2": title2, "second_wire": [r["reasoning_effort"] for r in requests]})
`)
    expect(result.title).toBe('集成标题2')
    expect(result.reason).toBeNull()
    expect(result.first_wire).toEqual(['none', 'low'])
    expect(result.floored).toEqual([[expect.stringMatching(/^127\.0\.0\.1:\d+$/), 'm1']])
    expect(result.title2).toBe('集成标题3')
    expect(result.second_wire).toEqual(['low'])
  }, 120_000)

  it('T0: a relay that keeps rejecting leaves no floor behind', () => {
    const result = runHermesPython(`${harness}
state["mode"] = "always400"
title, reason = bridge_title.generate_title_with_reasoning_floor(bridge_title.title_input_text("你好"))
done({"title": title, "reason": reason, "requests": len(requests), "floored": sorted(list(k) for k in floor._FLOORED_ROUTES)})
`)
    // One thinking-off request plus one floored retry, then the unproven floor is withdrawn.
    expect(result).toEqual({ title: null, reason: 'http_400', requests: 2, floored: [] })
  }, 120_000)

  it('T2: a derived placeholder on a real SessionDB is upgraded to an llm title', () => {
    const result = runHermesPython(`${harness}
from hermes_state import SessionDB
db = SessionDB(db_path=home / "state.db")
db.create_session("sess-int", source="cli", model="m1")
db.set_auto_title("sess-int", "帮我修一下构建失败的问题", source="derived")
events = []
persisted = bridge_title.fallback_title_after_turn(
    db, "sess-int", bridge_title.title_input_text("帮我修一下构建失败的问题"), 1,
    wait_timeout=0.5, on_title=events.append)
done({"persisted": persisted, "events": events,
      "db": [db.get_session_title("sess-int"), db.get_session_title_source("sess-int")],
      "wire": [r["reasoning_effort"] for r in requests]})
`)
    expect(result.persisted).toBe('集成标题2')
    expect(result.events).toEqual(['集成标题2'])
    expect(result.db).toEqual(['集成标题2', 'llm'])
    expect(result.wire).toEqual(['none', 'low'])
  }, 120_000)

  it('T2 R3-02: a /skill turn reaches the wire as "/skill — instruction" with the language hint', () => {
    const result = runHermesPython(`${harness}
from agent.skill_commands import describe_skill_invocation
marker = "The user has provided the following instruction alongside the skill invocation: "
skill_turn = ('[IMPORTANT: The user has invoked the "work" skill, indicating they want you to follow its instructions. '
              'The full skill content is loaded below.]\\n\\n' + ("这是技能正文的一行说明。\\n" * 200) + "\\n" + marker + "修复会话标题泄漏问题")
agent_view = describe_skill_invocation(skill_turn)
text = bridge_title.title_input_text(skill_turn)
bridge_title.generate_title_with_reasoning_floor(text)
done({"agent_view": agent_view, "wire_user": requests[-1]["user"] if requests else None})
`)
    expect(result.agent_view).toBe('/work — 修复会话标题泄漏问题')
    expect(result.wire_user.startsWith('/work — 修复会话标题泄漏问题\n\n[Title language:')).toBe(true)
    expect(result.wire_user.length).toBeLessThanOrEqual(1000)
  }, 120_000)
})
