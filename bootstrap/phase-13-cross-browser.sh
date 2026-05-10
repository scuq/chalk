#!/usr/bin/env bash
# bootstrap/phase-13-cross-browser.sh
# STUB: playwright matrix
#
# This phase is not yet implemented. Implementation is added in a
# follow-up bootstrap delivery.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

PHASE="13"
PHASE_NAME="cross-browser"

phase_begin "$PHASE" "$PHASE_NAME"
require_phase "12"

log_warn "phase 13 (cross-browser) is not yet implemented"
log_warn "  planned: playwright matrix"
log_warn "  run-all.sh halts here intentionally; resume by adding this phase script"
exit 0
