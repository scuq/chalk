#!/usr/bin/env bash
# bootstrap/phase-10-mls.sh
# STUB: CoreCrypto WASM, MLS groups
#
# This phase is not yet implemented. Implementation is added in a
# follow-up bootstrap delivery.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

PHASE="10"
PHASE_NAME="mls"

phase_begin "$PHASE" "$PHASE_NAME"
require_phase "09"

log_warn "phase 10 (mls) is not yet implemented"
log_warn "  planned: CoreCrypto WASM, MLS groups"
log_warn "  run-all.sh halts here intentionally; resume by adding this phase script"
exit 0
