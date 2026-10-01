// hermes-v051:T2 — Hermes 对话回合末标题兜底（bridge_pool）：删掉旧签名 maybe_auto_title 重复调用（TypeError 被吞），
// 改为来源不是 llm/user 时走 T0 生成、经 Hermes 持久化接口以 llm 写入、推 session.title.updated、异常记日志；
// get_session_title 额外返回来源。
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
      err.message || 'Python T2 title fallback script failed',
      err.stdout ? `stdout:\n${err.stdout}` : '',
      err.stderr ? `stderr:\n${err.stderr}` : '',
    ].filter(Boolean).join('\n\n'))
  }
}

const harness = String.raw`
import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import threading
import time
import types
import weakref
from pathlib import Path

bridge_dir = Path("packages/server/src/modules/hermes/services/bridge/python").resolve()
sys.path.insert(0, str(bridge_dir))

captured_stderr = io.StringIO()
real_stderr = sys.stderr

hermes_constants = types.ModuleType("hermes_constants")
hermes_constants.parse_reasoning_effort = lambda effort: {"enabled": True, "effort": effort} if effort else None
sys.modules["hermes_constants"] = hermes_constants

agent_pkg = types.ModuleType("agent")
agent_pkg.__path__ = []
sys.modules["agent"] = agent_pkg
tg = types.ModuleType("agent.title_generator")
maybe_calls = []
def maybe_auto_title(*args, **kwargs):
    maybe_calls.append(len(args))
tg.maybe_auto_title = maybe_auto_title
wait_calls = []
tg.wait_for_title_upgrades = lambda timeout=10.0: wait_calls.append(timeout)
# Hermes' registry of in-flight Agent title upgrade threads (args = (session_db, session_id, user_message)).
tg._UPGRADE_THREADS = weakref.WeakSet()
def agent_upgrade_thread(session_id, seconds, then=None):
    def work(_db, _sid, _msg):
        time.sleep(seconds)
        if then is not None:
            then()
    thread = threading.Thread(target=work, args=(object(), session_id, "msg"), daemon=True)
    tg._UPGRADE_THREADS.add(thread)
    thread.start()
    return thread
tg._auto_title_enabled = lambda: True
tg._model_title_upgrade_enabled = lambda: True
persist_calls = []
def _persist_session_title(session_db, session_id, title, *, source, dedupe=True):
    persist_calls.append({"session_id": session_id, "title": title, "source": source})
    return title if session_db.set_auto_title(session_id, title, source=source) else None
tg._persist_session_title = _persist_session_title
tg._is_real_user_turn = lambda m: isinstance(m, dict) and m.get("role") == "user" and bool(str(m.get("content") or "").strip())
tg._is_provisional_greeting_title = lambda t: t.strip().lower() == "friendly greeting"
sys.modules["agent.title_generator"] = tg
agent_pkg.title_generator = tg

runtime_spec = importlib.util.spec_from_file_location("bridge_runtime", str(bridge_dir / "bridge_runtime.py"))
bridge_runtime = importlib.util.module_from_spec(runtime_spec)
sys.modules["bridge_runtime"] = bridge_runtime
runtime_spec.loader.exec_module(bridge_runtime)
bridge_runtime._ensure_agent_imports = lambda: None
bridge_runtime._load_cfg = lambda *_a, **_k: {"model": "fixture-main-model"}
bridge_runtime._load_reasoning_config = lambda *_a, **_k: None
bridge_runtime._base_hermes_home = lambda: Path(tempfile.gettempdir())
bridge_runtime._bridge_platform = lambda: "cli"
bridge_runtime._cfg_max_turns = lambda *_a, **_k: 20
bridge_runtime._discover_bridge_mcp_tools = lambda *_a, **_k: []
bridge_runtime._hermes_home = lambda *_a, **_k: Path(tempfile.gettempdir())
bridge_runtime._install_execute_code_approval_memory_patch = lambda *_a, **_k: None
bridge_runtime._load_enabled_toolsets = lambda *_a, **_k: []
bridge_runtime._load_service_tier = lambda *_a, **_k: None
bridge_runtime._profile_home = lambda *_a, **_k: Path(tempfile.gettempdir())
bridge_runtime._refresh_approval_allowlist = lambda *_a, **_k: None
bridge_runtime._refresh_worker_profile_env = lambda *_a, **_k: None
bridge_runtime._resolve_model = lambda cfg: str(cfg.get("model") or "")
bridge_runtime._resolve_runtime = lambda model, provider=None: {"provider": provider or "custom"}
bridge_runtime._suppress_bridge_platform_hint = lambda: None
@contextlib.contextmanager
def profile_env(_profile):
    yield
bridge_runtime._profile_env = profile_env

class FakeAIAgent:
    def __init__(self, **kwargs):
        self.model = kwargs.get("model") or "fixture-main-model"
        self.provider = kwargs.get("provider") or "custom:fixture-provider"
        self.base_url = "http://192.0.2.10:8080/v1"
        self.api_key = "not-a-real-key"
        self.api_mode = "codex_responses"
        self.reasoning_config = None
        self.tools = []
        self.result = {"final_response": "好的，已经转过去了。", "messages": [
            {"role": "user", "content": "把会议纪要整理好发给团队"},
            {"role": "assistant", "content": "好的，已经转过去了。"},
        ]}
    def run_conversation(self, _message, **_kwargs):
        return dict(self.result)
run_agent = types.ModuleType("run_agent")
run_agent.AIAgent = FakeAIAgent
sys.modules["run_agent"] = run_agent

pool_spec = importlib.util.spec_from_file_location("bridge_pool", str(bridge_dir / "bridge_pool.py"))
bridge_pool = importlib.util.module_from_spec(pool_spec)
sys.modules["bridge_pool"] = bridge_pool
pool_spec.loader.exec_module(bridge_pool)
import bridge_title

class FakeSessionDB:
    def __init__(self, title=None, source=None):
        self.title = title
        self.source = source
        self.writes = []
    def get_session_title(self, session_id):
        return self.title
    def get_session_title_source(self, session_id):
        return self.source if self.title is not None else None
    def set_auto_title(self, session_id, title, *, source):
        self.writes.append({"title": title, "source": source})
        rank = {"derived": 0, "llm": 1, "user": 2}
        if self.title is not None and rank.get(self.source, 2) >= rank[source]:
            return False
        self.title, self.source = title, source
        return True

db = FakeSessionDB(title="把会议纪要整理好发给团队", source="derived")
pool = bridge_pool.AgentPool()
pool._db = types.SimpleNamespace(get_for_profile=lambda _profile: db, error=None)
pool._enter_exec_ask_scope = lambda: None
pool._exit_exec_ask_scope = lambda: None
pool._install_approval_dispatcher_for_current_thread = lambda *_a: None
pool._approval_callback = lambda *_a: None
pool._prepersist_user_message = lambda *_a: None
pool._session_db_message_count = lambda *_a: None
pool._prepend_pending_model_switch_note = lambda _session, message: message
pool._sync_result_tail_to_session_db = lambda *_a: None
pool._result_from_agent_messages_for_sync = lambda *_a: None
pool._apply_pending_session_model_switch = lambda *_a: None
# Run the post-turn title job inline so assertions see its effects.
pool._start_title_fallback = lambda target, session_id: target()

helper_calls = []
helper_result = [("整理三场评审会议纪要", None)]
def fake_helper(user_message, **kwargs):
    helper_calls.append({"message": user_message, "main_runtime_model": (kwargs.get("main_runtime") or {}).get("model")})
    return helper_result[0]
bridge_title.generate_title_with_reasoning_floor = fake_helper

def run_turn(message="把会议纪要整理好发给团队", result=None, source=None, session_id="sess-t2"):
    session = pool.get_or_create(session_id, model="fixture-main-model")
    if result is not None:
        session.agent.result = result
    session.running = True
    record = bridge_pool.RunRecord("run-" + str(len(helper_calls)) + "-" + str(len(maybe_calls)), session.session_id)
    sys.stderr = captured_stderr
    try:
        pool._run_chat(session, record, message, profile="default", source=source)
    finally:
        sys.stderr = real_stderr
    return record

def title_events(record):
    return [e for e in record.events if e.get("event") == "session.title.updated"]
`

