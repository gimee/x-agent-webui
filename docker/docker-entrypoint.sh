#!/bin/sh
# Container entrypoint: preserve the production memory and process lifecycle.
set -eu

# 1) 记忆锁（v0.1.2）：补丁已在构建期打进镜像（patch-memory-policy.sh v3），运行时按
#    ${HERMES_HOME}/.agent-memory-readonly 是否存在逐次判定，用户在 WebUI「记忆」页锁图标切换。
#    这里只做「首次启动种子」：实例从未初始化过（无 .agent-memory-lock-initialized 标记）时，
#    HERMES_MEMORY_DEFAULT_LOCK=1（兼容旧名 HERMES_MEMORY_READONLY=1）→ 创建锁文件；否则默认不锁。
#    之后无论环境变量怎样，都不再改动锁文件——锁不锁完全由用户决定。
mkdir -p "${HERMES_HOME}"
MEMORY_LOCK_FILE="${HERMES_HOME}/.agent-memory-readonly"
MEMORY_LOCK_INIT="${HERMES_HOME}/.agent-memory-lock-initialized"
if [ ! -f "$MEMORY_LOCK_INIT" ]; then
    if [ "${HERMES_MEMORY_DEFAULT_LOCK:-${HERMES_MEMORY_READONLY:-0}}" = "1" ]; then
        touch "$MEMORY_LOCK_FILE"
        echo "[entrypoint] memory lock seeded: LOCKED (first start, default lock requested)"
    elif [ -f "$MEMORY_LOCK_FILE" ]; then
        echo "[entrypoint] memory lock seeded: LOCKED (pre-existing lock file kept)"
    else
        echo "[entrypoint] memory lock seeded: UNLOCKED (default)"
    fi
    touch "$MEMORY_LOCK_INIT"
fi
if [ -f "$MEMORY_LOCK_FILE" ]; then
    echo "[entrypoint] memory lock: ON (agents cannot write MEMORY.md / USER.md)"
else
    echo "[entrypoint] memory lock: OFF"
fi

# 2) 清理陈旧 gateway pid，确保 logs 目录存在
PID_FILE="${HERMES_HOME}/gateway.pid"
[ -f "$PID_FILE" ] && rm -f "$PID_FILE" && echo "[entrypoint] Removed stale gateway.pid"
mkdir -p "${HERMES_HOME}/logs"

# 3) 失忆补丁复核（构建期已打进 bundle；这里只确认，缺了就补，失败只告警不阻塞）
AMNESIA_STATE="$(bash /opt/x-agent-patches/patch-amnesia.sh check 2>/dev/null || echo 'check-failed')"
case "$AMNESIA_STATE" in
    patched:*) echo "[entrypoint] amnesia patch OK" ;;
    *)
        if bash /opt/x-agent-patches/patch-amnesia.sh apply > /var/log/patch-amnesia.log 2>&1; then
            echo "[entrypoint] amnesia patch applied at startup"
        else
            echo "[entrypoint] WARNING: amnesia patch FAILED (state=$AMNESIA_STATE, see /var/log/patch-amnesia.log), WebUI starts unpatched"
        fi ;;
esac

# 4) Pi MCP Adapter：实例持久目录没有就从镜像种子复制（与「Agent 管理 → Pi → 安装」同一布局）。
PI_ADAPTER_DIR="${HERMES_WEB_UI_HOME}/coding-agent/pi-mcp-adapter"
if [ ! -f "${PI_ADAPTER_DIR}/node_modules/pi-mcp-adapter/index.ts" ] && [ -d "${HERMES_PI_SEED:-/nonexistent}" ]; then
    mkdir -p "$PI_ADAPTER_DIR"
    cp -a "${HERMES_PI_SEED}/." "$PI_ADAPTER_DIR/"
    echo "[entrypoint] Pi MCP Adapter seeded into ${PI_ADAPTER_DIR}"
fi

# 5) PID1 交给 Python supervisor：真正的异步信号处理，docker stop 时先停 gateway 再停 WebUI，
#    避免 shell 卡在 wait(2) 让 gateway 生命周期账本记成 UNCLEANLY。
exec python3 /usr/local/bin/hermes-entrypoint.py "$@"
