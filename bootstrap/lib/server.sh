#!/usr/bin/env bash
# bootstrap/lib/server.sh
# Helpers to run chalkd as a background process during phase tests.
#
# Single-server API (back-compatible with phase 04):
#   server_up [extra-flags...]   -- start + wait for ready
#   server_stop
#   server_dump_logs
# Reads:  CHALK_TEST_BIN, CHALK_TEST_PGURL
# Writes: CHALK_TEST_PID, CHALK_TEST_ADDR, CHALK_TEST_HTTP, CHALK_TEST_WS,
#         CHALK_TEST_LOG_FILE, CHALK_TEST_LISTEN_INFO_FILE
#
# Multi-server API (phase 05):
#   server_up_n N [extra-flags...]
#   server_stop_n N
#   server_stop_all          -- stops every started instance
# Per-N variables: CHALK_TEST_PID_<N>, CHALK_TEST_ADDR_<N>, CHALK_TEST_HTTP_<N>,
#                  CHALK_TEST_WS_<N>, CHALK_TEST_LOG_FILE_<N>
#
# Both APIs coexist; phase 04's tests still work, phase 05+ uses the
# indexed API.

# common.sh + postgres.sh must be sourced first.

CHALK_TEST_BIN="${CHALK_TEST_BIN:-${CHALK_REPO_ROOT}/bin/chalkd}"
CHALK_TEST_INSTANCES_STARTED=()

# ---- internal: indexed start/wait/stop -----------------------------------

_server_var() {
  # Usage: _server_var <prefix> <N>   -> echoes the variable name (no value)
  echo "CHALK_TEST_${1}_${2}"
}

_server_set_var() {
  # Usage: _server_set_var <prefix> <N> <value>
  local name
  name="$(_server_var "$1" "$2")"
  printf -v "$name" '%s' "$3"
  export "$name"
}

_server_get_var() {
  # Usage: _server_get_var <prefix> <N>   -> echoes the value
  local name
  name="$(_server_var "$1" "$2")"
  echo "${!name:-}"
}

_server_unset_n() {
  local n="$1"
  local prefix
  for prefix in PID ADDR HTTP WS LOG_FILE LISTEN_INFO_FILE INSTANCE_ID; do
    unset "$(_server_var "$prefix" "$n")"
  done
}

# server_start_n N [flags...] -- start chalkd #N. Does NOT wait for ready.
server_start_n() {
  local n="$1"
  shift

  if [ -z "${CHALK_TEST_PGURL:-}" ]; then
    die "server_start_n: CHALK_TEST_PGURL not set (run pg_start_ephemeral first)"
  fi
  if [ ! -x "$CHALK_TEST_BIN" ]; then
    die "server_start_n: missing binary at ${CHALK_TEST_BIN}"
  fi

  local listen_info logf instance_id
  listen_info="$(mktemp -t "chalk-listen-${n}.XXXXXX")"
  logf="$(mktemp -t "chalk-log-${n}.XXXXXX")"
  instance_id="phase-test-${n}"

  _server_set_var LISTEN_INFO_FILE "$n" "$listen_info"
  _server_set_var LOG_FILE "$n" "$logf"
  _server_set_var INSTANCE_ID "$n" "$instance_id"

  log_step "starting chalkd #${n} (logs: ${logf})"
  CHALK_DB_URL="$CHALK_TEST_PGURL" \
    "$CHALK_TEST_BIN" \
      --listen=127.0.0.1:0 \
      --tls-mode=off \
      --listen-info-file="$listen_info" \
      --instance-id="$instance_id" \
      --log-format=console \
      --log-level=info \
      "$@" \
      >"$logf" 2>&1 &
  local pid=$!
  _server_set_var PID "$n" "$pid"
  CHALK_TEST_INSTANCES_STARTED+=("$n")
}

