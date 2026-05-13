#!/usr/bin/env bash
# bootstrap/phase-09b-step3-tests.sh
# Phase 09b sub-step 3 integration tests against an ephemeral PG.
#
# What this does:
#   1. Spin an ephemeral Postgres container (via lib/postgres.sh)
#   2. Apply all migrations from migrations/*.sql
#   3. Run the registration end-to-end test in internal/auth/
#      with CHALK_TEST_DATABASE_URL pointing at the ephemeral PG.
#      The test uses descope/virtualwebauthn to play the authenticator
#      role and exercises POST /api/auth/register/begin and
#      POST /api/auth/register/finish against an in-process http.Server.
#   4. Tear down PG (always; trap on EXIT).
#
# This is a one-shot test runner, not part of the phase commit ritual.
# Sub-step 3's HTTP handler tests are covered without PG by the unit
# tests in internal/auth/*_test.go; this script adds the database-
# touching round-trip on top.
#
# PHASE key is "09b-step3-tests" -- distinct from "09b" used by sub-
# step appliers, so this script does not interact with their phase
# markers.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"
chalk_use_lib checks
chalk_use_lib postgres

PHASE="09b-step3-tests"
PHASE_NAME="step3-tests"

phase_begin "$PHASE" "$PHASE_NAME"

phase_step "host environment"
checks_go_docker

phase_step "verifying expected files"
expected=(
  internal/auth/cache.go
  internal/auth/cache_test.go
  internal/auth/http.go
  internal/auth/http_test.go
  internal/auth/openreg.go
  internal/store/registration.go
)
for f in "${expected[@]}"; do
  [ -f "${CHALK_REPO_ROOT}/${f}" ] || die "missing: ${f}"
done

# Cleanup trap: always tear down PG, even on error.
cleanup() {
  local rc=$?
  set +e
  pg_stop_ephemeral 2>/dev/null
  exit $rc
}
trap cleanup EXIT INT TERM

phase_step "spinning up ephemeral postgres"
pg_start_ephemeral

phase_step "waiting for postgres readiness"
# Container has a healthcheck; wait briefly for it to flip to healthy.
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  if [ "$CHALK_DRY_RUN" = "1" ]; then break; fi
  status=$(docker inspect -f '{{.State.Health.Status}}' "$CHALK_TEST_PGCNAME" 2>/dev/null || true)
  if [ "$status" = "healthy" ]; then
    break
  fi
  sleep 1
done
[ "$CHALK_DRY_RUN" = "1" ] || \
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$CHALK_TEST_PGCNAME" 2>/dev/null)" = "healthy" ] || \
  die "postgres not healthy after 60s"
log_step "postgres ready on :${CHALK_TEST_PGPORT}"

phase_step "applying migrations"
pg_apply_migrations

phase_step "running phase 09b sub-step 3 integration test"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  cd "$CHALK_REPO_ROOT"
  # CHALK_TEST_DATABASE_URL is what http_test.go's
  # TestRegisterEndToEnd reads. Without it, the test skips.
  # CHALK_OPEN_REGISTRATION is set by the test itself via
  # t.Setenv; we still pass it explicitly for clarity.
  CHALK_TEST_DATABASE_URL="$CHALK_TEST_PGURL" \
    go test -race -count=1 -v -run TestRegisterEndToEnd ./internal/auth/...
fi

log_ok "phase 09b sub-step 3 integration test passed"
