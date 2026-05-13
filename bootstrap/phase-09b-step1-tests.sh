#!/usr/bin/env bash
# bootstrap/phase-09b-step1-tests.sh
# Phase 09b sub-step 1 integration tests against an ephemeral PG.
#
# What this does:
#   1. Build chalkd (needed for --migrate-only)
#   2. Spin an ephemeral Postgres container
#   3. Apply all migrations (0001-0017) via chalkd --migrate-only
#   4. Seed alice/bob/carol fixtures
#   5. Run only the phase-09b-step1 tests in test/integration/
#   6. Tear down PG (always; trap on EXIT)
#
# This is a one-shot test runner, not part of the phase commit ritual.
# Sub-step 1 has no end-to-end behavior to validate; the unit tests
# already covered the schema/CRUD invariants and ran during the
# applier. This script just lets you exercise the same tests against
# real Postgres.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"
chalk_use_lib checks
chalk_use_lib postgres
chalk_use_lib server

PHASE="09b-step1-tests"
PHASE_NAME="step1-tests"

phase_begin "$PHASE" "$PHASE_NAME"

phase_step "host environment"
checks_go_docker

phase_step "verifying expected files"
expected=(
  migrations/0011_users_extend.sql
  migrations/0012_passkeys.sql
  migrations/0013_sessions.sql
  migrations/0014_recovery_codes.sql
  migrations/0015_devices_link.sql
  migrations/0017_admin_bootstrap.sql
  internal/store/sessions.go
  internal/store/passkeys.go
  internal/store/recovery_codes.go
  internal/store/admin_bootstrap.go
  test/integration/store_phase09b_test.go
)
for f in "${expected[@]}"; do
  [ -f "${CHALK_REPO_ROOT}/${f}" ] || die "missing: ${f}"
done

phase_step "go build (needed for --migrate-only)"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  cd "$CHALK_REPO_ROOT"
  mkdir -p bin
  CGO_ENABLED=0 go build -trimpath \
    -o bin/chalkd ./cmd/chalkd
fi

phase_step "spinning up ephemeral postgres"
pg_start_ephemeral
trap 'pg_stop_ephemeral' EXIT

phase_step "applying migrations via chalkd --migrate-only"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  CHALK_DB_URL="$CHALK_TEST_PGURL" \
    "${CHALK_REPO_ROOT}/bin/chalkd" --migrate-only --tls-mode=off
fi

phase_step "seeding fixture users (with 09b columns)"
pg_seed_users

phase_step "running phase 09b sub-step 1 integration tests"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  cd "$CHALK_REPO_ROOT"
  CHALK_TEST_PGURL="$CHALK_TEST_PGURL" \
    go test -race -count=1 -v ./test/integration/ \
      -run 'TestUsersFixtureHas09bColumns|TestUsersGetByUsername|TestUsersGetByEmail|TestUsersUpdateDisplayName|TestUsersRoleAndAdminInvariants|TestSessions|TestPasskeys|TestRecoveryCode|TestAdminBootstrap' \
      -timeout=60s
fi

phase_step "tearing down ephemeral postgres"
pg_stop_ephemeral
trap - EXIT

phase_done "$PHASE"
