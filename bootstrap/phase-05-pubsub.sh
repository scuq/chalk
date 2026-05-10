#!/usr/bin/env bash
# bootstrap/phase-05-pubsub.sh
# Adds: LISTEN/NOTIFY pub/sub, partitioned messages table, multi-instance.
#
# Tests:
#   - go vet, unit tests for proto/migrate/server/store/pubsub/config
#   - build chalkd
#   - spin ephemeral PG, apply migrations via chalkd --migrate-only
#   - seed fixture users
#   - start chalkd #1 and chalkd #2 backed by the same PG
#   - confirm both /healthz endpoints
#   - run integration tests (single-instance + cross-instance)
#   - SIGTERM both chalkds, verify clean exits

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"
chalk_use_lib checks
chalk_use_lib postgres
chalk_use_lib testing
chalk_use_lib server

PHASE="05"
PHASE_NAME="pubsub"

phase_begin "$PHASE" "$PHASE_NAME"
require_phase "04"

phase_step "host environment"
checks_go_docker

phase_step "verifying expected files"
expected=(
  migrations/0002_channels.sql
  migrations/0003_messages.sql
  migrations/0004_acks.sql
  migrations/0005_purge.sql
  internal/store/messages.go
  internal/store/partitions.go
  internal/store/partitions_test.go
  internal/pubsub/notifier.go
  internal/pubsub/notifier_test.go
  internal/pubsub/listener.go
  internal/server/server.go
  internal/server/ws.go
  cmd/chalkd/main.go
  test/integration/pubsub_test.go
  test/integration/ws_test.go
  bootstrap/lib/server.sh
)
for f in "${expected[@]}"; do
  [ -f "${CHALK_REPO_ROOT}/${f}" ] || die "missing: ${f}"
done

phase_step "removing now-superseded .gitkeep placeholders"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  rm -f "${CHALK_REPO_ROOT}/internal/pubsub/.gitkeep"
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
  go test -race -count=1 -short \
    ./internal/config/... \
    ./internal/migrate/... \
    ./internal/proto/... \
    ./internal/server/... \
    ./internal/store/... \
    ./internal/pubsub/...
fi

phase_step "go build"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  cd "$CHALK_REPO_ROOT"
  mkdir -p bin
  CGO_ENABLED=0 go build -trimpath \
    -ldflags="-s -w -X github.com/scuq/chalk/internal/version.Version=0.0.0-dev -X github.com/scuq/chalk/internal/version.Commit=phase05" \
    -o bin/chalkd ./cmd/chalkd
fi

phase_step "spinning up ephemeral postgres"
pg_start_ephemeral
trap 'server_stop_all; server_dump_all_logs; pg_stop_ephemeral' EXIT

phase_step "applying migrations via chalkd --migrate-only"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  CHALK_DB_URL="$CHALK_TEST_PGURL" \
    "${CHALK_REPO_ROOT}/bin/chalkd" --migrate-only --tls-mode=off
fi

phase_step "seeding fixture users"
pg_seed_users

phase_step "starting chalkd #1"
server_up_n 1

phase_step "starting chalkd #2"
server_up_n 2

phase_step "smoke: both /healthz"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  for n in 1 2; do
    addr_var="CHALK_TEST_HTTP_${n}"
    url="${!addr_var}"
    if ! curl -fsS "${url}/healthz" >/dev/null; then
      server_dump_all_logs
      die "/healthz failed on chalkd #${n}"
    fi
    log_step "  chalkd #${n} (${url}) ok"
  done
fi

phase_step "running integration tests"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  cd "$CHALK_REPO_ROOT"
  CHALK_TEST_PGURL="$CHALK_TEST_PGURL" \
  CHALK_TEST_HTTP_1="$CHALK_TEST_HTTP_1" \
  CHALK_TEST_HTTP_2="$CHALK_TEST_HTTP_2" \
    go test -race -count=1 ./test/integration/...
fi

phase_step "stopping chalkd instances"
server_stop_n 2
server_stop_n 1

phase_step "tearing down ephemeral postgres"
pg_stop_ephemeral
trap - EXIT

phase_step "committing"
git_commit_phase "$PHASE" "$PHASE_NAME"

phase_done "$PHASE"