describe('hermes-v051:T2 Hermes turn-end title fallback', () => {
  it('replaces the broken maybe_auto_title call: a derived title is upgraded through T0 and persisted as llm', () => {
    const result = runPython(`${harness}
record = run_turn()
print(json.dumps({
    "status": record.status,
    "maybe_calls": maybe_calls,
    "helper_calls": helper_calls,
    "persist_calls": persist_calls,
    "db": {"title": db.title, "source": db.source},
    "events": title_events(record),
}))
`)

    expect(result.status).toBe('complete')
    expect(result.maybe_calls).toEqual([])
    expect(result.helper_calls).toHaveLength(1)
    expect(result.helper_calls[0].message.startsWith('把会议纪要整理好发给团队\n\n[Title language:')).toBe(true)
    expect(result.helper_calls[0].main_runtime_model).toBe('fixture-main-model')
    expect(result.persist_calls).toEqual([{ session_id: 'sess-t2', title: '整理三场评审会议纪要', source: 'llm' }])
    expect(result.db).toEqual({ title: '整理三场评审会议纪要', source: 'llm' })
    expect(result.events).toEqual([
      { event: 'session.title.updated', session_id: 'sess-t2', title: '整理三场评审会议纪要', source: 'llm' },
    ])
  })

  // hermes-v051:T2 R3-09: wait for this session's own Agent upgrade only (poll its title every 0.5 s).
  it('waits for this session own in-flight Agent upgrade before deciding', () => {
    const result = runPython(`${harness}
def lands():
    db.title, db.source = "Agent 自己的标题", "llm"
agent_upgrade_thread("sess-t2", 0.8, then=lands)
started = time.time()
record = run_turn()
print(json.dumps({"seconds": round(time.time() - started, 2), "process_wide_waits": len(wait_calls),
                  "helper_calls": len(helper_calls), "db": db.title, "events": title_events(record)}))
`)
    expect(result.helper_calls).toBe(0)
    expect(result.db).toBe('Agent 自己的标题')
    expect(result.events).toEqual([])
    expect(result.process_wide_waits).toBe(0)
    expect(result.seconds).toBeGreaterThanOrEqual(0.5)
  })

  it('does not wait for another session in-flight Agent upgrade', () => {
    const result = runPython(`${harness}
agent_upgrade_thread("some-other-session", 6.0)
started = time.time()
record = run_turn()
print(json.dumps({"seconds": round(time.time() - started, 2), "process_wide_waits": len(wait_calls),
                  "helper_calls": len(helper_calls), "events": len(title_events(record))}))
`)
    expect(result.helper_calls).toBe(1)
    expect(result.events).toBe(1)
    expect(result.process_wide_waits).toBe(0)
    expect(result.seconds).toBeLessThan(2)
  })

  // hermes-v051:T2 R3-03: internal compression sessions are never titled.
  it('skips internal compression sessions (api_server source or compress_* id)', () => {
    const result = runPython(`${harness}
run_turn(source="api_server")
run_turn(session_id="compress_mun0000_abcdef")
print(json.dumps({"helper_calls": len(helper_calls), "db": [db.title, db.source]}))
`)
    expect(result).toEqual({ helper_calls: 0, db: ['把会议纪要整理好发给团队', 'derived'] })
  })

  // hermes-v051:T2 R3-02: a /skill turn is reduced to "/skill — instruction" by Hermes before trimming.
  it('restores the /skill instruction with Hermes build_title_input before trimming', () => {
    const result = runPython(`${harness}
marker = "The user has provided the following instruction alongside the skill invocation: "
skill_turn = ('[IMPORTANT: The user has invoked the "work" skill, indicating they want you to follow its instructions. '
              'The full skill content is loaded below.]\\n\\n' + ("技能正文。" * 600) + "\\n\\n" + marker + "修复会话标题泄漏问题")
def build_title_input(user_message, title_preview=None):
    if user_message.startswith("[IMPORTANT: The user has invoked the "):
        instruction = user_message.rsplit(marker, 1)[1] if marker in user_message else ""
        return ("/work — " + instruction) if instruction else "/work"
    return user_message[:1000]
tg.build_title_input = build_title_input
tg.MAX_TITLE_INPUT_CHARS = 1000
run_turn(message=skill_turn)
sent = helper_calls[0]["message"]
print(json.dumps({"sent_head": sent.split("\\n\\n[Title language:")[0], "has_hint": "[Title language:" in sent, "chars": len(sent)}))
`)
    expect(result.sent_head).toBe('/work — 修复会话标题泄漏问题')
    expect(result.has_hint).toBe(true)
    expect(result.chars).toBeLessThanOrEqual(1000)
  })

  it('keeps long plain turns within the Hermes title budget with the language hint intact', () => {
    const result = runPython(`${harness}
tg.build_title_input = lambda user_message, title_preview=None: user_message[:1000]
tg.MAX_TITLE_INPUT_CHARS = 1000
run_turn(message="长" * 5000)
sent = helper_calls[0]["message"]
print(json.dumps({"chars": len(sent), "has_hint": sent.endswith("Do not translate the title to English unless the user's message is English.]")}))
`)
    expect(result.chars).toBeLessThanOrEqual(1000)
    expect(result.has_hint).toBe(true)
  })

  // hermes-v051:T2 R3-08: Chinese greeting placeholders are provisional like "Friendly greeting".
  it('does not persist Chinese greeting placeholder titles', () => {
    const result = runPython(`${harness}
out = []
for candidate in ("友好问候", "问候", "打招呼", "你好", "简单问候", "「友好问候」"):
    helper_result[0] = (candidate, None)
    db.title, db.source = "你好", "derived"
    record = run_turn(message="你好")
    out.append([db.title, db.source, len(title_events(record))])
print(json.dumps(out, ensure_ascii=False))
`)
    for (const entry of result) expect(entry).toEqual(['你好', 'derived', 0])
  })

  it('leaves llm, user and pre-provenance (NULL source, ranked as user) titles alone', () => {
    const result = runPython(`${harness}
out = {}
for source in ("llm", "user", None):
    db.title, db.source = "已有标题", source
    record = run_turn()
    out[str(source)] = {"helper_calls": len(helper_calls), "title": db.title, "events": title_events(record)}
print(json.dumps(out))
`)
    expect(result.llm).toEqual({ helper_calls: 0, title: '已有标题', events: [] })
    expect(result.user).toEqual({ helper_calls: 0, title: '已有标题', events: [] })
    expect(result.None).toEqual({ helper_calls: 0, title: '已有标题', events: [] })
  })

  it('titles a session that has no title at all yet', () => {
    const result = runPython(`${harness}
db.title, db.source = None, None
record = run_turn()
print(json.dumps({"helper_calls": len(helper_calls), "db": [db.title, db.source], "events": len(title_events(record))}))
`)
    expect(result).toEqual({ helper_calls: 1, db: ['整理三场评审会议纪要', 'llm'], events: 1 })
  })

  it('follows the Agent turn budget: past the third real user turn a placeholder is not retried', () => {
    const result = runPython(`${harness}
history = []
for i in range(4):
    history.append({"role": "user", "content": f"第{i + 1}个问题"})
    history.append({"role": "assistant", "content": "回答"})
run_turn(message="第4个问题", result={"final_response": "回答", "messages": history})
print(json.dumps({"helper_calls": len(helper_calls)}))
`)
    expect(result.helper_calls).toBe(0)
  })

  it('does not persist answer-shaped or provisional titles (T3)', () => {
    const result = runPython(`${harness}
out = []
for candidate in ("好的，我已经帮你把三场评审会里的会议纪要全部整理出来并发到了团队群里面，请查收一下。", "Friendly greeting"):
    helper_result[0] = (candidate, None)
    db.title, db.source = "把会议纪要整理好发给团队", "derived"
    record = run_turn()
    out.append({"title": db.title, "source": db.source, "events": title_events(record)})
print(json.dumps({"out": out, "log": captured_stderr.getvalue()}))
`)
    for (const entry of result.out) {
      expect(entry).toEqual({ title: '把会议纪要整理好发给团队', source: 'derived', events: [] })
    }
    expect(result.log).toContain('bridge.title.fallback_skipped')
  })

  it('logs fallback failures instead of swallowing them, and the run still completes', () => {
    const result = runPython(`${harness}
def exploding(*_a, **_k):
    raise RuntimeError("set_auto_title exploded")
db.set_auto_title = exploding
record = run_turn()
print(json.dumps({"status": record.status, "log": captured_stderr.getvalue(), "events": title_events(record)}))
`)
    expect(result.status).toBe('complete')
    expect(result.events).toEqual([])
    expect(result.log).toContain('bridge.title.fallback_failed')
    expect(result.log).toContain('set_auto_title exploded')
    expect(result.log).not.toContain('not-a-real-key')
  })

  it('does not run for failed or partial turns', () => {
    const result = runPython(`${harness}
run_turn(result={"final_response": "x", "failed": True, "messages": []})
run_turn(result={"final_response": "x", "partial": True, "messages": []})
print(json.dumps({"helper_calls": len(helper_calls)}))
`)
    expect(result.helper_calls).toBe(0)
  })

  // hermes-v051:T2 R3-04: the Agent upgrade can land between two reads; never report derived text as llm.
  it('get_session_title never pairs a placeholder title with a newer source', () => {
    const result = runPython(`${harness}
class RacingDB(FakeSessionDB):
    def __init__(self):
        super().__init__(title="首句临时标题", source="derived")
        self.reads = 0
    def _after_read(self):
        self.reads += 1
        if self.reads == 1:  # the Agent's llm upgrade lands right after the first read
            self.title, self.source = "整理三场评审会议纪要", "llm"
    def get_session_title(self, session_id):
        value = super().get_session_title(session_id)
        self._after_read()
        return value
    def get_session_title_source(self, session_id):
        value = super().get_session_title_source(session_id)
        self._after_read()
        return value
racing = RacingDB()
pool._db = types.SimpleNamespace(get_for_profile=lambda _profile: racing, error=None)
first = pool.get_session_title("sess-t2", "default")
second = pool.get_session_title("sess-t2", "default")
print(json.dumps([first, second], ensure_ascii=False))
`)
    const [first, second] = result
    expect(first.title === '首句临时标题' && first.title_source === 'llm').toBe(false)
    expect(first.title_source === 'derived' || first.title === '整理三场评审会议纪要').toBe(true)
    expect(second).toEqual({ session_id: 'sess-t2', title: '整理三场评审会议纪要', title_source: 'llm' })
  })

  it('get_session_title also returns the title source', () => {
    const result = runPython(`${harness}
a = pool.get_session_title("sess-t2", "default")
db.title, db.source = "正式标题", "llm"
b = pool.get_session_title("sess-t2", "default")
legacy = types.SimpleNamespace(get_session_title=lambda _sid: "老库标题")
pool._db = types.SimpleNamespace(get_for_profile=lambda _profile: legacy, error=None)
c = pool.get_session_title("sess-t2", "default")
print(json.dumps([a, b, c]))
`)
    expect(result).toEqual([
      { session_id: 'sess-t2', title: '把会议纪要整理好发给团队', title_source: 'derived' },
      { session_id: 'sess-t2', title: '正式标题', title_source: 'llm' },
      { session_id: 'sess-t2', title: '老库标题', title_source: null },
    ])
  })
})
