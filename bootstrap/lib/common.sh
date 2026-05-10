#!/usr/bin/env bash
# bootstrap/lib/common.sh
# Shared helpers for all phase scripts. Sourced, not executed.

set -euo pipefail

# ---- Repository root detection -------------------------------------------
if [ -z "${CHALK_REPO_ROOT:-}" ]; then
  CHALK_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  export CHALK_REPO_ROOT
fi

# ---- Bash version check --------------------------------------------------
# We require bash 5.x for associative arrays, ${var^^}, and improved trap
# handling. macOS ships bash 3.2 by default; users must install via brew.
_chalk_check_bash() {
  if [ "${BASH_VERSINFO[0]:-0}" -lt 5 ]; then
    echo "error: chalk bootstrap requires bash 5.x or newer (found $BASH_VERSION)" >&2
    echo "  macOS:  brew install bash" >&2
    echo "  Linux:  use your distro's bash 5+ package" >&2
    exit 2
  fi
}
_chalk_check_bash

# ---- Colors --------------------------------------------------------------
if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
  C_CYAN=$'\033[36m'
else
  C_RESET="" C_BOLD="" C_DIM="" C_RED="" C_GREEN="" C_YELLOW="" C_BLUE="" C_CYAN=""
fi

# ---- Logging -------------------------------------------------------------
CHALK_QUIET="${CHALK_QUIET:-0}"
CHALK_DRY_RUN="${CHALK_DRY_RUN:-0}"

log_info()  { [ "$CHALK_QUIET" = "1" ] || printf '%b\n' "${C_CYAN}»${C_RESET} $*"; }
log_step()  { [ "$CHALK_QUIET" = "1" ] || printf '%b\n' "${C_BLUE}  ›${C_RESET} $*"; }
log_ok()    { printf '%b\n' "${C_GREEN}✓${C_RESET} $*"; }
log_warn()  { printf '%b\n' "${C_YELLOW}!${C_RESET} $*" >&2; }
log_err()   { printf '%b\n' "${C_RED}✗${C_RESET} $*" >&2; }
log_dry()   { [ "$CHALK_QUIET" = "1" ] || printf '%b\n' "${C_DIM}[dry-run]${C_RESET} $*"; }

die() { log_err "$*"; exit 1; }

# ---- Phase markers -------------------------------------------------------
_marker_dir() { echo "${CHALK_REPO_ROOT}/.bootstrap"; }
_marker_for() { echo "$(_marker_dir)/phase-${1}.done"; }

phase_is_done() {
  local p="$1"
  [ -f "$(_marker_for "$p")" ]
}

phase_mark_done() {
  local p="$1"
  mkdir -p "$(_marker_dir)"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$(_marker_for "$p")"
}

phase_unmark() {
  local p="$1"
  rm -f "$(_marker_for "$p")"
}

# ---- Phase lifecycle -----------------------------------------------------
PHASE_CURRENT=""

phase_begin() {
  local p="$1" name="$2"
  PHASE_CURRENT="$p"
  printf '\n%b\n' "${C_BOLD}━━━ phase ${p}: ${name} ━━━${C_RESET}"
  if phase_is_done "$p" && [ "${CHALK_FORCE:-0}" != "1" ]; then
    log_ok "phase ${p} already done (skipping; use --force to rerun)"
    exit 0
  fi
}

phase_step() {
  log_step "$*"
}

phase_done() {
  local p="$1"
  if [ "$CHALK_DRY_RUN" = "1" ]; then
    log_dry "would mark phase ${p} done"
    return 0
  fi
  phase_mark_done "$p"
  log_ok "phase ${p} complete"
}

require_phase() {
  local p="$1"
  if ! phase_is_done "$p"; then
    die "phase ${p} must be completed first (run bootstrap/phase-${p}-*.sh)"
  fi
}

# ---- File helpers --------------------------------------------------------
write_file_if_absent() {
  # Usage: write_file_if_absent <path> <<'EOF' ... EOF
  local target="$1"
  if [ -f "$target" ]; then
    log_step "exists: ${target} (kept)"
    cat > /dev/null  # consume stdin
    return 0
  fi
  if [ "$CHALK_DRY_RUN" = "1" ]; then
    log_dry "would create: ${target}"
    cat > /dev/null
    return 0
  fi
  mkdir -p "$(dirname "$target")"
  cat > "$target"
  log_step "created: ${target}"
}

write_file_force() {
  # Usage: write_file_force <path> <<'EOF' ... EOF
  local target="$1"
  if [ "$CHALK_DRY_RUN" = "1" ]; then
    log_dry "would write: ${target}"
    cat > /dev/null
    return 0
  fi
  mkdir -p "$(dirname "$target")"
  cat > "$target"
  log_step "wrote: ${target}"
}

ensure_dir() {
  local d="$1"
  if [ "$CHALK_DRY_RUN" = "1" ]; then
    log_dry "would mkdir -p ${d}"
    return 0
  fi
  mkdir -p "$d"
}

# ---- Git helpers ---------------------------------------------------------
git_inited() {
  git -C "$CHALK_REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1
}

git_commit_phase() {
  local p="$1" name="$2"
  if ! git_inited; then
    log_warn "no git repo; skipping commit"
    return 0
  fi
  if [ "$CHALK_DRY_RUN" = "1" ]; then
    log_dry "would commit phase ${p}: ${name}"
    return 0
  fi
  cd "$CHALK_REPO_ROOT"
  if git diff --quiet && git diff --cached --quiet; then
    log_step "nothing to commit"
    return 0
  fi
  git add -A
  git commit -m "bootstrap(phase-${p}): ${name}" >/dev/null
  log_step "committed phase ${p}"
}

# ---- Sourceable libs (lazy) ----------------------------------------------
_chalk_lib_dir() { echo "${CHALK_REPO_ROOT}/bootstrap/lib"; }

# Source another lib file by name (without extension).
chalk_use_lib() {
  local lib="$1"
  # shellcheck disable=SC1090
  . "$(_chalk_lib_dir)/${lib}.sh"
}
