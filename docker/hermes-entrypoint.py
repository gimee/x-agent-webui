#!/usr/bin/env python3
"""PID 1 supervisor for the Hermes WebUI + gateway container.

The shell entrypoint performs the build-specific patch step, then execs this
process so Docker signals reach a real asynchronous signal handler.  This
avoids the POSIX shell trap/wait limitation where SIGTERM is not handled while
PID 1 is blocked in wait(2), which caused the gateway lifecycle ledger to
record false UNCLEANLY exits.
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import TextIO

HERMES_HOME = Path(os.environ.get("HERMES_HOME", "/home/agent/.hermes"))
GATEWAY_LOG = HERMES_HOME / "logs" / "gateway.log"

GATEWAY_RESTART_DELAY_S = 3.0
# hermes-v050:S1 A clean exit within seconds means another gateway already serves this host
# ("nothing to start"); back off 3s -> 60s instead of respawning it every ~6.5s forever.
GATEWAY_FAST_EXIT_S = 15.0
GATEWAY_MAX_RESTART_DELAY_S = 60.0
# hermes-v050:F-02 The WebUI writes this (epoch seconds) right before its `gateway stop` of the
# gateway we own: that exit is a requested restart, so respawn after 1s and clear the backoff.
# Older than a minute means that stop never made the gateway exit; it is then ignored.
GATEWAY_PLANNED_RESTART_MARKER = HERMES_HOME / ".pid1-planned-gateway-restart"
GATEWAY_PLANNED_RESTART_DELAY_S = 1.0
GATEWAY_PLANNED_RESTART_MAX_AGE_S = 60.0

stopping = False
webui: subprocess.Popen[bytes] | None = None
gateway: subprocess.Popen[bytes] | None = None
gateway_log: TextIO | None = None


def log(message: str) -> None:
    print(f"[entrypoint] {message}", flush=True)


def terminate_group(proc: subprocess.Popen[bytes] | None, label: str) -> None:
    if proc is None or proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        log(f"sent SIGTERM to {label} process group pgid={proc.pid}")
    except ProcessLookupError:
        pass
    except OSError as exc:
        log(f"WARNING: could not stop {label} process group: {exc}")


def force_kill_group(proc: subprocess.Popen[bytes] | None, label: str) -> None:
    if proc is None or proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGKILL)
        log(f"WARNING: forced SIGKILL for {label} process group pgid={proc.pid}")
    except ProcessLookupError:
        pass
    except OSError as exc:
        log(f"WARNING: could not force-stop {label} process group: {exc}")


def request_shutdown(signum: int, _frame: object) -> None:
    global stopping
    if stopping:
        return
    stopping = True
    log(f"shutdown requested signal={signal.Signals(signum).name}; stopping WebUI and gateway gracefully")
    # Gateway first: its own shutdown path flushes lifecycle/session state.
    terminate_group(gateway, "gateway")
    terminate_group(webui, "WebUI")


def start_gateway() -> subprocess.Popen[bytes]:
    global gateway_log
    GATEWAY_LOG.parent.mkdir(parents=True, exist_ok=True)
    if gateway_log is not None:
        gateway_log.close()
        gateway_log = None
    gateway_log = GATEWAY_LOG.open("ab", buffering=0)
    env = os.environ.copy()
    env["HERMES_HOME"] = str(HERMES_HOME)
    env["HERMES_ALLOW_ROOT_GATEWAY"] = "1"
    env["HERMES_GATEWAY_NO_SUPERVISE"] = "1"
    return subprocess.Popen(
        ["/opt/hermes/.venv/bin/hermes", "gateway", "run", "--no-supervise"],
        stdout=gateway_log,
        stderr=subprocess.STDOUT,
        env=env,
        start_new_session=True,
    )


def next_gateway_restart_delay(rc: int, ran_for: float, previous_delay: float) -> float:
    if rc != 0 or ran_for >= GATEWAY_FAST_EXIT_S:
        return GATEWAY_RESTART_DELAY_S
    return min(max(previous_delay * 2, GATEWAY_RESTART_DELAY_S), GATEWAY_MAX_RESTART_DELAY_S)


# hermes-v050:F-02 Consume the marker; True only if it is fresh.
def planned_gateway_restart_requested(now: float | None = None) -> bool:
    try:
        raw = GATEWAY_PLANNED_RESTART_MARKER.read_text(encoding="utf-8").strip()
    except OSError:
        return False
    try:
        GATEWAY_PLANNED_RESTART_MARKER.unlink()
    except OSError:
        pass
    try:
        age = (time.time() if now is None else now) - float(raw)
    except ValueError:
        age = float("inf")
    if -5.0 <= age <= GATEWAY_PLANNED_RESTART_MAX_AGE_S:
        log("planned gateway restart requested by the WebUI")
        return True
    log("WARNING: ignoring a stale planned-restart marker")
    return False


# hermes-v050:F-02 (seconds until the respawn, backoff carried to the next exit).
def gateway_exit_restart_plan(rc: int, ran_for: float, previous_delay: float, now: float | None = None) -> tuple[float, float]:
    if planned_gateway_restart_requested(now):
        return GATEWAY_PLANNED_RESTART_DELAY_S, 0.0
    delay = next_gateway_restart_delay(rc, ran_for, previous_delay)
    return delay, delay


# hermes-v050:F-02 A restart requested while we back off (gateway already down) cuts the wait
# to 1s. Returns whether that happened, so the caller clears the backoff too.
def sleep_until_gateway_restart(wait_s: float) -> bool:
    planned = False
    deadline = time.monotonic() + wait_s
    while not stopping and time.monotonic() < deadline:
        if planned_gateway_restart_requested():
            planned = True
            deadline = min(deadline, time.monotonic() + GATEWAY_PLANNED_RESTART_DELAY_S)
        time.sleep(0.1)
    return planned


def wait_for_shutdown(timeout: float = 30.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        web_done = webui is None or webui.poll() is not None
        gateway_done = gateway is None or gateway.poll() is not None
        if web_done and gateway_done:
            return
        time.sleep(0.1)
    force_kill_group(gateway, "gateway")
    force_kill_group(webui, "WebUI")
    for proc in (gateway, webui):
        if proc is not None and proc.poll() is None:
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass


def main() -> int:
    global stopping, webui, gateway
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGQUIT):
        signal.signal(signum, request_shutdown)

    log(f"Starting WebUI on 0.0.0.0:{os.environ.get('PORT', '6060')}...")
    # hermes-v050:S1 This supervisor owns the default profile's gateway. Without this the WebUI
    # autostart also runs `gateway run --replace` for it and the two owners take turns forever.
    webui_env = os.environ.copy()
    webui_env["HERMES_WEB_UI_EXTERNAL_GATEWAY_PROFILES"] = "default"
    webui = subprocess.Popen(
        ["node", "dist/server/index.js", *sys.argv[1:]],
        env=webui_env,
        start_new_session=True,
    )
    log("hermes gateway supervisor starting...")
    gateway = start_gateway()
    gateway_started = time.monotonic()
    restart_delay = 0.0
    log("hermes gateway starting...")
    log(f"WebUI: http://0.0.0.0:{os.environ.get('PORT', '6060')}")

    webui_rc = 0
    try:
        while not stopping:
            webui_rc_now = webui.poll()
            if webui_rc_now is not None:
                webui_rc = webui_rc_now
                log(f"WebUI exited rc={webui_rc}; stopping gateway")
                stopping = True
                terminate_group(gateway, "gateway")
                break

            gateway_rc = gateway.poll()
            if gateway_rc is not None:
                wait_s, restart_delay = gateway_exit_restart_plan(gateway_rc, time.monotonic() - gateway_started, restart_delay)
                log(f"gateway exited rc={gateway_rc}, restarting in {wait_s:.0f}s...")
                if sleep_until_gateway_restart(wait_s):
                    restart_delay = 0.0
                if stopping:
                    break
                gateway = start_gateway()
                gateway_started = time.monotonic()
                log("hermes gateway restarted")
            time.sleep(0.1)
    finally:
        if stopping:
            terminate_group(gateway, "gateway")
            terminate_group(webui, "WebUI")
            wait_for_shutdown()
        if webui is not None and webui.poll() is not None:
            webui_rc = webui.returncode or 0
        if gateway_log is not None:
            gateway_log.close()

    if stopping:
        log("shutdown complete")
        return 0
    return webui_rc


if __name__ == "__main__":
    raise SystemExit(main())
