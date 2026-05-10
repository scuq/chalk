#!/usr/bin/env bash
# bootstrap/phase-07-frontend-shell.sh
# STUB: theming, hack font, sounds, roster, composer
#
# This phase is not yet implemented. Implementation is added in a
# follow-up bootstrap delivery.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

PHASE="07"
PHASE_NAME="frontend-shell"

phase_begin "$PHASE" "$PHASE_NAME"
require_phase "06"

log_warn "phase 07 (frontend-shell) is not yet implemented"
log_warn "  planned: theming, hack font, sounds, roster, composer"
log_warn "  run-all.sh halts here intentionally; resume by adding this phase script"
exit 0
