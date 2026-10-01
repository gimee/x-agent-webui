// hermes-v051:T0 — bridge 标题下限重试助手（Hermes generate_title 外包一层）。
// Hermes 标题请求写死关推理；某些中转对 reasoning_effort:"none" 一律回不含 reasoning 字样的 400，
// Agent 自带阶梯识别不到。助手捕获 400 → 用 Hermes 自己的解析拿到标题线路 → remember_reasoning_floor → 重试一次。
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

function runPython(script: string): any {
  try {
    return JSON.parse(execFileSync('python3', ['-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: 'pipe',
    }))
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    throw new Error([
      err.message || 'Python T0 title floor script failed',
      err.stdout ? `stdout:\n${err.stdout}` : '',
      err.stderr ? `stderr:\n${err.stderr}` : '',
    ].filter(Boolean).join('\n\n'))
  }
}

// Stubs mirror the Hermes shapes the helper relies on: generate_title swallows provider errors and
// reports them through failure_callback; the floor memo is keyed by (host:port, model).
const harness = String.raw`
import json
import sys
import types
from pathlib import Path
from urllib.parse import urlparse

bridge_dir = Path("packages/server/src/modules/hermes/services/bridge/python").resolve()
sys.path.insert(0, str(bridge_dir))

agent_pkg = types.ModuleType("agent")
agent_pkg.__path__ = []
sys.modules["agent"] = agent_pkg

floor = types.ModuleType("agent.auxiliary_reasoning_floor")
floor._FLOORED_ROUTES = set()
def _route_key(provider, base_url):
    return (urlparse(base_url or "").netloc or "").lower() or str(provider or "").strip().lower()
floor._route_key = _route_key
remember_calls = []
def remember_reasoning_floor(provider, base_url, rejected_kwargs, error):
    remember_calls.append({
        "provider": provider,
        "base_url": base_url,
        "model": rejected_kwargs.get("model"),
        "status": getattr(error, "status_code", None),
    })
    floor._FLOORED_ROUTES.add((_route_key(provider, base_url), str(rejected_kwargs.get("model") or "")))
floor.remember_reasoning_floor = remember_reasoning_floor
sys.modules["agent.auxiliary_reasoning_floor"] = floor
agent_pkg.auxiliary_reasoning_floor = floor

aux = types.ModuleType("agent.auxiliary_client")
class FakeClient:
    base_url = "http://192.0.2.10:8080/v1/"
resolve_calls = []
def get_text_auxiliary_client(task="", *, main_runtime=None):
    resolve_calls.append({"task": task, "main_runtime": main_runtime})
    return FakeClient(), "fixture-summary-model"
def _resolve_task_provider_model(task=None, provider=None, model=None, base_url=None, api_key=None):
    return ("custom:example-grok-chat", "fixture-summary-model", None, None, "chat_completions")
aux.get_text_auxiliary_client = get_text_auxiliary_client
aux._resolve_task_provider_model = _resolve_task_provider_model
sys.modules["agent.auxiliary_client"] = aux
agent_pkg.auxiliary_client = aux

class FakeHTTPError(Exception):
    def __init__(self, status, body=None):
        super().__init__(f"Error code: {status} - Upstream error: {status}")
        self.status_code = status
        self.request = None
        if body is not None:
            self.request = types.SimpleNamespace(content=json.dumps(body).encode("utf-8"))

tg = types.ModuleType("agent.title_generator")
calls = []
script = []
def generate_title(user_message, timeout=None, failure_callback=None, main_runtime=None, runtime_validator=None, title_preview=None):
    floored = ("192.0.2.10:8080", "fixture-summary-model") in floor._FLOORED_ROUTES
    calls.append({"message": user_message, "floored": floored})
    outcome = script.pop(0) if script else None
    if callable(outcome):
        outcome = outcome(floored)
    if isinstance(outcome, BaseException):
        if failure_callback is not None:
            failure_callback("title generation", outcome)
        return None
    return outcome
tg.generate_title = generate_title
sys.modules["agent.title_generator"] = tg
agent_pkg.title_generator = tg

import bridge_title

forwarded = []
def forward(task, exc):
    forwarded.append({"task": task, "status": getattr(exc, "status_code", None)})

def only_low_works(floored):
    return "助手自我介绍" if floored else FakeHTTPError(400, {"model": "fixture-summary-model", "reasoning_effort": "none"})
`

