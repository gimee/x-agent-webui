#!/usr/bin/env bash
# hermes-memory-policy-v3: 记忆锁（用户可控）。
#
# v2 是无条件硬禁：agent 永远不能写 MEMORY.md / USER.md。
# v3 改为「锁文件存在才禁」：${HERMES_HOME}/.agent-memory-readonly 存在 → 所有写操作
# (add/replace/remove/batch) 被拒绝，且拒绝暂存重放；文件不存在 → 与上游行为完全一致。
# 锁文件由 WebUI「记忆 → 我的笔记」旁的锁图标切换（GET/PUT /api/hermes/memory/lock），
# 每次调用都重新判定，切换即时生效、无需重启。
#
# 构建期在 Dockerfile 里执行一次打进镜像（幂等；锚点漂移直接 fail-closed 停止构建）。
# 只改 /opt/hermes/tools/memory_tool.py。
set -euo pipefail

python3 - <<'PY'
import os
from pathlib import Path

ROOT = Path(os.environ.get('HERMES_ROOT', '/opt/hermes'))


def replace_once(path: Path, old: str, new: str, marker: str) -> None:
    text = path.read_text(encoding='utf-8')
    if marker in text:
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one patch anchor, found {count}: {marker}')
    path.write_text(text.replace(old, new, 1), encoding='utf-8')

memory = ROOT / 'tools/memory_tool.py'
if '_MEMORY_READONLY_ERROR = (' in memory.read_text(encoding='utf-8') and 'hermes-memory-policy-v3' not in memory.read_text(encoding='utf-8'):
    raise SystemExit(f'{memory}: has the old v2 unconditional patch; rebuild from a clean upstream file')

# 1) 锁判定 + 错误文本，放在 store re-export 之后。
replace_once(
    memory,
    '''from tools.memory_tool_store import (  # noqa: E402,F401  (re-exports)
    ENTRY_DELIMITER, MEMORY_BLOCK_HEADERS, MemoryStore, _scan_memory_content)


def load_on_disk_store() -> "MemoryStore":
''',
    '''from tools.memory_tool_store import (  # noqa: E402,F401  (re-exports)
    ENTRY_DELIMITER, MEMORY_BLOCK_HEADERS, MemoryStore, _scan_memory_content)

# hermes-memory-policy-v3: user-controlled memory lock.  While
# ${HERMES_HOME}/.agent-memory-readonly exists, every agent-initiated mutation of
# MEMORY.md / USER.md is rejected (no approval flow).  The user toggles the lock
# from the Hermes WebUI (Memory → lock icon); the file is re-checked on every
# call so toggling takes effect immediately.
_MEMORY_LOCK_FILE = ".agent-memory-readonly"
_MEMORY_READONLY_ERROR = (
    "Global memory is locked by the user (memory lock enabled in the Hermes WebUI). "
    "Do not retry with any write action and do not ask the user to approve one. "
    "Persist durable notes in the active skill instead; the user can unlock memory "
    "from the WebUI Memory page if they want agents to write it."
)


def _memory_locked() -> bool:
    try:
        return (get_hermes_home() / _MEMORY_LOCK_FILE).exists()
    except Exception:
        return False


def _memory_write_policy_error(action: Any) -> Optional[str]:
    """Reject agent-initiated mutation of global memory while the lock is on."""
    if _memory_locked() and action in {"add", "replace", "remove", "batch"}:
        return tool_error(_MEMORY_READONLY_ERROR, success=False)
    return None


def load_on_disk_store() -> "MemoryStore":
''',
    'hermes-memory-policy-v3',
)

# 2) 工具入口：target 校验之后、batch/单操作路径之前判定。
replace_once(
    memory,
    '''    target_error = _memory_target_error(store, target)
    if target_error is not None:
        return json.dumps(target_error)
    if operations:
        if not isinstance(operations, list):
''',
    '''    target_error = _memory_target_error(store, target)
    if target_error is not None:
        return json.dumps(target_error)

    # hermes-memory-policy-v3: memory lock gate, evaluated before anything that
    # could mutate or stage a write.  A non-empty operations list is a mutation.
    if operations and _memory_locked():
        return tool_error(_MEMORY_READONLY_ERROR, success=False)
    policy_error = _memory_write_policy_error(action)
    if policy_error is not None:
        return policy_error
    if operations:
        if not isinstance(operations, list):
''',
    'memory lock gate',
)

# 3) 工具描述：保留上游全文，只追加锁说明。
replace_once(
    memory,
    '''        "SKIP: trivial/obvious info, easily re-discovered facts, raw data dumps, task progress, "
        "completed-work logs, temporary TODO state (use session_search for those). Reusable "
        "procedures belong in a skill, not memory."
    ),
''',
    '''        "SKIP: trivial/obvious info, easily re-discovered facts, raw data dumps, task progress, "
        "completed-work logs, temporary TODO state (use session_search for those). Reusable "
        "procedures belong in a skill, not memory.\\n\\n"
        "LOCK: the user may lock global memory from the Hermes WebUI (Memory page lock "
        "icon). While locked, every write action is rejected with no approval flow; do not "
        "retry or ask for approval, persist in the active skill instead."
    ),
''',
    'LOCK: the user may lock global memory',
)

# 4) 暂存重放：锁定时拒绝，未锁定保持上游原样。
replace_once(
    memory,
    '''    action, target = payload.get("action"), payload.get("target", "memory")
    target_error = _memory_target_error(store, target)
''',
    '''    action, target = payload.get("action"), payload.get("target", "memory")
    # hermes-memory-policy-v3: a staged write must not bypass the user's lock.
    if _memory_locked() and action in {"add", "replace", "remove", "batch"}:
        return {"success": False, "error": _MEMORY_READONLY_ERROR}
    target_error = _memory_target_error(store, target)
''',
    'a staged write must not bypass',
)

print('hermes memory policy v3 patch applied')
PY

PYTHONPATH=/opt/hermes python3 -m py_compile "${HERMES_ROOT:-/opt/hermes}/tools/memory_tool.py"
