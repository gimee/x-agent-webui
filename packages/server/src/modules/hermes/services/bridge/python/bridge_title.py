"""hermes-v051:T0-T3 — session titles on top of Hermes' own title generator.

Hermes titles every session in two stages: an instant ``derived`` title (the opening line) at
turn start, then one small-model ``llm`` upgrade (``agent.title_generator.generate_title``). That
call hard-codes ``reasoning_config={"enabled": False}``; the ``custom`` profile projects it as a
top-level ``reasoning_effort: "none"``, and some OpenAI-compatible relays reject that with an
opaque ``400 {"error": {"message": "Upstream error: 400"}}``. The rejection names no reasoning
field, so Hermes' own reasoning ladder (``_is_reasoning_field_rejection`` /
``_is_reasoning_required_rejection``) never matches, the upgrade returns ``None`` and the session
keeps its first-line placeholder.

This module is bridge code (Hermes itself is a base-image layer we only adapt to):

* T0 ``generate_title_with_reasoning_floor`` wraps ``generate_title``: a 400/422 whose rejected
  request really switched reasoning off is answered with Hermes' own ``remember_reasoning_floor``
  for the route the title task actually resolves to (unless another call already recorded it),
  then one retry (which Hermes now sends at the floor effort). Any missing Hermes internal
  degrades to the plain single call (fail-open).
* T1 ``generate_title_for_request`` backs the bridge ``generate_title`` action (coding-agent
  sessions have no Hermes session row; nothing is written here).
* T2 ``fallback_title_after_turn`` upgrades a Hermes session whose title is still a placeholder at
  turn end and persists it at ``llm`` authority through Hermes' own title store.
* T3 ``looks_like_answer_title`` is the answer-shaped guard shared with the Web UI.

Only the standard library is imported at module load; Hermes and ``bridge_runtime`` are imported
lazily so the module loads under any runtime (and under test stubs).
"""
from __future__ import annotations

import json
import re
import sys
import threading
import time
from typing import Any, Callable, Optional

TITLE_TASK = "title_generation"
# Statuses an OpenAI-compatible relay uses for "this request body is not acceptable".
_BAD_REQUEST_STATUSES = frozenset({400, 422})
# Same spellings Hermes treats as a reasoning disable (agent.auxiliary_reasoning_floor).
_DISABLED_EFFORTS = frozenset({"none", "off", "disabled", "false", "0"})
# Hermes hands the titler at most 1000 chars (MAX_TITLE_INPUT_CHARS); keep the bridge language hint
# inside that budget by trimming the message body first.
HERMES_TITLE_INPUT_CHARS = 1000
# Body trim used only when Hermes' own build_title_input is unavailable.
TITLE_INPUT_CHARS = 800
# Agent turn budget (agent.title_generator.maybe_auto_title): a placeholder is retried through the
# third real user turn; past that only an untitled session gets another model call.
MAX_PLACEHOLDER_TURNS = 3
# How long the turn-end fallback waits for the Agent's own in-flight title upgrade thread.
AGENT_UPGRADE_WAIT_SECONDS = 20.0
# hermes-v051:T2 R3-09 poll interval for this session's title while its Agent upgrade is in flight.
AGENT_UPGRADE_POLL_SECONDS = 0.5
SETTLED_TITLE_SOURCES = frozenset({"llm", "user"})
# hermes-v051:T2 R3-08 greeting placeholders a title model returns in Chinese for a bare "hi"; like Hermes'
# "Friendly greeting" they must not settle the session as its title.
_PROVISIONAL_CHINESE_TITLES = frozenset({
    "友好问候", "问候", "打招呼", "你好", "简单问候", "友好打招呼", "打个招呼", "问好", "寒暄", "日常问候",
})
_TITLE_EDGE_PUNCTUATION_RE = re.compile(r"^[\W_]+|[\W_]+$", re.UNICODE)

# hermes-v051:T3 answer-shaped guard: > 30 Han characters, a trailing full stop, or a line break.
MAX_TITLE_HAN_CHARS = 30
_HAN_RE = re.compile("[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U0003134f]")
_TITLE_FULL_STOPS = ("。", ".")

FailureCallback = Callable[[str, BaseException], None]


