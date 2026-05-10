#!/usr/bin/env bash
# bootstrap/lib/postgres.sh
# Spin up an ephemeral Postgres in Docker for phase tests.
# Idempotent, cleans up reliably via traps.
#
# Exports:
#   CHALK_TEST_PGURL    -- connection string for tests
#   CHALK_TEST_PGCNAME  -- container name
#   CHALK_TEST_PGPORT   -- host port mapped to 5432

# common.sh must be sourced first.

CHALK_TEST_PG_IMAGE="${CHALK_TEST_PG_IMAGE:-postgres:17-alpine}"

# Pick a free port (best-effort; race window is small for our use).
_chalk_pick_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()' 2>/dev/null \
    || awk -v min=49152 -v max=65535 'BEGIN{srand(); print int(min+rand()*(max-min))}'
}

pg_start_ephemeral() {
  local phase="${PHASE_CURRENT:-x}"
  local cname="chalk-test-pg-${phase}-$$"
  local port
  port="$(_chalk_pick_port)"

  CHALK_TEST_PGCNAME="$cname"
  CHALK_TEST_PGPORT="$port"
  CHALK_TEST_PGURL="postgres://chalk:chalk@127.0.0.1:${port}/chalk?sslmode=disable"
  export CHALK_TEST_PGCNAME CHALK_TEST_PGPORT CHALK_TEST_PGURL

  log_step "starting ephemeral postgres (${cname} on :${port})"

  if [ "$CHALK_DRY_RUN" = "1" ]; then
    log_dry "would docker run ${CHALK_TEST_PG_IMAGE}"
    return 0
  fi

  docker run -d --rm \
    --name "$cname" \
    -e POSTGRES_DB=chalk \
    -e POSTGRES_USER=chalk \
    -e POSTGRES_PASSWORD=chalk \
    -e POSTGRES_INITDB_ARGS="--auth-host=md5" \
    -p "127.0.0.1:${port}:5432" \
    --health-cmd="pg_isready -U chalk -d chalk" \
    --health-interval=1s \
    --health-timeout=2s \
    --health-retries=30 \
    "$CHALK_TEST_PG_IMAGE" \
    -c log_min_messages=warning \
    -c fsync=off \
    -c synchronous_commit=off \
    -c full_page_writes=off \
    >/dev/null

  # Wait for healthy
  local i
  for i in $(seq 1 60); do
    local status
    status="$(docker inspect -f '{{.State.Health.Status}}' "$cname" 2>/dev/null || echo unknown)"
    if [ "$status" = "healthy" ]; then
      log_step "postgres ready on :${port}"
      return 0
    fi
    sleep 0.5
  done
  pg_dump_logs "$cname" || true
  pg_stop_ephemeral || true
  die "postgres failed to become healthy in time"
}

pg_dump_logs() {
  local cname="${1:-$CHALK_TEST_PGCNAME}"
  log_warn "--- postgres logs (${cname}) ---"
  docker logs "$cname" 2>&1 | tail -n 60 >&2 || true
  log_warn "--- end logs ---"
}

pg_stop_ephemeral() {
  local cname="${CHALK_TEST_PGCNAME:-}"
  [ -z "$cname" ] && return 0
  if [ "$CHALK_DRY_RUN" = "1" ]; then
    log_dry "would docker rm -f ${cname}"
    return 0
  fi
  docker rm -f "$cname" >/dev/null 2>&1 || true
  log_step "stopped postgres (${cname})"
  unset CHALK_TEST_PGCNAME CHALK_TEST_PGPORT CHALK_TEST_PGURL
}

# Apply migrations/*.sql in order. Phase 03 introduces a Go-based runner;
# this shell helper is the bootstrap-time fallback used for phase tests
# before that runner exists, and as a sanity check after.
pg_apply_migrations() {
  local mdir="${CHALK_REPO_ROOT}/migrations"
  [ -d "$mdir" ] || { log_step "no migrations/ yet"; return 0; }
  shopt -s nullglob
  local files=("$mdir"/*.sql)
  shopt -u nullglob
  if [ ${#files[@]} -eq 0 ]; then
    log_step "migrations/ is empty"
    return 0
  fi
  log_step "applying ${#files[@]} migration(s)"
  local f
  for f in "${files[@]}"; do
    local name
    name="$(basename "$f")"
    log_step "  → ${name}"
    if ! docker exec -i "$CHALK_TEST_PGCNAME" psql -U chalk -d chalk -v ON_ERROR_STOP=1 -q < "$f" >/dev/null; then
      pg_dump_logs
      die "migration failed: ${name}"
    fi
  done
}

# Apply the canonical 3-user fixture (alice, bob, carol) idempotently.
pg_seed_users() {
  local fixture="${CHALK_REPO_ROOT}/bootstrap/fixtures/users.sql"
  if [ ! -f "$fixture" ]; then
    log_step "no users fixture (skipping seed)"
    return 0
  fi
  log_step "seeding 3 test users"
  if ! docker exec -i "$CHALK_TEST_PGCNAME" psql -U chalk -d chalk -v ON_ERROR_STOP=1 -q < "$fixture" >/dev/null; then
    pg_dump_logs
    die "user seed failed"
  fi
}

# Convenience: full test-DB setup in one call.
pg_setup_for_tests() {
  pg_start_ephemeral
  pg_apply_migrations
  pg_seed_users
}
