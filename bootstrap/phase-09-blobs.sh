#!/usr/bin/env bash
# bootstrap/phase-09-blobs.sh
# STUB: encrypted attachments (AES-256-GCM)
#
# This phase is not yet implemented. Implementation is added in a
# follow-up bootstrap delivery.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

PHASE="09"
PHASE_NAME="blobs"

phase_begin "$PHASE" "$PHASE_NAME"
require_phase "08"

log_warn "phase 09 (blobs) is not yet implemented"
log_warn "  planned: encrypted attachments (AES-256-GCM)"
log_warn "  run-all.sh halts here intentionally; resume by adding this phase script"
exit 0