def _log(event: str, payload: dict[str, Any]) -> None:
    try:
        from bridge_runtime import _bridge_log

        _bridge_log(event, payload)
    except Exception:
        print(f"[hermes_bridge] {event} {payload}", file=sys.stderr, flush=True)


# ───── T3 ─────

def looks_like_answer_title(title: Any) -> bool:
    """hermes-v051:T3 True for model output that answered the message instead of naming it."""
    raw = str(title or "")
    if "\n" in raw or "\r" in raw:
        return True
    text = raw.strip()
    if not text:
        return False
    if text.endswith(_TITLE_FULL_STOPS):
        return True
    return len(_HAN_RE.findall(text)) > MAX_TITLE_HAN_CHARS


# ───── shared helpers ─────

def title_input_text(message: Any) -> str:
    """The bridge title input (``_title_user_message``: text + language hint) within Hermes' title
    budget, so the budget cannot cut the hint off.

    hermes-v051:T2 R3-02 the body first goes through Hermes' own ``build_title_input`` on the full
    text: a ``/skill`` turn embeds the whole skill body and the user's instruction sits at its end,
    so trimming first left only ``/work``. Without that Hermes API the body is trimmed as before."""
    try:
        from bridge_runtime import _title_user_message
    except Exception:
        text = str(message or "").strip()
        return text[:TITLE_INPUT_CHARS]
    full = _title_user_message(message)
    if not full:
        return ""
    # The hint suffix is whatever _title_user_message appends; derive it instead of copying it.
    suffix = _title_user_message("x")[1:]
    if not suffix or not full.endswith(suffix):
        return full[:TITLE_INPUT_CHARS]
    body = full[: len(full) - len(suffix)]
    try:
        from agent import title_generator

        body = str(title_generator.build_title_input(body) or "").strip()
        limit = int(getattr(title_generator, "MAX_TITLE_INPUT_CHARS", HERMES_TITLE_INPUT_CHARS))
    except Exception:
        if len(body) > TITLE_INPUT_CHARS:
            body = body[:TITLE_INPUT_CHARS].rstrip()
        return body + suffix
    if not body:
        return ""
    return body[: max(0, limit - len(suffix))].rstrip() + suffix


def title_model_upgrade_enabled() -> bool:
    """``auxiliary.title_generation.enabled`` and ``model_upgrade_enabled`` (both default on)."""
    try:
        from agent import title_generator
    except Exception:
        return True
    for name in ("_auto_title_enabled", "_model_title_upgrade_enabled"):
        check = getattr(title_generator, name, None)
        if not callable(check):
            continue
        try:
            if not check():
                return False
        except Exception:
            continue
    return True


def _is_provisional_title(title: str) -> bool:
    """Hermes' greeting placeholder ("Friendly greeting") is stored at derived authority; so are its
    Chinese renderings (hermes-v051:T2 R3-08)."""
    normalized = _TITLE_EDGE_PUNCTUATION_RE.sub("", str(title or "").strip())
    if normalized in _PROVISIONAL_CHINESE_TITLES:
        return True
    try:
        from agent.title_generator import _is_provisional_greeting_title

        return bool(_is_provisional_greeting_title(title))
    except Exception:
        return normalized.lower() in {"friendly greeting", "friendly greeting in chat"}


def _exc_status(exc: BaseException | None) -> int | None:
    for candidate in (
        getattr(exc, "status_code", None),
        getattr(getattr(exc, "response", None), "status_code", None),
    ):
        try:
            return int(candidate)
        except (TypeError, ValueError):
            continue
    return None


def _failure_reason(exc: BaseException | None) -> str:
    status = _exc_status(exc)
    return f"http_{status}" if status else "failed"


# ───── T0 ─────

def _title_route(main_runtime: Optional[dict]) -> tuple[str, str, str] | None:
    """(provider, base_url, model) the title task resolves to, via Hermes' own resolver.

    ``call_llm`` keys the floor on the resolved provider, the client's base URL and the final model;
    ``get_text_auxiliary_client`` is the public entry of that same resolution."""
    try:
        from agent.auxiliary_client import get_text_auxiliary_client

        client, model = get_text_auxiliary_client(TITLE_TASK, main_runtime=main_runtime)
    except Exception:
        return None
    if client is None or not model:
        return None
    provider = ""
    try:
        from agent.auxiliary_client import _resolve_task_provider_model

        provider = str(_resolve_task_provider_model(TITLE_TASK)[0] or "")
    except Exception:
        pass
    return provider, str(getattr(client, "base_url", "") or ""), str(model)


