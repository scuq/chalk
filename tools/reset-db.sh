#!/usr/bin/env bash
# tools/reset-db.sh
# Drop and recreate the chalk dev database. Destroys all data.

set -euo pipefail

read -r -p "this will WIPE the chalk dev database. type 'wipe' to continue: " confirm
if [ "$confirm" != "wipe" ]; then
  echo "aborted"
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -q '^chalk-pg$'; then
  echo "chalk-pg is not running. start the dev stack first." >&2
  exit 1
fi

docker exec -i chalk-pg psql -U postgres <<'SQL'
DROP DATABASE IF EXISTS chalk;
CREATE DATABASE chalk OWNER chalk;
SQL

echo "chalk database reset. run 'make bootstrap' to re-apply migrations."
