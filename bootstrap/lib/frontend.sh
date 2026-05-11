#!/usr/bin/env bash
# bootstrap/lib/frontend.sh
# Helpers for building and testing the SPA in phase 07+.
#
# This lib assumes common.sh is sourced; it doesn't try to load it
# itself (matches the convention from postgres.sh, server.sh, etc.).
#
# Exposes:
#   web_check_node       -- verify node + npm available; die otherwise
#   web_install          -- `npm ci` in web/ (or npm install if no lockfile)
#   web_build            -- `npm run build` in web/
#   web_typecheck        -- `npm run typecheck` in web/
#   e2e_check_playwright -- verify Playwright is installed; die otherwise
#   e2e_install          -- install Playwright + browsers in test/e2e/
#   e2e_run [args...]    -- run Playwright test/e2e with chalkd already up

WEB_DIR="${CHALK_REPO_ROOT}/web"
E2E_DIR="${CHALK_REPO_ROOT}/test/e2e"

# -- Node helpers ----------------------------------------------------------

web_check_node() {
  if ! command -v node >/dev/null 2>&1; then
    die "node not found; install Node.js >= 20 to build the SPA"
  fi
  local v
  v="$(node --version 2>/dev/null | sed 's/^v//')"
  case "$v" in
    2[0-9].*|[3-9][0-9].*)
      log_step "node ${v} ok"
      ;;
    *)
      die "node ${v} too old; require >= 20"
      ;;
  esac
  if ! command -v npm >/dev/null 2>&1; then
    die "npm not found; install Node.js with npm"
  fi
}

web_install() {
  if [ ! -d "$WEB_DIR" ]; then
    die "web/ missing: $WEB_DIR"
  fi
  if [ ! -f "$WEB_DIR/package.json" ]; then
    die "web/package.json missing"
  fi
  local install_cmd="install"
  if [ -f "$WEB_DIR/package-lock.json" ]; then
    install_cmd="ci"
  fi
  log_step "npm ${install_cmd} (in web/)"
  if [ "$CHALK_DRY_RUN" != "1" ]; then
    (cd "$WEB_DIR" && npm "$install_cmd")
  fi
}

web_build() {
  if [ "$CHALK_DRY_RUN" = "1" ]; then
    log_dry "would: cd web && npm run build"
    return 0
  fi
  log_step "npm run build (in web/)"
  (cd "$WEB_DIR" && npm run build)
}

web_typecheck() {
  if [ "$CHALK_DRY_RUN" = "1" ]; then
    log_dry "would: cd web && npm run typecheck"
    return 0
  fi
  log_step "npm run typecheck (in web/)"
  (cd "$WEB_DIR" && npm run typecheck)
}

# -- Playwright helpers ----------------------------------------------------

e2e_install() {
  if [ ! -d "$E2E_DIR" ]; then
    die "test/e2e missing: $E2E_DIR"
  fi
  log_step "npm ci (in test/e2e/)"
  if [ "$CHALK_DRY_RUN" != "1" ]; then
    if [ -f "$E2E_DIR/package-lock.json" ]; then
      (cd "$E2E_DIR" && npm ci)
    else
      (cd "$E2E_DIR" && npm install)
    fi
    # Try Playwright's bundled --with-deps install first. On
    # Ubuntu CI images this is the fast path. On Debian/Arch/
    # other non-Ubuntu distros it sometimes fails on OS package
    # name drift (e.g. trixie dropped ttf-ubuntu-font-family);
    # in that case, fall back to installing chromium alone.
    # Chromium runs fine without those font packages.
    log_step "playwright install (chromium, with deps if possible)"
    if (cd "$E2E_DIR" && npx playwright install --with-deps chromium); then
      log_step "  playwright deps installed"
    else
      log_warn "  --with-deps failed (common on Debian/non-Ubuntu); retrying without deps"
      (cd "$E2E_DIR" && npx playwright install chromium) \
        || die "playwright install chromium failed; install Node deps manually"
      log_warn "  chromium downloaded but OS libs not installed by us."
      log_warn "  if the browser fails to launch later, install libs manually, e.g.:"
      log_warn "    sudo apt-get install -y libnss3 libatk-bridge2.0-0t64 libgtk-3-0t64 \\"
      log_warn "      libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2t64"
    fi
  fi
}

e2e_check_playwright() {
  if [ ! -d "$E2E_DIR/node_modules/@playwright/test" ]; then
    die "playwright not installed; run e2e_install first"
  fi
}

# e2e_run -- expects CHALK_TEST_HTTP_1 to be set (via server_up_n earlier).
# Forwards remaining args to `npx playwright test`.
e2e_run() {
  if [ -z "${CHALK_TEST_HTTP_1:-}" ]; then
    die "e2e_run: CHALK_TEST_HTTP_1 not set; start chalkd via server_up_n first"
  fi
  log_step "playwright test (against ${CHALK_TEST_HTTP_1})"
  if [ "$CHALK_DRY_RUN" != "1" ]; then
    (cd "$E2E_DIR" && \
      CHALK_BASE_URL="$CHALK_TEST_HTTP_1" \
      npx playwright test "$@")
  fi
}