def _floor_key(route: tuple[str, str, str]) -> tuple[str, str] | None:
    try:
        from agent.auxiliary_reasoning_floor import _route_key

        return _route_key(route[0], route[1]), route[2]
    except Exception:
        return None


def _route_is_floored(route: tuple[str, str, str]) -> bool:
    key = _floor_key(route)
    if key is None:
        return False
    try:
        from agent.auxiliary_reasoning_floor import _FLOORED_ROUTES

        return key in _FLOORED_ROUTES
    except Exception:
        return False


# hermes-v051:T0 R3-05 concurrent title calls (T1 request threads, T2 turn-end threads) share Hermes'
# process-wide floor memo. One lock orders claim/confirm/release; a floor is withdrawn only by the call
# that recorded it, and never once any floored retry on that route has worked.
_FLOOR_LOCK = threading.Lock()
_CONFIRMED_FLOORS: set[tuple[str, str]] = set()


def _claim_floor(route: tuple[str, str, str], error: BaseException) -> bool:
    """Record the floor unless the route already has one; True when this call recorded it.
    Raises when Hermes' floor API is missing (the caller then does not retry)."""
    from agent.auxiliary_reasoning_floor import remember_reasoning_floor

    with _FLOOR_LOCK:
        if _route_is_floored(route):
            return False
        remember_reasoning_floor(route[0], route[1], {"model": route[2]}, error)
        return _floor_key(route) is not None


def _confirm_floor(route: tuple[str, str, str], error: BaseException) -> None:
    """A floored retry worked: keep the floor (re-record it if a failed claimant withdrew it meanwhile)."""
    key = _floor_key(route)
    with _FLOOR_LOCK:
        if key is not None:
            _CONFIRMED_FLOORS.add(key)
        if _route_is_floored(route):
            return
        try:
            from agent.auxiliary_reasoning_floor import remember_reasoning_floor

            remember_reasoning_floor(route[0], route[1], {"model": route[2]}, error)
        except Exception:
            pass


def _release_floor(route: tuple[str, str, str]) -> None:
    """Hermes only memoises a floor after the floored retry worked: withdraw the floor this call
    recorded when its retry failed, unless another call's floored retry proved it."""
    key = _floor_key(route)
    if key is None:
        return
    with _FLOOR_LOCK:
        if key in _CONFIRMED_FLOORS:
            return
        try:
            from agent.auxiliary_reasoning_floor import _FLOORED_ROUTES

            _FLOORED_ROUTES.discard(key)
        except Exception:
            pass


def _rejected_request_body(exc: BaseException) -> dict[str, Any] | None:
    request = getattr(exc, "request", None) or getattr(getattr(exc, "response", None), "request", None)
    try:
        content = getattr(request, "content", None)
    except Exception:
        return None
    if not content:
        return None
    try:
        body = json.loads(content.decode("utf-8") if isinstance(content, (bytes, bytearray)) else content)
    except Exception:
        return None
    return body if isinstance(body, dict) else None


def _is_disabled_reasoning(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, dict):
        return value.get("enabled") is False or _is_disabled_reasoning(value.get("effort"))
    return str(value).strip().lower() in _DISABLED_EFFORTS


def _sent_reasoning_disable(exc: BaseException) -> bool:
    """Whether the rejected request switched reasoning off. ``generate_title`` always asks for that;
    when the wire body is observable it must show one of Hermes' thinking-off encodings."""
    body = _rejected_request_body(exc)
    if body is None:
        return True
    extra = body.get("extra_body") if isinstance(body.get("extra_body"), dict) else {}
    return any(
        _is_disabled_reasoning(value)
        for value in (body.get("reasoning_effort"), body.get("reasoning"), extra.get("reasoning"))
    )


