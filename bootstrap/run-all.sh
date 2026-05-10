#!/usr/bin/env bash
# bootstrap/run-all.sh
# Run every phase script in order, idempotently.
#
# Usage:
#   bootstrap/run-all.sh                # resume from where we left off
#   bootstrap/run-all.sh --from 05      # rerun 05 onwards
#   bootstrap/run-all.sh --only 07      # rerun a single phase
#   bootstrap/run-all.sh --dry-run      # show plan, no side effects
#   bootstrap/run-all.sh --force        # rerun all phases regardless of markers

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

FROM=""
ONLY=""
FORCE=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --from)    FROM="$2"; shift 2 ;;
    --only)    ONLY="$2"; shift 2 ;;
    --force)   FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *) die "unknown flag: $1" ;;
  esac
done

[ "$DRY_RUN" = "1" ] && export CHALK_DRY_RUN=1
[ "$FORCE" = "1" ]   && export CHALK_FORCE=1

# Discover phase scripts in order.
shopt -s nullglob
PHASE_SCRIPTS=("${SCRIPT_DIR}"/phase-*.sh)
shopt -u nullglob

if [ ${#PHASE_SCRIPTS[@]} -eq 0 ]; then
  die "no phase scripts found in ${SCRIPT_DIR}"
fi

# Sort lexicographically (phase-00, phase-01, ...).
IFS=$'\n' PHASE_SCRIPTS=($(printf '%s\n' "${PHASE_SCRIPTS[@]}" | sort))
unset IFS

extract_phase_num() {
  basename "$1" | sed -E 's/^phase-([0-9]+)-.*$/\1/'
}

log_info "discovered ${#PHASE_SCRIPTS[@]} phase script(s)"

for script in "${PHASE_SCRIPTS[@]}"; do
  pnum="$(extract_phase_num "$script")"

  if [ -n "$ONLY" ] && [ "$pnum" != "$ONLY" ]; then
    continue
  fi

  if [ -n "$FROM" ] && [ "$pnum" \< "$FROM" ]; then
    continue
  fi

  if [ "$ONLY" = "$pnum" ] || [ "$FORCE" = "1" ] || [ "$FROM" = "$pnum" ]; then
    phase_unmark "$pnum"
  fi

  if [ "$DRY_RUN" = "1" ]; then
    log_dry "would run: $(basename "$script")"
    continue
  fi

  bash "$script"
done

log_ok "bootstrap complete"
