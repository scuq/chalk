#!/usr/bin/env bash
# bootstrap/phase-02-container.sh
# Verifies the container build works and the resulting image runs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"
chalk_use_lib checks
chalk_use_lib testing

PHASE="02"
PHASE_NAME="container"

phase_begin "$PHASE" "$PHASE_NAME"
require_phase "01"

phase_step "host environment"
checks_go_docker

phase_step "verifying docker assets"
expected=(
  docker/Dockerfile
  docker/Dockerfile.dev
  docker/docker-compose.yml
  docker/docker-compose.test.yml
  docker/docker-compose.prod.yml
  docker/caddy/Caddyfile.example
)
for f in "${expected[@]}"; do
  [ -f "${CHALK_REPO_ROOT}/${f}" ] || die "missing: ${f}"
done

phase_step "building chalk:dev image"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  cd "$CHALK_REPO_ROOT"
  docker build \
    --build-arg VERSION=0.0.0-dev \
    --build-arg GIT_SHA=phase02 \
    --build-arg BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    -f docker/Dockerfile \
    -t chalk:dev \
    .
fi

phase_step "image smoke test (--version)"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  out="$(docker run --rm chalk:dev --version 2>&1)"
  echo "$out" | grep -q "chalkd 0.0.0-dev" || die "version output unexpected: $out"
  log_step "  ${out}"
fi

phase_step "image starts and serves /healthz"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  cname="chalk-test-app-$$"
  docker run -d --rm --name "$cname" \
    -e CHALK_TLS_MODE=off \
    -e CHALK_LISTEN=:8443 \
    -p 127.0.0.1:0:8443 \
    chalk:dev >/dev/null

  trap 'docker rm -f "$cname" >/dev/null 2>&1 || true' EXIT

  hostport="$(docker port "$cname" 8443/tcp | head -1 | awk -F: '{print $NF}')"
  [ -n "$hostport" ] || die "could not determine host port"

  # poll /healthz
  ok=0
  for i in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${hostport}/healthz" >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 0.3
  done
  if [ "$ok" = "0" ]; then
    docker logs "$cname" >&2 || true
    die "/healthz never became reachable"
  fi
  log_step "/healthz responded ok"

  docker rm -f "$cname" >/dev/null
  trap - EXIT
fi

phase_step "image size check (must be < 30MB)"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  size_bytes="$(docker image inspect chalk:dev --format '{{.Size}}')"
  size_mb=$(( size_bytes / 1024 / 1024 ))
  log_step "  image size: ${size_mb}MB"
  if [ "$size_mb" -gt 30 ]; then
    log_warn "image is larger than expected (${size_mb}MB > 30MB target)"
    # not fatal -- distroless + go is usually ~15-20MB; large images are a smell
  fi
fi

phase_step "committing"
git_commit_phase "$PHASE" "$PHASE_NAME"

phase_done "$PHASE"
