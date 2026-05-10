#!/usr/bin/env bash
# bootstrap/fixtures/seed.sh
# Apply the user fixture against the currently-configured ephemeral PG.
# Used standalone when debugging; phase scripts call pg_seed_users directly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
. "${SCRIPT_DIR}/../lib/common.sh"
chalk_use_lib postgres

if [ -z "${CHALK_TEST_PGCNAME:-}" ]; then
  log_err "no ephemeral postgres running (set CHALK_TEST_PGCNAME or use pg_start_ephemeral)"
  exit 1
fi

pg_seed_users
log_ok "users seeded"
