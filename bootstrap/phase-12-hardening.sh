#!/usr/bin/env bash
# bootstrap/phase-12-hardening.sh
# STUB: rate limits, GC, metrics
#
# This phase is not yet implemented. Implementation is added in a
# follow-up bootstrap delivery.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

PHASE="12"
PHASE_NAME="hardening"

phase_begin "$PHASE" "$PHASE_NAME"
require_phase "11"

log_warn "phase 12 (hardening) is not yet implemented"
log_warn "  planned: rate limits, GC, metrics"
log_warn "  run-all.sh halts here intentionally; resume by adding this phase script"
exit 0
