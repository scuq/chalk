#!/usr/bin/env bash
# bootstrap/phase-06-presence.sh
# STUB: multi-device presence with TTL
#
# This phase is not yet implemented. Implementation is added in a
# follow-up bootstrap delivery.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

PHASE="06"
PHASE_NAME="presence"

phase_begin "$PHASE" "$PHASE_NAME"
require_phase "05"

log_warn "phase 06 (presence) is not yet implemented"
log_warn "  planned: multi-device presence with TTL"
log_warn "  run-all.sh halts here intentionally; resume by adding this phase script"
exit 0