def generate_title_with_reasoning_floor(
    user_message: str,
    *,
    main_runtime: Optional[dict] = None,
    failure_callback: Optional[FailureCallback] = None,
) -> tuple[Optional[str], Optional[str]]:
    """hermes-v051:T0 ``generate_title`` plus one floored retry for an opaque thinking-off 400.

    Returns ``(title, None)`` or ``(None, reason)``. ``failure_callback`` only sees the final
    failure: a 400 the floor recovered from is not a failure."""
    try:
        from agent.title_generator import generate_title
    except Exception:
        return None, "unavailable"

    failures: list[BaseException] = []

    def capture(_task: str, exc: BaseException) -> None:
        failures.append(exc)

    kwargs: dict[str, Any] = {"failure_callback": capture, "main_runtime": main_runtime}

    def report(exc: BaseException | None) -> None:
        if exc is not None and failure_callback is not None:
            try:
                failure_callback("title generation", exc)
            except Exception:
                pass

    try:
        title = generate_title(user_message, **kwargs)
    except Exception:
        # generate_title never raises by contract; a TypeError here is an upstream signature change.
        return None, "unavailable"
    if title:
        return title, None
    first_error = failures[-1] if failures else None
    if first_error is None:
        return None, "no_title"
    # hermes-v051:T0 R3-05: what this request actually sent decides. A floor another call recorded while this
    # request was in flight is no reason to give up: the retry then simply goes out at the floor.
    if _exc_status(first_error) not in _BAD_REQUEST_STATUSES or not _sent_reasoning_disable(first_error):
        report(first_error)
        return None, _failure_reason(first_error)
    # hermes-v051:T0 R3-11: the title route (an aux client) is only resolved once a rejection needs it.
    route = _title_route(main_runtime)
    if route is None:
        report(first_error)
        return None, _failure_reason(first_error)
    try:
        recorded = _claim_floor(route, first_error)
    except Exception:
        report(first_error)
        return None, _failure_reason(first_error)
    key = _floor_key(route)
    _log("bridge.title.reasoning_floor", {
        "route": key[0] if key else "",
        "model": route[2],
        "status": _exc_status(first_error),
        "recorded": recorded,
    })
    failures.clear()
    try:
        title = generate_title(user_message, **kwargs)
    except Exception:
        title = None
    if title:
        _confirm_floor(route, first_error)
        return title, None
    if recorded:
        _release_floor(route)
    last_error = failures[-1] if failures else first_error
    report(last_error)
    return None, _failure_reason(last_error)


# ───── T1 ─────

def generate_title_for_request(message: Any) -> dict[str, Any]:
    """hermes-v051:T1 body of the bridge ``generate_title`` action (no session, no DB write)."""
    text = title_input_text(message)
    if not text.strip():
        return {"title": None, "reason": "empty_message"}
    if not title_model_upgrade_enabled():
        return {"title": None, "reason": "disabled"}
    title, reason = generate_title_with_reasoning_floor(text)
    if title and _is_provisional_title(title):
        return {"title": None, "reason": "provisional"}
    if not title:
        return {"title": None, "reason": reason or "no_title"}
    return {"title": title}


# ───── T2 ─────

def count_real_user_turns(messages: Any) -> int:
    if not isinstance(messages, list):
        return 0
    try:
        from agent.title_generator import _is_real_user_turn
    except Exception:
        _is_real_user_turn = None
    count = 0
    for message in messages:
        if _is_real_user_turn is not None:
            try:
                count += 1 if _is_real_user_turn(message) else 0
                continue
            except Exception:
                pass
        if isinstance(message, dict) and message.get("role") == "user" and str(message.get("content") or "").strip():
            count += 1
    return count


def _title_settled(session_db: Any, session_id: str) -> bool:
    """An ``llm``/``user`` title is final. A titled row without provenance (pre-provenance, or a
    store that cannot rank) counts as ``user`` like Hermes' own ranking; only untitled or
    ``derived`` rows are upgraded."""
    try:
        source_fn = getattr(session_db, "get_session_title_source", None)
        source = source_fn(session_id) if callable(source_fn) else None
        if source is not None:
            return source != "derived"
        return _has_title(session_db, session_id)
    except Exception:
        return True


def _has_title(session_db: Any, session_id: str) -> bool:
    try:
        return bool(str(session_db.get_session_title(session_id) or "").strip())
    except Exception:
        return True


def _agent_title_threads(session_id: str) -> list[Any] | None:
    """Alive Agent title-upgrade threads of this session (Hermes registers them in
    ``_UPGRADE_THREADS``, spawned with ``args=(session_db, session_id, user_message)``); None when
    that registry is unavailable."""
    try:
        from agent.title_generator import _UPGRADE_THREADS
    except Exception:
        return None
    alive = []
    try:
        for thread in list(_UPGRADE_THREADS):
            args = getattr(thread, "_args", ())
            if isinstance(args, tuple) and len(args) > 1 and args[1] == session_id and thread.is_alive():
                alive.append(thread)
    except Exception:
        return None
    return alive


