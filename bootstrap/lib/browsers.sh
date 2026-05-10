#!/usr/bin/env bash
# bootstrap/lib/browsers.sh
# Helpers for orchestrating Playwright cross-browser tests.
# Implementation arrives in phase 13; lib is here from day one so phases
# that touch frontend can declare expectations.

# common.sh must be sourced first.

playwright_dir() { echo "${CHALK_REPO_ROOT}/test/e2e"; }

playwright_installed() {
  [ -d "$(playwright_dir)/node_modules/@playwright/test" ]
}

playwright_install() {
  local d
  d="$(playwright_dir)"
  if [ ! -f "${d}/package.json" ]; then
    log_step "no playwright package.json yet (phase 13 creates it)"
    return 0
  fi
  log_step "installing playwright deps"
  if [ "$CHALK_DRY_RUN" = "1" ]; then
    log_dry "would: npm ci && npx playwright install"
    return 0
  fi
  (cd "$d" && npm ci && npx playwright install --with-deps chromium firefox webkit)
}

playwright_run() {
  local project="${1:-}"
  local d
  d="$(playwright_dir)"
  if ! playwright_installed; then
    log_warn "playwright not installed; run phase 13 first"
    return 1
  fi
  log_step "running playwright tests${project:+ (project: $project)}"
  if [ "$CHALK_DRY_RUN" = "1" ]; then
    log_dry "would: npx playwright test${project:+ --project=$project}"
    return 0
  fi
  if [ -n "$project" ]; then
    (cd "$d" && npx playwright test --project="$project")
  else
    (cd "$d" && npx playwright test)
  fi
}
