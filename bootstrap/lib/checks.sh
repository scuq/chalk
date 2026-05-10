#!/usr/bin/env bash
# bootstrap/lib/checks.sh
# Host environment checks. Sourced by phase scripts that need them.

# Note: common.sh must be sourced first.

check_command() {
  local cmd="$1" hint="${2:-}"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log_err "missing required command: $cmd"
    [ -n "$hint" ] && log_err "  $hint"
    return 1
  fi
}

check_go_version() {
  local min="${1:-1.23}"
  if ! command -v go >/dev/null 2>&1; then
    log_err "missing required command: go"
    return 1
  fi
  local v
  v="$(go version | awk '{print $3}' | sed 's/go//')"
  if ! printf '%s\n%s\n' "$min" "$v" | sort -V -C; then
    log_err "go ${min}+ required (found ${v})"
    return 1
  fi
}

check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    log_err "missing required command: docker"
    log_err "  install: https://docs.docker.com/get-docker/"
    return 1
  fi
  if ! docker info >/dev/null 2>&1; then
    log_err "docker daemon not reachable"
    log_err "  is the docker daemon running and your user in the docker group?"
    return 1
  fi
}

check_os() {
  case "$(uname -s)" in
    Linux|Darwin) ;;
    *) log_warn "untested OS: $(uname -s); proceed at your own risk" ;;
  esac
}

# Run all the standard checks for a phase that needs Go + Docker.
checks_go_docker() {
  local fail=0
  check_os
  check_go_version 1.23 || fail=1
  check_docker || fail=1
  [ "$fail" = "0" ] || die "host environment checks failed"
}

# Just Go.
checks_go() {
  check_os
  check_go_version 1.23 || die "go check failed"
}
