// hermes-v051:T1 — bridge 新增 generate_title 动作（编程工具对话标题）：worker 处理、broker 按 profile 路由、
// worker 在独立线程作答（不堵同一 worker 的 get_output 轮询）、TS client 方法。
import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

function runPython(script: string): any {
  try {
    return JSON.parse(execFileSync('python3', ['-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 60_000,
    }))
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    throw new Error([
      err.message || 'Python T1 generate_title script failed',
      err.stdout ? `stdout:\n${err.stdout}` : '',
      err.stderr ? `stderr:\n${err.stderr}` : '',
    ].filter(Boolean).join('\n\n'))
  }
}

const serverHarness = String.raw`
import json
import sys
import types
from pathlib import Path

bridge_dir = Path("packages/server/src/modules/hermes/services/bridge/python").resolve()
sys.path.insert(0, str(bridge_dir))
import bridge_server
import bridge_title

bridge_server._ensure_agent_imports = lambda: None
helper_calls = []
def fake_floor_helper(user_message, **kwargs):
    helper_calls.append({"message": user_message, "kwargs": sorted(kwargs)})
    return next_result[0]
bridge_title.generate_title_with_reasoning_floor = fake_floor_helper
bridge_title.title_model_upgrade_enabled = lambda: True
next_result = [("整理三场评审会议纪要", None)]
server = object.__new__(bridge_server.BridgeServer)
`