# server_ready_n N [timeout=10] -- wait until chalkd #N is listening.
server_ready_n() {
  local n="$1"
  local timeout="${2:-10}"
  local pid logf info
  pid="$(_server_get_var PID "$n")"
  logf="$(_server_get_var LOG_FILE "$n")"
  info="$(_server_get_var LISTEN_INFO_FILE "$n")"

  local deadline
  deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      log_warn "chalkd #${n} exited during startup; logs:"
      tail -n 50 "$logf" >&2 || true
      die "chalkd #${n} died before becoming ready"
    fi
    if [ -s "$info" ]; then
      local addr
      addr="$(tr -d '[:space:]' <"$info")"
      if [ -n "$addr" ]; then
        _server_set_var ADDR "$n" "$addr"
        _server_set_var HTTP "$n" "http://${addr}"
        _server_set_var WS   "$n" "ws://${addr}/ws"
        log_step "chalkd #${n} ready on ${addr}"
        return 0
      fi
    fi
    sleep 0.1
  done

  log_warn "chalkd #${n} not ready in ${timeout}s; logs:"
  tail -n 50 "$logf" >&2 || true
  die "chalkd #${n} did not become ready"
}

# server_up_n N [flags...] -- start + wait for ready.
server_up_n() {
  server_start_n "$@"
  server_ready_n "$1"
}

# server_stop_n N -- clean SIGTERM.
server_stop_n() {
  local n="$1"
  local pid logf info
  pid="$(_server_get_var PID "$n")"
  logf="$(_server_get_var LOG_FILE "$n")"
  info="$(_server_get_var LISTEN_INFO_FILE "$n")"

  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    log_step "stopping chalkd #${n} (pid ${pid})"
    kill -TERM "$pid" 2>/dev/null || true
    local i
    for i in $(seq 1 50); do
      if ! kill -0 "$pid" 2>/dev/null; then
        break
      fi
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      log_warn "chalkd #${n} did not exit on SIGTERM; sending SIGKILL"
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi

  [ -n "$info" ] && rm -f "$info"
  if [ "${CHALK_KEEP_LOGS:-0}" != "1" ]; then
    [ -n "$logf" ] && rm -f "$logf"
  fi
  _server_unset_n "$n"
}

server_stop_all() {
  local n
  for n in "${CHALK_TEST_INSTANCES_STARTED[@]}"; do
    server_stop_n "$n"
  done
  CHALK_TEST_INSTANCES_STARTED=()
}

server_dump_logs_n() {
  local n="$1"
  local logf
  logf="$(_server_get_var LOG_FILE "$n")"
  if [ -n "$logf" ] && [ -f "$logf" ]; then
    log_warn "--- chalkd #${n} logs (${logf}) ---"
    tail -n 80 "$logf" >&2 || true
    log_warn "--- end logs ---"
  fi
}

server_dump_all_logs() {
  local n
  for n in "${CHALK_TEST_INSTANCES_STARTED[@]}"; do
    server_dump_logs_n "$n"
  done
}

# ---- back-compat single-server API (phase 04) ----------------------------

# These delegate to instance "1" so phase-04 callers keep working.

server_start() { server_start_n 1 "$@"; _server_export_legacy 1; }
server_ready() { server_ready_n 1 "${1:-10}"; _server_export_legacy 1; }
server_up()    { server_up_n 1 "$@"; _server_export_legacy 1; }
server_stop()  { server_stop_n 1; _server_unexport_legacy; }
server_dump_logs() { server_dump_logs_n 1; }

_server_export_legacy() {
  local n="$1"
  CHALK_TEST_PID="$(_server_get_var PID "$n")"
  CHALK_TEST_ADDR="$(_server_get_var ADDR "$n")"
  CHALK_TEST_HTTP="$(_server_get_var HTTP "$n")"
  CHALK_TEST_WS="$(_server_get_var WS "$n")"
  CHALK_TEST_LOG_FILE="$(_server_get_var LOG_FILE "$n")"
  CHALK_TEST_LISTEN_INFO_FILE="$(_server_get_var LISTEN_INFO_FILE "$n")"
  export CHALK_TEST_PID CHALK_TEST_ADDR CHALK_TEST_HTTP CHALK_TEST_WS \
         CHALK_TEST_LOG_FILE CHALK_TEST_LISTEN_INFO_FILE
}

_server_unexport_legacy() {
  unset CHALK_TEST_PID CHALK_TEST_ADDR CHALK_TEST_HTTP CHALK_TEST_WS \
        CHALK_TEST_LOG_FILE CHALK_TEST_LISTEN_INFO_FILE
}
