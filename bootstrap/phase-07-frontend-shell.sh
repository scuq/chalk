#!/usr/bin/env bash
# bootstrap/phase-07-frontend-shell.sh
# Adds: SPA shell (Preact + esbuild + TypeScript), matrix-green theme,
#       SPA static handler embedded in chalkd, Playwright smoke test.
#
# Tests:
#   - npm install + typecheck + build for web/
#   - go vet, unit tests (spa_test.go added)
#   - build chalkd with embedded SPA
#   - spin ephemeral PG, apply migrations, seed users
#   - start chalkd, hit /healthz + GET /, confirm SPA bundle served
#   - run single Playwright smoke spec against running chalkd
#   - tear down

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"
chalk_use_lib checks
chalk_use_lib postgres
chalk_use_lib testing
chalk_use_lib server
chalk_use_lib frontend

PHASE="07"
PHASE_NAME="frontend-shell"

phase_begin "$PHASE" "$PHASE_NAME"
require_phase "06"

phase_step "host environment"
checks_go_docker
web_check_node

phase_step "verifying expected files"
expected=(
  web/package.json
  web/tsconfig.json
  web/build.mjs
  web/index.html
  web/src/index.tsx
  web/src/proto.ts
  web/src/ws-client.ts
  web/src/theme.css
  web/src/components/App.tsx
  web/src/components/StatusBar.tsx
  web/src/components/MessageList.tsx
  web/src/components/Composer.tsx
  internal/server/spa.go
  internal/server/spa_test.go
  test/e2e/package.json
  test/e2e/playwright.config.ts
  test/e2e/smoke.spec.ts
  bootstrap/lib/frontend.sh
)
for f in "${expected[@]}"; do
  [ -f "${CHALK_REPO_ROOT}/${f}" ] || die "missing: ${f}"
done

phase_step "npm install + typecheck (web)"
web_install
web_typecheck

phase_step "esbuild bundle"
web_build

# Verify the bundle landed where chalkd expects it.
for f in index.html index.js theme.css; do
  [ -f "${CHALK_REPO_ROOT}/web/dist/${f}" ] \
    || die "expected web/dist/${f} after build"
done
log_ok "bundle artifacts present in web/dist/"

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
    ./internal/friends/... \
    ./internal/migrate/... \
    ./internal/proto/... \
    ./internal/pubsub/... \
    ./internal/server/... \
    ./internal/store/...
fi

phase_step "go build"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  cd "$CHALK_REPO_ROOT"
  mkdir -p bin
  CGO_ENABLED=0 go build -trimpath \
    -ldflags="-s -w -X github.com/scuq/chalk/internal/version.Version=0.0.0-dev -X github.com/scuq/chalk/internal/version.Commit=phase07" \
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

phase_step "smoke: /healthz, /, /index.js, /theme.css"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  base="$CHALK_TEST_HTTP_1"
  for path in /healthz / /index.js /theme.css; do
    code=$(curl -fsS -o /dev/null -w '%{http_code}' "${base}${path}" || echo 000)
    if [ "$code" != "200" ]; then
      server_dump_all_logs
      die "${path} returned ${code} (want 200)"
    fi
    log_step "  GET ${path} -> 200"
  done
  # SPA fallback: deep-link path should also return 200 (index.html).
  code=$(curl -fsS -o /dev/null -w '%{http_code}' "${base}/channels/general" || echo 000)
  [ "$code" = "200" ] || die "SPA fallback /channels/general returned ${code}"
  log_step "  GET /channels/general -> 200 (SPA fallback)"
fi

phase_step "installing playwright"
e2e_install

phase_step "running playwright smoke spec"
e2e_run

phase_step "stopping chalkd"
server_stop_n 1

phase_step "tearing down ephemeral postgres"
pg_stop_ephemeral
trap - EXIT

phase_step "committing"
git_commit_phase "$PHASE" "$PHASE_NAME"

phase_done "$PHASE"
