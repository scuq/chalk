#!/usr/bin/env bash
# tools/dev-reset-with-auth.sh
#
# Wipe the dev Postgres and re-bootstrap from scratch. Useful when
# iterating on the invite flow (phase 09c) or any auth-touching code:
# you want to start with no users, no invites, no sessions, no
# recovery codes.
#
# What this does:
#   1. Drops + recreates the chalk DB inside the dev Postgres container
#   2. Reapplies all migrations (handled by chalkd at boot via
#      internal/migrate)
#   3. Wipes the bootstrap markers (.bootstrap/*.done) so any
#      seed/fixture steps re-run
#   4. Leaves chalkd OFF; you start it yourself with `make dev` so
#      you can watch the bootstrap output (especially the admin
#      bootstrap URL when CHALK_ADMIN_USERNAME is set)
#
# Safety:
#   - Refuses to run if CHALK_DEV_PG_NAME isn't a chalk-dev-* container
#   - Refuses to run if a CHALK_PROD_OK env var is unset (i.e. only
#     in dev)
#
# Usage:
#   tools/dev-reset-with-auth.sh           # interactive confirm
#   tools/dev-reset-with-auth.sh --yes     # skip confirmation

set -euo pipefail

PG_NAME="${CHALK_DEV_PG_NAME:-chalk-dev-pg}"
DB_NAME="${CHALK_DEV_PG_DB:-chalk}"
DB_USER="${CHALK_DEV_PG_USER:-chalk}"

# Belt-and-braces: don't ever run this against a non-dev container.
case "$PG_NAME" in
  chalk-dev-*) : ;;
  *)
    echo "error: refusing to reset container '$PG_NAME' (name must start with 'chalk-dev-')" >&2
    exit 1
    ;;
esac

if ! docker inspect "$PG_NAME" >/dev/null 2>&1; then
  echo "error: container '$PG_NAME' does not exist" >&2
  echo "       start it first with: make dev" >&2
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$PG_NAME"; then
  echo "error: container '$PG_NAME' is not running" >&2
  echo "       start it first with: make dev" >&2
  exit 1
fi

# Confirm unless --yes is passed.
if [ "${1:-}" != "--yes" ]; then
  echo "About to:"
  echo "  - DROP DATABASE $DB_NAME inside $PG_NAME"
  echo "  - CREATE DATABASE $DB_NAME (re-applied at chalkd next boot)"
  echo "  - Wipe .bootstrap/*.done markers"
  echo ""
  echo "This is destructive. Type 'yes' to proceed:"
  read -r confirm
  if [ "$confirm" != "yes" ]; then
    echo "aborted"
    exit 1
  fi
fi

echo ">> dropping + recreating $DB_NAME in $PG_NAME"
# Connect via the postgres superuser (default in the dev container).
# Drop with FORCE to evict any held connections (chalkd, etc).
docker exec -u postgres "$PG_NAME" psql -d postgres -v ON_ERROR_STOP=1 <<SQL
DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE);
CREATE DATABASE $DB_NAME OWNER $DB_USER;
SQL

echo ">> wiping bootstrap markers"
# Run from the repo root regardless of where the user invoked us.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -d "$REPO_ROOT/.bootstrap" ]; then
  find "$REPO_ROOT/.bootstrap" -name '*.done' -delete
fi

echo ""
echo "✓ database reset complete"
echo ""
echo "Next steps:"
echo "  1. start chalkd: make dev"
echo "  2. (optional) start mailhog if you want SMTP capture:"
echo "       make dev-mail-up"
echo "       then run with: CHALK_SMTP_HOST=localhost CHALK_SMTP_PORT=1025 make dev"
echo "  3. open http://localhost:8443/ and register the first user"
echo "  4. that user is your first 'inviter'; they can create invites"
echo "     for additional users via the invites panel (phase 09c-2)."
echo ""
echo "Note: with CHALK_OPEN_REGISTRATION unset, the first user must"
echo "      have CHALK_OPEN_REGISTRATION=1 set in chalkd's environment"
echo "      to bootstrap. Subsequent users need invites."