describe('hermes-v051:T1 bridge generate_title action', () => {
  it('worker answers generate_title through the T0 helper with the bridge title language hint', () => {
    const result = runPython(`${serverHarness}
ok = server.handle({"action": "generate_title", "message": "把会议纪要整理好发给团队", "profile": "default"})
next_result[0] = (None, "http_400")
failed = server.handle({"action": "generate_title", "message": "再试一次"})
empty = server.handle({"action": "generate_title", "message": "   "})
print(json.dumps({"ok": ok, "failed": failed, "empty": empty, "calls": helper_calls}))
`)

    expect(result.ok).toEqual({ title: '整理三场评审会议纪要' })
    expect(result.failed).toEqual({ title: null, reason: 'http_400' })
    expect(result.empty).toEqual({ title: null, reason: 'empty_message' })
    expect(result.calls).toHaveLength(2)
    expect(result.calls[0].message.startsWith('把会议纪要整理好发给团队\n\n[Title language:')).toBe(true)
  })

  it('keeps the language hint even when the first message is longer than the Hermes title budget', () => {
    const result = runPython(`${serverHarness}
server.handle({"action": "generate_title", "message": "长" * 5000})
print(json.dumps({"message": helper_calls[0]["message"]}))
`)
    const message: string = result.message
    expect(message.length).toBeLessThanOrEqual(1000)
    expect(message).toContain('[Title language:')
  })

  it('reports disabled when Hermes title model upgrades are switched off', () => {
    const result = runPython(`${serverHarness}
bridge_title.title_model_upgrade_enabled = lambda: False
resp = server.handle({"action": "generate_title", "message": "hello"})
print(json.dumps({"resp": resp, "calls": len(helper_calls)}))
`)
    expect(result).toEqual({ resp: { title: null, reason: 'disabled' }, calls: 0 })
  })

  it('does not settle on the Hermes provisional greeting title', () => {
    const result = runPython(`${serverHarness}
next_result[0] = ("Friendly greeting", None)
resp = server.handle({"action": "generate_title", "message": "hi"})
print(json.dumps(resp))
`)
    expect(result).toEqual({ title: null, reason: 'provisional' })
  })

  // hermes-v051:T1 R3-08: Chinese greeting placeholders are provisional too.
  it('treats Chinese greeting placeholder titles as provisional', () => {
    const result = runPython(`${serverHarness}
out = []
for candidate in ("友好问候", "问候", "打招呼", "你好", "简单问候", "友好问候。", "修复构建"):
    next_result[0] = (candidate, None)
    out.append(server.handle({"action": "generate_title", "message": "你好"}))
print(json.dumps(out, ensure_ascii=False))
`)
    expect(result.slice(0, 6)).toEqual(Array(6).fill({ title: null, reason: 'provisional' }))
    expect(result[6]).toEqual({ title: '修复构建' })
  })

  it('broker routes generate_title to the requested profile worker', () => {
    const result = runPython(String.raw`
import json
import sys
from pathlib import Path

bridge_dir = Path("packages/server/src/modules/hermes/services/bridge/python").resolve()
sys.path.insert(0, str(bridge_dir))
import bridge_broker

broker = bridge_broker.BridgeBroker("ipc:///tmp/hermes-v051-t1-broker-test.sock")
forwarded = []
def fake_forward(profile, req, worker_key=None):
    forwarded.append({"profile": profile, "worker_key": worker_key, "action": req.get("action")})
    return {"ok": True, "title": "标题"}
broker._forward = fake_forward
a = broker.handle({"action": "generate_title", "message": "x", "profile": "research"})
b = broker.handle({"action": "generate_title", "message": "x"})
c = broker.handle({"action": "generate_title", "message": "x", "profile": "research", "worker_key": "research:title"})
print(json.dumps({"responses": [a, b, c], "forwarded": forwarded}))
`)
    expect(result.forwarded).toEqual([
      { profile: 'research', worker_key: 'research', action: 'generate_title' },
      { profile: 'default', worker_key: 'default', action: 'generate_title' },
      { profile: 'research', worker_key: 'research:title', action: 'generate_title' },
    ])
    expect(result.responses[0]).toEqual({ ok: true, title: '标题' })
  })

  it('worker keeps serving other requests while a slow generate_title is in flight', () => {
    const result = runPython(String.raw`
import json
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

bridge_dir = Path("packages/server/src/modules/hermes/services/bridge/python").resolve()
sys.path.insert(0, str(bridge_dir))
import bridge_server
import bridge_transport

sock_path = Path(tempfile.gettempdir()) / f"hermes-v051-t1-worker-{os.getpid()}.sock"
endpoint = f"ipc://{sock_path}"
release = threading.Event()

class FakePool:
    def __init__(self):
        import threading as _t
        self._lock = _t.RLock()
        self._sessions = {}

server = bridge_server.BridgeServer.__new__(bridge_server.BridgeServer)
server.endpoint = endpoint
server.pool = FakePool()
server._stop = threading.Event()
server._last_gc = time.time()
original_handle = bridge_server.BridgeServer.handle
def handle(self, req):
    if req.get("action") == "generate_title":
        release.wait(10)
        return {"title": "慢标题"}
    return original_handle(self, req)
server.handle = types_method = handle.__get__(server, bridge_server.BridgeServer)

outcome = {}
def client():
    try:
        deadline = time.time() + 10
        while not sock_path.exists() and time.time() < deadline:
            time.sleep(0.02)
        title_result = {}
        def ask_title():
            title_result["resp"] = bridge_transport._send_bridge_request(endpoint, {"action": "generate_title", "message": "x"}, 15)
        t = threading.Thread(target=ask_title)
        t.start()
        time.sleep(0.3)
        started = time.time()
        pong = bridge_transport._send_bridge_request(endpoint, {"action": "ping"}, 5)
        outcome["ping_seconds"] = round(time.time() - started, 3)
        outcome["ping_ok"] = bool(pong.get("pong"))
        outcome["title_pending_during_ping"] = "resp" not in title_result
        release.set()
        t.join(10)
        outcome["title"] = title_result.get("resp", {}).get("title")
    except Exception as exc:
        outcome["error"] = repr(exc)
    finally:
        release.set()
        server._stop.set()

threading.Thread(target=client, daemon=True).start()
import contextlib
import io
with contextlib.redirect_stdout(io.StringIO()):
    server.serve_forever()
print(json.dumps(outcome))
`)
    expect(result.error).toBeUndefined()
    expect(result.ping_ok).toBe(true)
    expect(result.title_pending_during_ping).toBe(true)
    expect(result.ping_seconds).toBeLessThan(2)
    expect(result.title).toBe('慢标题')
  })

  it('TS client sends generate_title with the profile and first message', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/modules/hermes/services/bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1', connectRetryMs: 0, timeoutMs: 1 })
    const request = vi.spyOn(client, 'request').mockResolvedValue({ ok: true, title: '标题' })

    const result = await client.generateTitle('第一条消息', 'research', { timeoutMs: 90_000 })

    expect(result.title).toBe('标题')
    expect(request).toHaveBeenCalledWith({
      action: 'generate_title',
      message: '第一条消息',
      profile: 'research',
    }, { timeoutMs: 90_000 })
  })
})
