#!/usr/bin/env bash
# tools/load-test.sh
# Placeholder for a quick smoke / load test against a running chalkd.
# Real load testing arrives in a later iteration (k6 scripts).

set -euo pipefail

URL="${1:-http://127.0.0.1:8443/healthz}"
N="${2:-100}"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl required" >&2
  exit 1
fi

echo "GET ${URL} x ${N}"
fails=0
start="$(date +%s%N)"
for _ in $(seq 1 "$N"); do
  if ! curl -fsS -o /dev/null "$URL"; then
    fails=$((fails + 1))
  fi
done
end="$(date +%s%N)"
elapsed_ms=$(( (end - start) / 1000000 ))
echo "completed in ${elapsed_ms}ms (${fails} failures)"
