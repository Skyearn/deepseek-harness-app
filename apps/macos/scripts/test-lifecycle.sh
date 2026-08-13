#!/usr/bin/env bash
# End-to-end lifecycle test for the DeepSeek Harness macOS shell.
#
# Phase 1: launch the app on a test port with a workspace-local DSH_HOME and
# state dir; verify the server comes up (lock file, then port); SIGTERM the app
# and verify the port is released, the server's process group is dead, and the
# lock file is gone.
# Phase 2: SIGKILL the app, confirm the orphaned server survives, relaunch and
# confirm recovery reclaims the orphan, then quit cleanly.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_BIN="$SCRIPT_DIR/../build/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
TEST_PORT=3199
STATE_DIR="$REPO_ROOT/.cache/shell-state"
TEST_DSH_HOME="$REPO_ROOT/.cache/shell-dsh-home"
LOG=/tmp/dsh-shell-test.log
APP_PID=""

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

cleanup() {
  [ -n "$APP_PID" ] && kill -9 "$APP_PID" 2>/dev/null
  [ -n "${ORPHAN_PID:-}" ] && kill -9 "$ORPHAN_PID" 2>/dev/null
  # Kill whatever server the lock records (whole process group), so a failed
  # run can never leave the test port occupied for the next run.
  if [ -f "$STATE_DIR/server.pid" ]; then
    local sp
    sp=$(awk '{print $1}' "$STATE_DIR/server.pid" 2>/dev/null)
    [ -n "$sp" ] && { kill -9 -- "-$sp" 2>/dev/null; kill -9 "$sp" 2>/dev/null; }
  fi
}
trap cleanup EXIT

# wait_for <port> <open|closed> <timeout_s> — probe with the shell's own --resolve
wait_for() {
  local port=$1 want=$2 timeout=${3:-60} waited=0 got
  while [ "$waited" -lt $((timeout * 10)) ]; do
    got=$("$APP_BIN" -port "$port" --resolve 2>/dev/null | sed -n 's/^portOpen=//p')
    if { [ "$want" = open ] && [ "$got" = true ]; } || { [ "$want" = closed ] && [ "$got" = false ]; }; then
      return 0
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  return 1
}

# wait_lock <timeout_s> [exclude_pid] — waits for the app to write its
# server.pid lock; when exclude_pid is given, ignores a lock still recording
# that pid (a stale lock from a previous instance before recovery removes it).
wait_lock() {
  local timeout=${1:-120} exclude=${2:-} waited=0 pid
  while [ "$waited" -lt $((timeout * 10)) ]; do
    if [ -f "$STATE_DIR/server.pid" ]; then
      pid=$(awk '{print $1}' "$STATE_DIR/server.pid" 2>/dev/null)
      if [ -z "$exclude" ] || [ "$pid" != "$exclude" ]; then
        return 0
      fi
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  return 1
}

launch_app() {
  DSH_HOME="$TEST_DSH_HOME" "$APP_BIN" -port "$TEST_PORT" -stateDir "$STATE_DIR" -openBrowserOnLaunch 0 >"$LOG" 2>&1 &
  APP_PID=$!
  echo "app pid=$APP_PID"
}

# --- Phase 1: graceful quit ---------------------------------------------------
echo "==> phase 1: graceful quit"
rm -rf "$STATE_DIR" "$TEST_DSH_HOME"
mkdir -p "$STATE_DIR"

launch_app
wait_lock 120 || fail "phase 1: no server.pid lock within 120s (log: $(tail -5 "$LOG"))"
SERVER_PID=$(awk '{print $1}' "$STATE_DIR/server.pid")
[ -n "$SERVER_PID" ] || fail "phase 1: server.pid has no pid"
kill -0 "$SERVER_PID" 2>/dev/null || fail "phase 1: server process $SERVER_PID not alive"
pass "phase 1: server process $SERVER_PID alive, lock file present"

wait_for "$TEST_PORT" open 60 || fail "phase 1: port did not open"
pass "phase 1: server opened port $TEST_PORT"

echo "==> phase 1: sending SIGTERM to the app (quit path)"
kill -TERM "$APP_PID"
wait "$APP_PID" 2>/dev/null
echo "phase 1: app exited with code $?"
APP_PID=""

wait_for "$TEST_PORT" closed 30 || fail "phase 1: port still open after app exit"
pass "phase 1: port released after quit"

if kill -0 "$SERVER_PID" 2>/dev/null; then
  fail "phase 1: server process $SERVER_PID still alive after app exit"
fi
pass "phase 1: server process $SERVER_PID gone after quit"

if [ -f "$STATE_DIR/server.pid" ]; then
  fail "phase 1: server.pid lock not removed after quit"
fi
pass "phase 1: server.pid lock removed after quit"

# --- Phase 2: crash recovery ---------------------------------------------------
echo
echo "==> phase 2: crash recovery (SIGKILL leaves an orphaned server)"
rm -rf "$STATE_DIR" "$TEST_DSH_HOME"
mkdir -p "$STATE_DIR"

launch_app
wait_lock 120 || fail "phase 2: no server.pid lock"
ORPHAN_PID=$(awk '{print $1}' "$STATE_DIR/server.pid")
wait_for "$TEST_PORT" open 60 || fail "phase 2: port did not open"
pass "phase 2: server running (pid $ORPHAN_PID)"

echo "==> phase 2: SIGKILL the app (simulated crash)"
kill -9 "$APP_PID"
wait "$APP_PID" 2>/dev/null
APP_PID=""
sleep 1

kill -0 "$ORPHAN_PID" 2>/dev/null || fail "phase 2: orphan server $ORPHAN_PID died unexpectedly"
pass "phase 2: orphaned server $ORPHAN_PID survives the app crash (port still open)"

echo "==> phase 2: relaunching the app (recovery should reclaim the orphan)"
launch_app
wait_lock 120 "$ORPHAN_PID" || fail "phase 2: no new server.pid lock"
NEW_PID=$(awk '{print $1}' "$STATE_DIR/server.pid")
wait_for "$TEST_PORT" open 60 || fail "phase 2: port did not reopen"
sleep 2

if kill -0 "$ORPHAN_PID" 2>/dev/null; then
  fail "phase 2: orphaned server $ORPHAN_PID was not reclaimed"
fi
pass "phase 2: orphaned server $ORPHAN_PID reclaimed"
kill -0 "$NEW_PID" 2>/dev/null || fail "phase 2: new server process $NEW_PID not alive"
pass "phase 2: new server running (pid $NEW_PID), port open"

kill -TERM "$APP_PID"
wait "$APP_PID" 2>/dev/null
APP_PID=""
wait_for "$TEST_PORT" closed 30 || fail "phase 2: port still open after quit"
pass "phase 2: port released after quit"

trap - EXIT
echo "==> all lifecycle tests passed"
