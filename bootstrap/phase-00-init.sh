#!/usr/bin/env bash
# bootstrap/phase-00-init.sh
# Verifies the repo scaffolding is in place. Adds nothing material itself
# (the scaffold ships with the repo); rather, this phase asserts host
# environment + lints the bootstrap library so we trust later phases.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"
chalk_use_lib checks
chalk_use_lib testing

PHASE="00"
PHASE_NAME="init"

phase_begin "$PHASE" "$PHASE_NAME"

phase_step "host environment checks"
check_os
check_command git "install git from your package manager"
check_command docker "install docker desktop or docker engine"
check_command go "install go 1.23+ from https://go.dev/dl/"
check_go_version 1.23

phase_step "verifying repo layout"
expected_dirs=(
  bootstrap/lib bootstrap/fixtures
  cmd/chalkd
  internal/config internal/server internal/store internal/pubsub
  internal/proto internal/auth internal/presence internal/crypto internal/version
  migrations
  web web/fonts web/icons web/vendor
  test/integration test/e2e
  docker
  docs
  tools
)
for d in "${expected_dirs[@]}"; do
  [ -d "${CHALK_REPO_ROOT}/${d}" ] || die "missing directory: ${d}"
done
log_step "all expected directories present"

phase_step "verifying baseline files"
expected_files=(
  README.md LICENSE CHANGELOG.md
  .gitignore .editorconfig .gitattributes .tool-versions .dockerignore
  Makefile go.mod
  bootstrap/README.md
  bootstrap/run-all.sh
  bootstrap/lib/common.sh
  bootstrap/lib/checks.sh
  bootstrap/lib/postgres.sh
  bootstrap/lib/testing.sh
  bootstrap/lib/browsers.sh
  bootstrap/fixtures/users.sql
  bootstrap/fixtures/seed.sh
)
for f in "${expected_files[@]}"; do
  [ -f "${CHALK_REPO_ROOT}/${f}" ] || die "missing file: ${f}"
done
log_step "all expected files present"

phase_step "running shellcheck on bootstrap (if available)"
shellcheck_bootstrap

phase_step "ensuring git repo is initialized"
if ! git_inited; then
  if [ "$CHALK_DRY_RUN" = "1" ]; then
    log_dry "would: git init"
  else
    git -C "$CHALK_REPO_ROOT" init -q
    log_step "git initialized"
  fi
fi

phase_step "marking executable permissions on scripts"
if [ "$CHALK_DRY_RUN" != "1" ]; then
  find "${CHALK_REPO_ROOT}/bootstrap" -name '*.sh' -exec chmod +x {} +
fi

phase_step "committing"
git_commit_phase "$PHASE" "$PHASE_NAME"

phase_done "$PHASE"
