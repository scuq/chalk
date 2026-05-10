#!/usr/bin/env bash
# bootstrap/phase-04-ws-relay.sh
# Adds: WebSocket hub, ping/pong, plaintext echo protocol.
#
# Tests:
#   - go vet, unit tests for proto and hub
#   - build chalkd
#   - spin ephemeral PG, start chalkd in background, wait for listen-info-file
#   - hit /healthz
#   - run integration tests (the suite dials /ws and exchanges frames)
#   - SIGTERM chalkd, verify clean exit
#   - tear down PG

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"
chalk_use_lib checks
chalk_use_lib postgres
chalk_use_lib testing
chalk_use_lib server

PHASE="04"
PHASE_NAME="ws-relay"

phase_begin "$PHASE" "$PHASE_NAME"
require_phase "03"

phase_step "host environment"
checks_go_docker

phase_step "verifying expected files"
expected=(
  internal/proto/proto.go
  internal/proto/proto_test.go
  internal/server/hub.go
  internal/server/hub_test.go
  internal/server/ws.go
  internal/server/server.go
  test/integration/ws_test.go
  bootstrap/lib/server.sh
)
for f in "${expected[@]}"; do
  [ -f "${CHALK_REPO_ROOT}/${f}" ] || die "missing: ${f}"
done

phase_step "removing now-superseded .gitkeep placeholders"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  rm -f \
    "${CHALK_REPO_ROOT}/internal/proto/.gitkeep" \
    "${CHALK_REPO_ROOT}/internal/server/.gitkeep"
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
  go test -race -count=1 -short ./internal/config/... ./internal/migrate/... ./internal/proto/... ./internal/server/...
fi

phase_step "go build"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  cd "$CHALK_REPO_ROOT"
  mkdir -p bin
  CGO_ENABLED=0 go build -trimpath \
    -ldflags="-s -w -X github.com/scuq/chalk/internal/version.Version=0.0.0-dev -X github.com/scuq/chalk/internal/version.Commit=phase04" \
    -o bin/chalkd ./cmd/chalkd
fi

phase_step "spinning up ephemeral postgres"
pg_start_ephemeral
pg_apply_migrations || true   # we'll re-apply via chalkd below; this is a sanity step
trap 'server_stop; server_dump_logs; pg_stop_ephemeral' EXIT

phase_step "applying migrations via chalkd --migrate-only"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  CHALK_DB_URL="$CHALK_TEST_PGURL" \
    "${CHALK_REPO_ROOT}/bin/chalkd" --migrate-only --tls-mode=off
fi

phase_step "seeding fixture users"
pg_seed_users

phase_step "starting chalkd in the background"
server_up

phase_step "smoke: /healthz"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  if ! curl -fsS "${CHALK_TEST_HTTP}/healthz" >/dev/null; then
    server_dump_logs
    die "/healthz failed"
  fi
  log_step "  /healthz ok"
fi

phase_step "smoke: bound port matches printed value"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  # The log file should contain the "listening on" line stdout printed.
  if ! grep -q "listening on ${CHALK_TEST_ADDR}" "$CHALK_TEST_LOG_FILE"; then
    log_warn "did not find 'listening on ${CHALK_TEST_ADDR}' in chalkd output"
    server_dump_logs
    die "listen-info-file / stdout mismatch"
  fi
  log_step "  printed and file-written addresses agree"
fi

phase_step "running integration tests"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  cd "$CHALK_REPO_ROOT"
  CHALK_TEST_PGURL="$CHALK_TEST_PGURL" \
    go test -race -count=1 ./test/integration/...
fi

phase_step "stopping chalkd cleanly"
server_stop

phase_step "tearing down ephemeral postgres"
pg_stop_ephemeral
trap - EXIT

phase_step "committing"
git_commit_phase "$PHASE" "$PHASE_NAME"

phase_done "$PHASE"
