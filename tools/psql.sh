#!/usr/bin/env bash
# tools/psql.sh
# Open a psql shell against the local dev database.

set -euo pipefail

# Prefer the running container; fall back to host psql if installed.
if docker ps --format '{{.Names}}' | grep -q '^chalk-pg$'; then
  exec docker exec -it chalk-pg psql -U chalk -d chalk
fi

if command -v psql >/dev/null 2>&1; then
  exec psql "postgres://chalk:chalk@127.0.0.1:5432/chalk?sslmode=disable"
fi

echo "tools/psql.sh: chalk-pg container not running and no host psql found" >&2
echo "  start the dev stack first:  make docker-up" >&2
exit 1
