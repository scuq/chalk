#!/usr/bin/env bash
# bootstrap/phase-08-channels.sh
# STUB: channels, threading
#
# This phase is not yet implemented. Implementation is added in a
# follow-up bootstrap delivery.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

PHASE="08"
PHASE_NAME="channels"

phase_begin "$PHASE" "$PHASE_NAME"
require_phase "07"

log_warn "phase 08 (channels) is not yet implemented"
log_warn "  planned: channels, threading"
log_warn "  run-all.sh halts here intentionally; resume by adding this phase script"
exit 0