describe('hermes-v051:T0 generate_title reasoning-floor retry', () => {
  it('remembers the floor for the resolved title route after a thinking-off 400 and retries once', () => {
    const result = runPython(`${harness}
script.extend([only_low_works, only_low_works])
title, reason = bridge_title.generate_title_with_reasoning_floor("你好，介绍一下你自己", failure_callback=forward)
print(json.dumps({
    "title": title,
    "reason": reason,
    "calls": calls,
    "remember_calls": remember_calls,
    "forwarded": forwarded,
    "resolve_tasks": [c["task"] for c in resolve_calls],
}))
`)

    expect(result.title).toBe('助手自我介绍')
    expect(result.reason).toBeNull()
    expect(result.calls).toEqual([
      { message: '你好，介绍一下你自己', floored: false },
      { message: '你好，介绍一下你自己', floored: true },
    ])
    // Route comes from Hermes' own title-task resolution, not a hard-coded address.
    expect(result.remember_calls).toEqual([
      { provider: 'custom:example-grok-chat', base_url: 'http://192.0.2.10:8080/v1/', model: 'fixture-summary-model', status: 400 },
    ])
    expect(result.resolve_tasks).toContain('title_generation')
    // The recovered 400 is not surfaced as a failure.
    expect(result.forwarded).toEqual([])
  })

  it('treats 422 like 400', () => {
    const result = runPython(`${harness}
script.extend([FakeHTTPError(422), "Fix build"])
title, reason = bridge_title.generate_title_with_reasoning_floor("fix the build")
print(json.dumps({"title": title, "calls": len(calls), "remember": len(remember_calls)}))
`)
    expect(result).toEqual({ title: 'Fix build', calls: 2, remember: 1 })
  })

  it('does not retry non-400 failures and forwards the failure', () => {
    const result = runPython(`${harness}
script.extend([FakeHTTPError(500), "should not be reached"])
title, reason = bridge_title.generate_title_with_reasoning_floor("hello", failure_callback=forward)
print(json.dumps({"title": title, "reason": reason, "calls": len(calls), "remember": remember_calls, "forwarded": forwarded}))
`)
    expect(result.title).toBeNull()
    expect(result.reason).toBe('http_500')
    expect(result.calls).toBe(1)
    expect(result.remember).toEqual([])
    expect(result.forwarded).toEqual([{ task: 'title generation', status: 500 }])
  })

  it('does not retry when the rejected request already went out at the floor effort', () => {
    const result = runPython(`${harness}
floor._FLOORED_ROUTES.add(("192.0.2.10:8080", "fixture-summary-model"))
script.extend([FakeHTTPError(400, {"model": "fixture-summary-model", "reasoning_effort": "low"}), "should not be reached"])
title, reason = bridge_title.generate_title_with_reasoning_floor("hello")
print(json.dumps({"title": title, "reason": reason, "calls": len(calls), "remember": len(remember_calls),
                  "floored_after": sorted(list(k) for k in floor._FLOORED_ROUTES)}))
`)
    expect(result).toEqual({
      title: null,
      reason: 'http_400',
      calls: 1,
      remember: 0,
      floored_after: [['192.0.2.10:8080', 'fixture-summary-model']],
    })
  })

  // hermes-v051:T0 R3-05: the wire body decides; a floor another caller recorded meanwhile is no reason to give up.
  it('retries when another caller floored the route while this thinking-off request was in flight', () => {
    const result = runPython(`${harness}
def rejected_while_someone_floors(floored):
    floor._FLOORED_ROUTES.add(("192.0.2.10:8080", "fixture-summary-model"))
    return FakeHTTPError(400, {"model": "fixture-summary-model", "reasoning_effort": "none"})
script.extend([rejected_while_someone_floors, "并发标题"])
title, reason = bridge_title.generate_title_with_reasoning_floor("hello")
print(json.dumps({"title": title, "calls": calls, "remember": len(remember_calls)}))
`)
    expect(result.title).toBe('并发标题')
    expect(result.calls).toEqual([
      { message: 'hello', floored: false },
      { message: 'hello', floored: true },
    ])
    // Not ours: nothing re-recorded.
    expect(result.remember).toBe(0)
  })

  it('a failed retry never removes a floor another caller recorded', () => {
    const result = runPython(`${harness}
def rejected_while_someone_floors(floored):
    floor._FLOORED_ROUTES.add(("192.0.2.10:8080", "fixture-summary-model"))
    return FakeHTTPError(400, {"model": "fixture-summary-model", "reasoning_effort": "none"})
script.extend([rejected_while_someone_floors, FakeHTTPError(400, {"model": "fixture-summary-model", "reasoning_effort": "low"})])
title, reason = bridge_title.generate_title_with_reasoning_floor("hello")
print(json.dumps({"title": title, "reason": reason, "floored_after": sorted(list(k) for k in floor._FLOORED_ROUTES)}))
`)
    expect(result).toEqual({ title: null, reason: 'http_400', floored_after: [['192.0.2.10:8080', 'fixture-summary-model']] })
  })

  for (const order of ['owner-fails-last', 'owner-fails-first'] as const) {
    it(`concurrent T0 calls on one route keep a floor that worked for anyone (${order})`, () => {
      const result = runPython(`${harness}
import threading
import time
order = "${order}"
first_calls = threading.Barrier(2)
done = {"A": threading.Event(), "B": threading.Event()}
seen = {"A": 0, "B": 0}
def behave(floored):
    who = threading.current_thread().name
    seen[who] += 1
    if seen[who] == 1:
        first_calls.wait(5)  # both thinking-off requests are on the wire before anyone floors
        if who == "B":
            time.sleep(0.1)  # A reaches the floor claim first and owns it
        return FakeHTTPError(400, {"model": "fixture-summary-model", "reasoning_effort": "none"})
    if who == "A":  # A claims the floor first (it starts first) and its floored retry fails
        if order == "owner-fails-last":
            done["B"].wait(5)
            time.sleep(0.2)  # let B record that the floor worked
        return FakeHTTPError(400, {"model": "fixture-summary-model", "reasoning_effort": "low"})
    if order == "owner-fails-first":
        done["A"].wait(5)
        time.sleep(0.2)  # A has released its claim by now
    return "B 的标题"
script.extend([behave, behave, behave, behave])
results = {}
def run(who):
    try:
        results[who] = bridge_title.generate_title_with_reasoning_floor("hello")
    finally:
        done[who].set()
a = threading.Thread(target=run, args=("A",), name="A")
b = threading.Thread(target=run, args=("B",), name="B")
a.start(); time.sleep(0.05); b.start()
a.join(10); b.join(10)
print(json.dumps({"A": results.get("A"), "B": results.get("B"),
                  "floored_after": sorted(list(k) for k in floor._FLOORED_ROUTES)}, ensure_ascii=False))
`)
      expect(result.B).toEqual(['B 的标题', null])
      expect(result.A).toEqual([null, 'http_400'])
      expect(result.floored_after).toEqual([['192.0.2.10:8080', 'fixture-summary-model']])
    })
  }

  it('does not retry when the rejected wire body shows reasoning was not switched off', () => {
    const result = runPython(`${harness}
script.extend([FakeHTTPError(400, {"model": "fixture-summary-model", "reasoning_effort": "medium"}), "unreached"])
title, reason = bridge_title.generate_title_with_reasoning_floor("hello")
print(json.dumps({"title": title, "reason": reason, "calls": len(calls), "remember": len(remember_calls)}))
`)
    expect(result).toEqual({ title: null, reason: 'http_400', calls: 1, remember: 0 })
  })

  it('forgets the floor again when the floored retry also fails (Hermes only memoises a floor that worked)', () => {
    const result = runPython(`${harness}
script.extend([FakeHTTPError(400), FakeHTTPError(400)])
title, reason = bridge_title.generate_title_with_reasoning_floor("hello", failure_callback=forward)
print(json.dumps({
    "title": title,
    "reason": reason,
    "calls": len(calls),
    "floored_after": sorted(list(k) for k in floor._FLOORED_ROUTES),
    "forwarded": forwarded,
}))
`)
    expect(result.title).toBeNull()
    expect(result.reason).toBe('http_400')
    expect(result.calls).toBe(2)
    expect(result.floored_after).toEqual([])
    expect(result.forwarded).toEqual([{ task: 'title generation', status: 400 }])
  })

  it('degrades to a single un-retried call when the Hermes floor API is missing', () => {
    const result = runPython(`${harness}
del sys.modules["agent.auxiliary_reasoning_floor"]
del agent_pkg.auxiliary_reasoning_floor
class Blocker:
    def find_spec(self, name, path=None, target=None):
        if name == "agent.auxiliary_reasoning_floor":
            raise ImportError("renamed upstream")
        return None
sys.meta_path.insert(0, Blocker())
script.extend([FakeHTTPError(400), "unreached"])
title, reason = bridge_title.generate_title_with_reasoning_floor("hello")
print(json.dumps({"title": title, "reason": reason, "calls": len(calls)}))
`)
    expect(result).toEqual({ title: null, reason: 'http_400', calls: 1 })
  })

  it('degrades to a single un-retried call when the title route cannot be resolved', () => {
    const result = runPython(`${harness}
del aux.get_text_auxiliary_client
script.extend([FakeHTTPError(400), "unreached"])
title, reason = bridge_title.generate_title_with_reasoning_floor("hello")
print(json.dumps({"title": title, "reason": reason, "calls": len(calls), "remember": len(remember_calls)}))
`)
    expect(result).toEqual({ title: null, reason: 'http_400', calls: 1, remember: 0 })
  })

  it('reports unavailable when Hermes generate_title itself is missing', () => {
    const result = runPython(`${harness}
del tg.generate_title
title, reason = bridge_title.generate_title_with_reasoning_floor("hello")
print(json.dumps({"title": title, "reason": reason}))
`)
    expect(result).toEqual({ title: null, reason: 'unavailable' })
  })

  // hermes-v051:T0 R3-11: the title route (an aux client) is only resolved once a 400 needs it.
  it('passes through a first-try success without resolving the title route', () => {
    const result = runPython(`${harness}
script.extend(["Postgres pool exhaustion"])
title, reason = bridge_title.generate_title_with_reasoning_floor("pg pool is exhausted")
print(json.dumps({"title": title, "reason": reason, "calls": len(calls), "remember": len(remember_calls), "resolves": len(resolve_calls)}))
`)
    expect(result).toEqual({ title: 'Postgres pool exhaustion', reason: null, calls: 1, remember: 0, resolves: 0 })
  })

  it('does not resolve the title route for failures that cannot be floored', () => {
    const result = runPython(`${harness}
script.extend([FakeHTTPError(500)])
bridge_title.generate_title_with_reasoning_floor("hello")
print(json.dumps({"resolves": len(resolve_calls)}))
`)
    expect(result).toEqual({ resolves: 0 })
  })
})
