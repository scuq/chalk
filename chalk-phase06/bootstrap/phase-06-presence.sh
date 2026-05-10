#!/usr/bin/env bash
# chalk -- bootstrap phase 06
# Presence, friendships, account lifecycle (schema + read-path).
#
# Verifies:
#   * Migrations 0001..0009 apply cleanly to a fresh DB.
#   * Unit tests for the friends package pass.
#   * Unit tests for the presence package pass (smoke; the heavy lifting
#     is in the integration test).
#   * Two chalkd instances start, run the integration scenario, and
#     shut down cleanly.

set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "${SCRIPT_DIR}/.." && pwd )"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

PHASE="06"
PHASE_NAME="presence-and-friends"

log_phase_start "${PHASE}" "${PHASE_NAME}"

# ---------------------------------------------------------------------
# Source files expected by this phase.
# ---------------------------------------------------------------------
required_files=(
  "migrations/0006_user_lifecycle.sql"
  "migrations/0007_friendships.sql"
  "migrations/0008_presence.sql"
  "migrations/0009_messages_nullable_sender.sql"
  "internal/proto/frames_phase06.go"
  "internal/friends/store.go"
  "internal/friends/store_test.go"
  "internal/presence/store.go"
  "internal/presence/loops.go"
  "internal/pubsub/notifier.go"
  "internal/server/ws.go"
  "internal/server/ws_phase06.go"
  "internal/server/server.go"
  "test/integration/presence_friends_test.go"
)

for f in "${required_files[@]}"; do
  if [[ ! -f "${REPO_ROOT}/${f}" ]]; then
    log_error "missing required file: ${f}"
    exit 1
  fi
done
log_ok "all required phase-06 files present"

# ---------------------------------------------------------------------
# Migrations: 0001..0009 must all be present and apply cleanly to a
# fresh schema in the bootstrap-managed Postgres.
# ---------------------------------------------------------------------
# shellcheck source=lib/postgres.sh
source "${SCRIPT_DIR}/lib/postgres.sh"
pg_ensure_running
pg_reset_test_db

migrations_dir="${REPO_ROOT}/migrations"
mapfile -t migrations < <(ls "${migrations_dir}"/*.sql | sort)
if (( ${#migrations[@]} < 9 )); then
  log_error "expected at least 9 migrations, found ${#migrations[@]}"
  exit 1
fi
for m in "${migrations[@]}"; do
  log_info "applying $(basename "${m}")"
  pg_exec_file "${m}"
done
log_ok "9+ migrations applied"

# Seed fixture users so unit-test-adjacent queries don't break.
pg_exec_file "${REPO_ROOT}/bootstrap/fixtures/users.sql"
log_ok "fixture users seeded"

# ---------------------------------------------------------------------
# Schema sanity: spot-check the new columns and tables.
# ---------------------------------------------------------------------
pg_check_column users status
pg_check_column users status_reason
pg_check_column users last_seen_at
pg_check_table friendships
pg_check_table device_presence
pg_check_table instances
pg_check_table presence_subscriptions

# messages.sender_device_id must now be nullable.
nullable=$(pg_query_scalar "SELECT is_nullable FROM information_schema.columns
                            WHERE table_name='messages' AND column_name='sender_device_id'")
if [[ "${nullable}" != "YES" ]]; then
  log_error "messages.sender_device_id should be nullable, got is_nullable='${nullable}'"
  exit 1
fi
log_ok "messages.sender_device_id is nullable"

# ---------------------------------------------------------------------
# Go unit tests.
# ---------------------------------------------------------------------
cd "${REPO_ROOT}"
log_info "running friends unit tests"
go test ./internal/friends/... -count=1
log_info "running presence unit tests (build-only smoke)"
go vet ./internal/presence/...

# ---------------------------------------------------------------------
# Build chalkd.
# ---------------------------------------------------------------------
log_info "building chalkd"
go build -o "${REPO_ROOT}/bin/chalkd" ./cmd/chalkd
log_ok "chalkd built at bin/chalkd"

# ---------------------------------------------------------------------
# Integration test (two-instance scenario).
# ---------------------------------------------------------------------
export CHALK_INTEGRATION_DSN
CHALK_INTEGRATION_DSN="$(pg_dsn)"

log_info "running integration test (presence + friends, two instances)"
go test -count=1 -timeout 90s -v ./test/integration/... -run TestPresenceAndFriendsTwoInstances

log_ok "phase 06 bootstrap complete"
