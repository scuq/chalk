#!/usr/bin/env bash
# bootstrap/phase-06-presence.sh
# Adds: per-device presence (online/away/offline), multi-device aggregation,
#       instance heartbeat + janitor + demotion, friendships
#       (request/accept/decline/remove/block/unblock/list), account-lifecycle
#       schema (status/status_reason/last_seen_at).
#
# Tests:
#   - go vet, unit tests for friends + presence + proto + pubsub + server
#   - build chalkd
#   - spin ephemeral PG, apply migrations via chalkd --migrate-only
#   - seed fixture users (alice/bob/carol)
#   - start chalkd #1 and #2 against the same PG with aggressive presence
#     loop intervals (via env vars) so the janitor reaps within seconds
#   - confirm both /healthz endpoints
#   - run the friend/presence happy-path integration test against both
#   - SIGKILL chalkd #1 (unclean), then run the janitor reap test against
#     chalkd #2 alone
#   - clean stop chalkd #2, tear down PG

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"
chalk_use_lib checks
chalk_use_lib postgres
chalk_use_lib testing
chalk_use_lib server

PHASE="06"
PHASE_NAME="presence"

phase_begin "$PHASE" "$PHASE_NAME"
require_phase "05"

phase_step "host environment"
checks_go_docker

phase_step "verifying expected files"
expected=(
  migrations/0006_user_lifecycle.sql
  migrations/0007_friendships.sql
  migrations/0008_presence.sql
  migrations/0009_messages_nullable_sender.sql
  internal/proto/frames_phase06.go
  internal/friends/store.go
  internal/friends/store_test.go
  internal/presence/store.go
  internal/presence/loops.go
  internal/presence/config.go
  internal/pubsub/notifier.go
  internal/server/ws.go
  internal/server/ws_phase06.go
  internal/server/server.go
  cmd/chalkd/main.go
  test/integration/presence_friends_test.go
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
  go test -race -count=1 -short \
    ./internal/config/... \
    ./internal/migrate/... \
    ./internal/proto/... \
    ./internal/friends/... \
    ./internal/presence/... \
    ./internal/server/... \
    ./internal/store/... \
    ./internal/pubsub/...
fi

phase_step "go build"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  cd "$CHALK_REPO_ROOT"
  mkdir -p bin
  CGO_ENABLED=0 go build -trimpath \
    -ldflags="-s -w -X github.com/scuq/chalk/internal/version.Version=0.0.0-dev -X github.com/scuq/chalk/internal/version.Commit=phase06" \
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

# Presence loop tuning for the test run. Aggressive values so the
# janitor reap test completes in seconds rather than the 25+ that
# production defaults (5s/10s/15s/5s) would require.
#
# Heartbeat 500ms, janitor 500ms, instance staleness 2s, demotion 500ms
# means a SIGKILL'd instance is reaped within 2.5s + propagation. The
# integration test waits up to 10s.
export CHALK_PRESENCE_HEARTBEAT_INTERVAL="500ms"
export CHALK_PRESENCE_JANITOR_INTERVAL="500ms"
export CHALK_PRESENCE_INSTANCE_STALENESS="2s"
export CHALK_PRESENCE_DEMOTION_INTERVAL="500ms"

phase_step "starting chalkd #1 (aggressive presence loops)"
server_up_n 1

phase_step "starting chalkd #2 (aggressive presence loops)"
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

phase_step "running happy-path integration tests (friend + presence)"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  cd "$CHALK_REPO_ROOT"
  CHALK_TEST_PGURL="$CHALK_TEST_PGURL" \
  CHALK_TEST_HTTP_1="$CHALK_TEST_HTTP_1" \
  CHALK_TEST_HTTP_2="$CHALK_TEST_HTTP_2" \
    go test -race -count=1 -timeout 60s ./test/integration/... \
      -run 'TestPhase06_FriendRequestAccept|TestPhase06_PresenceAggregation'
fi

phase_step "killing chalkd #1 (unclean) to test janitor reap"
server_kill_n 1

phase_step "running janitor reap integration test"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  cd "$CHALK_REPO_ROOT"
  CHALK_TEST_PGURL="$CHALK_TEST_PGURL" \
  CHALK_TEST_HTTP_2="$CHALK_TEST_HTTP_2" \
    go test -race -count=1 -timeout 30s ./test/integration/... \
      -run 'TestPhase06_JanitorReapsCrashedInstance'
fi

phase_step "stopping chalkd #2"
server_stop_n 2

phase_step "tearing down ephemeral postgres"
pg_stop_ephemeral
trap - EXIT

phase_step "committing"
git_commit_phase "$PHASE" "$PHASE_NAME"

phase_done "$PHASE"
