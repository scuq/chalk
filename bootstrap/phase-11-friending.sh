#!/usr/bin/env bash
# bootstrap/phase-11-friending.sh
# STUB: friend requests, encrypted presence
#
# This phase is not yet implemented. Implementation is added in a
# follow-up bootstrap delivery.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

PHASE="11"
PHASE_NAME="friending"

phase_begin "$PHASE" "$PHASE_NAME"
require_phase "10"

log_warn "phase 11 (friending) is not yet implemented"
log_warn "  planned: friend requests, encrypted presence"
log_warn "  run-all.sh halts here intentionally; resume by adding this phase script"
exit 0
