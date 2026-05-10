#!/usr/bin/env bash
# bootstrap/phase-01-go-skeleton.sh
# Verifies the Go skeleton (already shipped in the scaffold) builds and tests cleanly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"
chalk_use_lib checks
chalk_use_lib testing

PHASE="01"
PHASE_NAME="go-skeleton"

phase_begin "$PHASE" "$PHASE_NAME"
require_phase "00"

phase_step "go environment"
checks_go

phase_step "verifying go module structure"
expected=(
  go.mod
  cmd/chalkd/main.go
  internal/version/version.go
  internal/config/config.go
  internal/config/config_test.go
)
for f in "${expected[@]}"; do
  [ -f "${CHALK_REPO_ROOT}/${f}" ] || die "missing: ${f}"
done
log_step "go skeleton files present"

phase_step "go vet"
go_vet_check

phase_step "go test (unit, no postgres needed)"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  cd "$CHALK_REPO_ROOT"
  go test -race -count=1 -short ./internal/config/...
fi

phase_step "go build (release flags)"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  cd "$CHALK_REPO_ROOT"
  mkdir -p bin
  CGO_ENABLED=0 go build -trimpath \
    -ldflags="-s -w -X github.com/scuq/chalk/internal/version.Version=0.0.0-dev -X github.com/scuq/chalk/internal/version.Commit=phase01" \
    -o bin/chalkd ./cmd/chalkd
fi

phase_step "binary smoke test"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  out="$(./bin/chalkd --version 2>&1)"
  echo "$out" | grep -q "chalkd 0.0.0-dev" || die "version output unexpected: $out"
  log_step "  ${out}"
fi

phase_step "committing"
git_commit_phase "$PHASE" "$PHASE_NAME"

phase_done "$PHASE"
