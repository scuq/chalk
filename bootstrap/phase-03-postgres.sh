#!/usr/bin/env bash
# bootstrap/phase-03-postgres.sh
# Adds: pgx pool wrapper, embedded migrations runner, users + devices stores.
#
# Tests:
#   - go vet, go test (unit) for pure logic
#   - ephemeral PG, run `chalkd --migrate-only`, verify schema_migrations
#   - re-run migrations, verify all skipped (idempotency)
#   - seed alice/bob/carol, run integration tests against them

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"
chalk_use_lib checks
chalk_use_lib postgres
chalk_use_lib testing

PHASE="03"
PHASE_NAME="postgres"

phase_begin "$PHASE" "$PHASE_NAME"
require_phase "02"

phase_step "host environment"
checks_go_docker

phase_step "verifying expected files"
expected=(
  go.mod
  embed.go
  migrations/0001_init.sql
  internal/migrate/migrate.go
  internal/migrate/migrate_test.go
  internal/store/store.go
  internal/store/users.go
  internal/store/devices.go
  test/integration/helper_test.go
  test/integration/store_test.go
  test/integration/migrate_test.go
)
for f in "${expected[@]}"; do
  [ -f "${CHALK_REPO_ROOT}/${f}" ] || die "missing: ${f}"
done

phase_step "removing now-superseded .gitkeep placeholders"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  rm -f \
    "${CHALK_REPO_ROOT}/internal/store/.gitkeep" \
    "${CHALK_REPO_ROOT}/migrations/.gitkeep" \
    "${CHALK_REPO_ROOT}/test/integration/.gitkeep"
fi

phase_step "go mod tidy"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  cd "$CHALK_REPO_ROOT"
  go mod tidy
fi

phase_step "go vet"
go_vet_check

phase_step "go test (unit, pure logic)"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  cd "$CHALK_REPO_ROOT"
  go test -race -count=1 -short ./internal/config/... ./internal/migrate/...
fi

phase_step "go build (with embedded migrations)"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  cd "$CHALK_REPO_ROOT"
  mkdir -p bin
  CGO_ENABLED=0 go build -trimpath \
    -ldflags="-s -w -X github.com/scuq/chalk/internal/version.Version=0.0.0-dev -X github.com/scuq/chalk/internal/version.Commit=phase03" \
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

phase_step "verifying schema_migrations table populated"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  count="$(docker exec -i "$CHALK_TEST_PGCNAME" psql -U chalk -d chalk -At \
    -c 'SELECT count(*) FROM schema_migrations')"
  [ "${count:-0}" -ge 1 ] || die "schema_migrations is empty"
  log_step "  schema_migrations rows: ${count}"
fi

phase_step "re-running migrations (idempotency check)"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  out="$(CHALK_DB_URL="$CHALK_TEST_PGURL" \
    "${CHALK_REPO_ROOT}/bin/chalkd" --migrate-only --tls-mode=off 2>&1)"
  echo "$out" | grep -q "already-applied" || {
    echo "$out" >&2
    die "expected 'already-applied' in second-run output"
  }
fi

phase_step "seeding fixture users (alice, bob, carol)"
pg_seed_users

phase_step "running integration tests"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  cd "$CHALK_REPO_ROOT"
  CHALK_TEST_PGURL="$CHALK_TEST_PGURL" \
    go test -race -count=1 ./test/integration/...
fi

phase_step "tearing down ephemeral postgres"
pg_stop_ephemeral
trap - EXIT

phase_step "committing"
git_commit_phase "$PHASE" "$PHASE_NAME"

phase_done "$PHASE"
