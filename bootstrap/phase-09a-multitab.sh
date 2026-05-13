#!/usr/bin/env bash
# bootstrap/phase-09a-multitab.sh
# Phase 09a step 5: end-to-end multi-tab Playwright spec.
#
# What this validates:
#   - phase 09a steps 1-4 are present in the code
#   - go vet, server tests pass (re-run with the post-step-5 hub.go)
#   - chalkd builds
#   - Spin one ephemeral PG + one chalkd
#   - Seed alice's device + add alice to the default channel
#     (so the SPA has something to send to without ceremony)
#   - Run multitab.spec.ts against the running chalkd
#
# The spec opens two browser tabs in the SAME browser context (shared
# localStorage = shared device_id), sends a message from each, and
# asserts:
#   - Tab A's send appears in tab A (optimistic-append) and tab B
#     (server fan-out via byUser).
#   - Tab B's send appears in tab B and tab A.
#   - Neither tab renders its own send twice (echo-suppression by
#     connID, step 3).
#   - Both tabs stay state=open throughout (step 4: no eviction).
#
# Requires steps 1-4 already committed. This bootstrap also patches
# in step 5's hub.go (FanOutFresh fix) + hub_test.go (regression
# tests) before running.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"
chalk_use_lib checks
chalk_use_lib postgres
chalk_use_lib testing
chalk_use_lib server
chalk_use_lib frontend

PHASE="09a"
PHASE_NAME="multitab"

phase_begin "$PHASE" "$PHASE_NAME"

phase_step "host environment"
checks_go_docker
web_check_node

phase_step "verifying expected files"
expected=(
  internal/server/hub.go
  internal/server/hub_test.go
  internal/server/server.go
  internal/server/ws.go
  internal/pubsub/notifier.go
  test/e2e/multitab.spec.ts
  test/e2e/playwright.config.ts
  web/dist/index.html
)
for f in "${expected[@]}"; do
  [ -f "${CHALK_REPO_ROOT}/${f}" ] || die "missing: ${f}"
done

# Verify steps 1-4 are present (sanity, in case applier was skipped).
phase_step "verifying phase 09a steps 1-4 already applied"
if ! grep -qF 'type userConnSet struct' "${CHALK_REPO_ROOT}/internal/server/hub.go"; then
  die "userConnSet not found -- run apply-phase09a-step2.sh first"
fi
if ! grep -qF 'func (h *Hub) FanOutToUser(' "${CHALK_REPO_ROOT}/internal/server/hub.go"; then
  die "FanOutToUser not found -- run apply-phase09a-step3.sh first"
fi
if grep -qF 'superseded by new connection' "${CHALK_REPO_ROOT}/internal/server/hub.go"; then
  die "eviction logic still present -- run apply-phase09a-step4.sh first"
fi
log_ok "steps 1-4 confirmed"

# Verify the FanOutFresh fix from step 5 is present.
phase_step "verifying step 5 hub.go fix is present"
if ! grep -qF 'for _, c := range h.byConnID' "${CHALK_REPO_ROOT}/internal/server/hub.go"; then
  die "FanOutFresh fix not present -- apply-phase09a-step5.sh should patch hub.go"
fi
log_ok "step 5 hub.go fix confirmed"

phase_step "go vet"
go_vet_check

phase_step "go test (server, race, short)"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  cd "$CHALK_REPO_ROOT"
  go test -race -count=1 -short ./internal/server/...
fi

phase_step "esbuild bundle (web)"
web_install
web_build

phase_step "go build"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  cd "$CHALK_REPO_ROOT"
  mkdir -p bin
  CGO_ENABLED=0 go build -trimpath \
    -ldflags="-s -w -X github.com/scuq/chalk/internal/version.Version=0.0.0-dev -X github.com/scuq/chalk/internal/version.Commit=phase09a" \
    -o bin/chalkd ./cmd/chalkd
fi

phase_step "spinning up ephemeral postgres"
pg_start_ephemeral
trap 'server_stop_all; server_dump_all_logs; pg_stop_ephemeral' EXIT

phase_step "applying migrations"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  CHALK_DB_URL="$CHALK_TEST_PGURL" \
    "${CHALK_REPO_ROOT}/bin/chalkd" --migrate-only --tls-mode=off
fi

phase_step "seeding fixture users"
pg_seed_users

phase_step "seeding alice device + default-channel membership"
# Alice's pinned device for the multi-tab spec, plus channel_members
# row so the SPA's first list_channels returns the default channel
# and the composer is enabled. Without this, both tabs would load
# with no active channel and the test would deadlock on the send.
if [ "$CHALK_DRY_RUN" != "1" ]; then
  docker exec -i "$CHALK_TEST_PGCNAME" psql -U chalk -d chalk -v ON_ERROR_STOP=1 -q >/dev/null <<'SQL'
INSERT INTO devices (id, user_id, device_type, device_label)
VALUES
  ('11111111-1111-1111-1111-111111111111',
   '00000000-0000-0000-0000-00000000a11c',
   'desktop', 'phase-09a-e2e-alice')
ON CONFLICT (id) DO UPDATE
  SET user_id = EXCLUDED.user_id, device_label = EXCLUDED.device_label;

INSERT INTO channel_members (channel_id, user_id)
VALUES
  ('00000000-0000-0000-0000-000000000c01',
   '00000000-0000-0000-0000-00000000a11c')
ON CONFLICT DO NOTHING;
SQL
fi

phase_step "starting chalkd #1"
server_up_n 1

phase_step "installing playwright (cached from earlier phases)"
e2e_install

phase_step "running phase 09a multitab Playwright spec"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  cd "$CHALK_REPO_ROOT/test/e2e"
  CHALK_TEST_HTTP_1="$CHALK_TEST_HTTP_1" \
    npx playwright test multitab.spec.ts --reporter=line
fi

phase_step "stopping chalkd"
server_stop_n 1

phase_step "tearing down ephemeral postgres"
pg_stop_ephemeral
trap - EXIT

phase_done "$PHASE"