def _wait_for_agent_title_upgrade(session_db: Any, session_id: str, timeout: float) -> bool:
    """hermes-v051:T2 R3-09 wait for this session only: poll its title every 0.5 s until it settles, no
    Agent upgrade of this session is in flight any more, or ``timeout``. True when the title settled.
    (Hermes' ``wait_for_title_upgrades`` joins every session's threads.)"""
    deadline = time.monotonic() + max(0.0, timeout)
    while True:
        own = _agent_title_threads(session_id)
        if _title_settled(session_db, session_id):
            return True
        if own is not None and not own:
            return False
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        time.sleep(min(AGENT_UPGRADE_POLL_SECONDS, remaining))


def _bind_title_accounting(session_db: Any, session_id: str) -> None:
    """Bill the call to the session like Hermes' own upgrade thread does (best effort)."""
    try:
        from agent.aux_accounting import set_accounting_context

        set_accounting_context(session_db, session_id)
    except Exception:
        pass
    try:
        from agent.portal_tags import set_conversation_context

        root = session_id
        try:
            root = session_db.get_conversation_root(session_id) or session_id
        except Exception:
            pass
        set_conversation_context(root)
    except Exception:
        pass


def _persist_llm_title(session_db: Any, session_id: str, title: str) -> Optional[str]:
    """Hermes' own provenance-checked write (never above a user title; dedupes ``#N``)."""
    try:
        from agent.title_generator import _persist_session_title
    except Exception:
        _persist_session_title = None
    if _persist_session_title is not None:
        return _persist_session_title(session_db, session_id, title, source="llm")
    setter = getattr(session_db, "set_auto_title", None)
    if callable(setter):
        return title if setter(session_id, title, source="llm") else None
    # No provenance-aware store: do not fall back to set_session_title (that is user authority).
    return None


def fallback_title_after_turn(
    session_db: Any,
    session_id: str,
    user_text: str,
    user_turns: int,
    *,
    main_runtime: Optional[dict] = None,
    on_title: Optional[Callable[[str], None]] = None,
    wait_timeout: float = AGENT_UPGRADE_WAIT_SECONDS,
) -> Optional[str]:
    """hermes-v051:T2 turn-end upgrade of a placeholder title. Never raises; failures are logged."""
    try:
        if session_db is None or not session_id or not str(user_text or "").strip():
            return None
        if _title_settled(session_db, session_id):
            return None
        if user_turns > MAX_PLACEHOLDER_TURNS and _has_title(session_db, session_id):
            return None
        if not title_model_upgrade_enabled():
            return None
        # The Agent started its own upgrade at turn start; once this worker learned the floor it
        # usually lands first. Do not race it with a duplicate model call.
        if _wait_for_agent_title_upgrade(session_db, session_id, wait_timeout):
            return None
        _bind_title_accounting(session_db, session_id)
        failures: list[BaseException] = []
        title, reason = generate_title_with_reasoning_floor(
            user_text,
            main_runtime=main_runtime,
            failure_callback=lambda _task, exc: failures.append(exc),
        )
        if not title:
            skipped = reason or "no_title"
        elif _is_provisional_title(title):
            skipped = "provisional"
        elif looks_like_answer_title(title):
            skipped = "answer_shaped"
        else:
            skipped = None
        if skipped:
            last = failures[-1] if failures else None
            _log("bridge.title.fallback_skipped", {
                "session_id": session_id,
                "reason": skipped,
                "error_type": type(last).__name__ if last is not None else None,
                "status": _exc_status(last),
            })
            return None
        persisted = _persist_llm_title(session_db, session_id, title)
        if not persisted:
            return None
        _log("bridge.title.fallback_generated", {"session_id": session_id, "chars": len(persisted)})
        if on_title is not None:
            on_title(persisted)
        return persisted
    except Exception as exc:
        _log("bridge.title.fallback_failed", {
            "session_id": session_id,
            "error_type": type(exc).__name__,
            "error": str(exc)[:300],
        })
        return None
