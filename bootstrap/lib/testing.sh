#!/usr/bin/env bash
# bootstrap/lib/testing.sh
# Helpers for running phase-scoped tests.

# common.sh must be sourced first.

# Run go test with consistent flags. Honors CHALK_TEST_PGURL.
go_test_phase() {
  local pkg_pattern="$1"
  log_step "go test ${pkg_pattern}"
  if [ "$CHALK_DRY_RUN" = "1" ]; then
    log_dry "would: go test -race -count=1 ${pkg_pattern}"
    return 0
  fi
  cd "$CHALK_REPO_ROOT"
  CHALK_TEST_PGURL="${CHALK_TEST_PGURL:-}" \
    go test -race -count=1 "$pkg_pattern"
}

# Verify the binary builds.
go_build_check() {
  log_step "go build (verification)"
  if [ "$CHALK_DRY_RUN" = "1" ]; then
    log_dry "would: go build ./cmd/chalkd"
    return 0
  fi
  cd "$CHALK_REPO_ROOT"
  go build -o /tmp/chalkd-build-check ./cmd/chalkd
  rm -f /tmp/chalkd-build-check
}

# Verify go vet passes.
go_vet_check() {
  log_step "go vet"
  if [ "$CHALK_DRY_RUN" = "1" ]; then
    log_dry "would: go vet ./..."
    return 0
  fi
  cd "$CHALK_REPO_ROOT"
  go vet ./...
}

# Verify shell scripts pass shellcheck (if installed).
shellcheck_bootstrap() {
  if ! command -v shellcheck >/dev/null 2>&1; then
    log_step "shellcheck not installed; skipping"
    return 0
  fi
  log_step "shellcheck bootstrap/"
  if [ "$CHALK_DRY_RUN" = "1" ]; then
    log_dry "would: shellcheck bootstrap/**/*.sh"
    return 0
  fi
  cd "$CHALK_REPO_ROOT"
  find bootstrap -name '*.sh' -print0 | xargs -0 shellcheck -x
}
