#!/usr/bin/env bash
# bootstrap/phase-08-channels.sh
# Phase 08a: backend channels (no SPA yet).
#
# Tests:
#   - go vet, unit tests
#   - migration 0010 applies
#   - integration test runs against two chalkds and exercises:
#       * create_channel + channel_event push to other instance
#       * not-friends rejection
#       * per-channel fan-out (member receives, non-member does not)
#       * fetch_history pagination

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"
chalk_use_lib checks
chalk_use_lib postgres
chalk_use_lib testing
chalk_use_lib server

PHASE="08"
PHASE_NAME="channels"

phase_begin "$PHASE" "$PHASE_NAME"
require_phase "07"

phase_step "host environment"
checks_go_docker

phase_step "verifying expected files"
expected=(
  migrations/0010_channel_members.sql
  internal/proto/frames_phase08.go
  internal/pubsub/channel_topics.go
  internal/store/channels.go
  internal/server/hub_phase08.go
  internal/server/ws_phase08.go
  test/integration/channels_test.go
)
for f in "${expected[@]}"; do
  [ -f "${CHALK_REPO_ROOT}/${f}" ] || die "missing: ${f}"
done

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
  go test -race -count=1 -short ./internal/...
fi

phase_step "go build"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  cd "$CHALK_REPO_ROOT"
  mkdir -p bin
  CGO_ENABLED=0 go build -trimpath \
    -ldflags="-s -w -X github.com/scuq/chalk/internal/version.Version=0.0.0-dev -X github.com/scuq/chalk/internal/version.Commit=phase08a" \
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

phase_step "running phase-08 integration tests"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  cd "$CHALK_REPO_ROOT"
  CHALK_TEST_PGURL="$CHALK_TEST_PGURL" \
  CHALK_TEST_HTTP_1="$CHALK_TEST_HTTP_1" \
  CHALK_TEST_HTTP_2="$CHALK_TEST_HTTP_2" \
    go test -race -count=1 -v ./test/integration/ -run 'TestPhase08_' -timeout=60s
fi

phase_step "stopping chalkds"
server_stop_n 1
server_stop_n 2

phase_step "tearing down ephemeral postgres"
pg_stop_ephemeral
trap - EXIT

phase_step "committing"
git_commit_phase "$PHASE" "$PHASE_NAME (08a backend)"

phase_done "$PHASE"
