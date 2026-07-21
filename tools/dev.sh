#!/usr/bin/env bash
# tools/dev.sh -- one-shot local dev bring-up for chalk.
#
# What this does, in order:
#   1. Start (or reuse) a long-lived Postgres container on :5432.
#   2. Wait until it accepts connections.
#   3. Build the SPA bundle via npm.
#   4. Build chalkd.
#   5. Apply migrations.
#   6. Exec chalkd in the foreground (Ctrl-C to stop).
#
# Idempotent. Re-running reuses everything that exists.
#
# Tweak via env vars before invocation:
#   CHALK_DEV_PG_NAME      docker container name           (default: chalk-dev-pg)
#   CHALK_DEV_PG_PORT      host port for Postgres          (default: 5432)
#   CHALK_DEV_PG_IMAGE     postgres image                  (default: postgres:16)
#   CHALK_DEV_LISTEN       chalkd listen addr              (default: 127.0.0.1:8443)
#   CHALK_DEV_SKIP_NPM=1   skip the SPA rebuild
#   CHALK_DEV_SKIP_BUILD=1 skip the Go rebuild

set -euo pipefail
IFS=$'\n\t'

PG_NAME="${CHALK_DEV_PG_NAME:-chalk-dev-pg}"
PG_PORT="${CHALK_DEV_PG_PORT:-5432}"
PG_IMAGE="${CHALK_DEV_PG_IMAGE:-postgres:16}"
LISTEN="${CHALK_DEV_LISTEN:-127.0.0.1:8443}"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

c_reset=$'\033[0m'
c_green=$'\033[32m'
c_yellow=$'\033[33m'
c_cyan=$'\033[36m'
c_red=$'\033[31m'
log()  { printf '%s» %s%s\n' "$c_cyan" "$*" "$c_reset"; }
ok()   { printf '%s✓ %s%s\n' "$c_green" "$*" "$c_reset"; }
warn() { printf '%s! %s%s\n' "$c_yellow" "$*" "$c_reset" >&2; }
die()  { printf '%s✗ %s%s\n' "$c_red" "$*" "$c_reset" >&2; exit 1; }

# ---- 1. Postgres ---------------------------------------------------------

if ! command -v docker >/dev/null 2>&1; then
  die "docker not on PATH; install docker or set CHALK_DB_URL manually and use 'make run'"
fi

if docker ps --format '{{.Names}}' | grep -qx "$PG_NAME"; then
  ok "postgres container $PG_NAME already running"
elif docker ps -a --format '{{.Names}}' | grep -qx "$PG_NAME"; then
  log "starting existing postgres container $PG_NAME"
  docker start "$PG_NAME" >/dev/null
  ok "postgres started"
else
  log "creating postgres container $PG_NAME on :$PG_PORT"
  docker run -d \
    --name "$PG_NAME" \
    -p "${PG_PORT}:5432" \
    -e POSTGRES_USER=chalk \
    -e POSTGRES_PASSWORD=chalk \
    -e POSTGRES_DB=chalk \
    "$PG_IMAGE" >/dev/null
  ok "postgres container created"
fi

# Wait up to 20s for postgres to be ready.
log "waiting for postgres to accept connections"
for i in $(seq 1 40); do
  if docker exec "$PG_NAME" pg_isready -U chalk -d chalk >/dev/null 2>&1; then
    ok "postgres ready"
    break
  fi
  if [ "$i" = "40" ]; then
    die "postgres did not become ready in 20s; check 'docker logs $PG_NAME'"
  fi
  sleep 0.5
done

CHALK_DB_URL="postgres://chalk:chalk@127.0.0.1:${PG_PORT}/chalk?sslmode=disable"
export CHALK_DB_URL

# ---- 2. SPA bundle -------------------------------------------------------

if [ "${CHALK_DEV_SKIP_NPM:-0}" = "1" ]; then
  warn "skipping npm build (CHALK_DEV_SKIP_NPM=1)"
elif [ -f web/package.json ]; then
  if [ ! -d web/node_modules ]; then
    log "npm install (first run)"
    (cd web && npm install)
  fi
  log "npm run build (SPA bundle)"
  (cd web && npm run build)
  # Entry bundles are content-hashed (index-XXXX.js / theme-XXXX.css); check
  # index.html plus at least one hashed JS and CSS entry rather than fixed names.
  [ -f "web/dist/index.html" ] || die "expected web/dist/index.html after build"
  ls web/dist/index-*.js  >/dev/null 2>&1 || die "expected a hashed web/dist/index-*.js after build"
  ls web/dist/theme-*.css >/dev/null 2>&1 || die "expected a hashed web/dist/theme-*.css after build"
  ok "SPA bundle built"
else
  warn "no web/package.json; phase 07 not applied? continuing without SPA"
fi

# ---- 3. chalkd binary ----------------------------------------------------

if [ "${CHALK_DEV_SKIP_BUILD:-0}" = "1" ]; then
  warn "skipping go build (CHALK_DEV_SKIP_BUILD=1)"
  [ -x bin/chalkd ] || die "no bin/chalkd and skip-build set; nothing to run"
else
  log "go build (chalkd)"
  mkdir -p bin
  CGO_ENABLED=0 go build -trimpath \
    -ldflags="-X github.com/scuq/chalk/internal/version.Version=0.0.0-dev \
              -X github.com/scuq/chalk/internal/version.Commit=local-dev" \
    -o bin/chalkd ./cmd/chalkd
  ok "chalkd built"
fi

# ---- 4. Migrations -------------------------------------------------------

log "applying migrations"
./bin/chalkd --migrate-only --tls-mode=off

# ---- 5. (Removed) legacy alice/bob/carol seed + friendship seed --------
#
# Phase 09b's session auth requires WebAuthn-registered users, so the
# pre-seeded fixture UUIDs aren't loggable into anyway. Users register
# via the SPA's signup flow; friendships are made via the in-SPA
# friend-request UI. The historical fixtures live in
# bootstrap/fixtures/users.sql if you ever want to revive them, but
# they're not part of the make-dev path anymore.

# ---- 6. Run chalkd in foreground ----------------------------------------

cat <<EOF

${c_green}===========================================================
chalk dev server starting
===========================================================${c_reset}

  URL:       http://${LISTEN}/
  DB:        ${CHALK_DB_URL}
  Logs:      stdout below

  Stop:      Ctrl-C
  Cleanup:   make dev-down  (stops + removes the PG container)

  First-time setup:
    1. Open the URL above
    2. Register an account via the signup flow (WebAuthn passkey)
    3. The admin user (CHALK_ADMIN_USERNAME) bootstraps automatically;
       additional users register through the SPA.
    4. To test multi-user flows, register a second account in another
       browser profile (or a private window) and add them as a friend
       from the first.

EOF

exec ./bin/chalkd --listen="$LISTEN" --tls-mode=off --log-level=info
