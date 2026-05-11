#!/usr/bin/env bash
# apply-phase07-fix3.sh
# Fix #3 for chalk phase 07.
#
# Patches bootstrap/lib/frontend.sh so e2e_install no longer aborts
# when `playwright install --with-deps chromium` fails on Debian
# trixie (and similar non-Ubuntu Linuxes).
#
# Background:
#   Playwright bundles an Ubuntu-specific list of "browser dependency"
#   packages and apt-installs them via --with-deps. On Debian trixie
#   the list includes packages that no longer exist (ttf-unifont
#   renamed to fonts-unifont, ttf-ubuntu-font-family dropped entirely)
#   so apt-get exits 100 and Playwright treats the whole install as a
#   failure -- even though it had already downloaded the chromium
#   binary successfully and that binary runs fine without those fonts.
#
# Fix:
#   1. Try Playwright's --with-deps install first (works on Ubuntu and
#      every CI image).
#   2. If that fails, fall back to a bare `playwright install chromium`
#      which only downloads the browser, not the OS deps.
#   3. Print a one-liner the user can run manually if Chromium fails
#      to launch later due to actually-missing libs.
#
# This is the conservative read: the bootstrap's job is to test
# chalkd + the SPA + a browser. OS package management belongs in the
# OS, not in a bootstrap script.
#
# Usage:
#   ./apply-phase07-fix3.sh                # apply, with diff preview
#   ./apply-phase07-fix3.sh --dry-run      # show the diff, change nothing
#   ./apply-phase07-fix3.sh --no-test      # skip the post-apply re-install
#   ./apply-phase07-fix3.sh --repo=PATH    # explicit repo path

set -euo pipefail
IFS=$'\n\t'

DRY_RUN=0
DO_TEST=1
REPO=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-test) DO_TEST=0 ;;
    --repo=*)  REPO="${arg#*=}" ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown flag: $arg" >&2; exit 1 ;;
  esac
done

c_reset=$'\033[0m'
c_red=$'\033[31m'
c_green=$'\033[32m'
c_yellow=$'\033[33m'
c_cyan=$'\033[36m'

log()  { printf '%s» %s%s\n' "$c_cyan" "$*" "$c_reset"; }
ok()   { printf '%s✓ %s%s\n' "$c_green" "$*" "$c_reset"; }
warn() { printf '%s! %s%s\n' "$c_yellow" "$*" "$c_reset" >&2; }
err()  { printf '%s✗ %s%s\n' "$c_red" "$*" "$c_reset" >&2; }
die()  { err "$*"; exit 1; }

looks_like_chalk_repo() {
  local d="$1"
  [ -f "$d/go.mod" ] && \
    [ -f "$d/bootstrap/lib/frontend.sh" ] && \
    grep -q '^module github.com/scuq/chalk$' "$d/go.mod" 2>/dev/null
}

if [ -z "$REPO" ]; then
  if looks_like_chalk_repo "$PWD"; then REPO="$PWD"
  elif looks_like_chalk_repo "$HOME/chalk"; then REPO="$HOME/chalk"
  else die "couldn't find chalk repo with bootstrap/lib/frontend.sh; cd into it or pass --repo=PATH"
  fi
fi
REPO="$(cd "$REPO" && pwd)"
looks_like_chalk_repo "$REPO" || die "not a chalk repo (or phase 07 not applied): $REPO"
ok "found repo: $REPO"

TARGET="$REPO/bootstrap/lib/frontend.sh"
[ -f "$TARGET" ] || die "$TARGET not found; apply phase 07 first"

# Sanity: the buggy line we expect to replace must be present.
if ! grep -qF 'npx playwright install --with-deps chromium' "$TARGET"; then
  ok "already patched (no '--with-deps' install line found) -- nothing to do"
  exit 0
fi

WORK="$(mktemp -d -t chalk-phase07-fix3-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# We rewrite the whole e2e_install function in-place. Cleanest approach:
# extract everything except the function, then append the new function.
# Both versions live between the comment "# e2e_install -- ..." (or the
# function declaration line) and the closing "}" at column 0.
#
# To keep this robust, we use an awk state machine: find the line
# `e2e_install() {` (start), then skip until the first standalone `}`
# at column 0 (end), and substitute our replacement body.

awk '
  BEGIN { in_fn = 0; printed_replacement = 0 }
  /^e2e_install\(\) \{/ {
    in_fn = 1
    # Emit the replacement.
    print "e2e_install() {"
    print "  if [ ! -d \"$E2E_DIR\" ]; then"
    print "    die \"test/e2e missing: $E2E_DIR\""
    print "  fi"
    print "  log_step \"npm ci (in test/e2e/)\""
    print "  if [ \"$CHALK_DRY_RUN\" != \"1\" ]; then"
    print "    if [ -f \"$E2E_DIR/package-lock.json\" ]; then"
    print "      (cd \"$E2E_DIR\" && npm ci)"
    print "    else"
    print "      (cd \"$E2E_DIR\" && npm install)"
    print "    fi"
    print "    # Try Playwright'\''s bundled --with-deps install first. On"
    print "    # Ubuntu CI images this is the fast path. On Debian/Arch/"
    print "    # other non-Ubuntu distros it sometimes fails on OS package"
    print "    # name drift (e.g. trixie dropped ttf-ubuntu-font-family);"
    print "    # in that case, fall back to installing chromium alone."
    print "    # Chromium runs fine without those font packages."
    print "    log_step \"playwright install (chromium, with deps if possible)\""
    print "    if (cd \"$E2E_DIR\" && npx playwright install --with-deps chromium); then"
    print "      log_step \"  playwright deps installed\""
    print "    else"
    print "      log_warn \"  --with-deps failed (common on Debian/non-Ubuntu); retrying without deps\""
    print "      (cd \"$E2E_DIR\" && npx playwright install chromium) \\"
    print "        || die \"playwright install chromium failed; install Node deps manually\""
    print "      log_warn \"  chromium downloaded but OS libs not installed by us.\""
    print "      log_warn \"  if the browser fails to launch later, install libs manually, e.g.:\""
    print "      log_warn \"    sudo apt-get install -y libnss3 libatk-bridge2.0-0t64 libgtk-3-0t64 \\\\\""
    print "      log_warn \"      libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2t64\""
    print "    fi"
    print "  fi"
    print "}"
    printed_replacement = 1
    next
  }
  in_fn && /^\}/ {
    in_fn = 0
    next
  }
  in_fn { next }
  { print }
  END {
    if (!printed_replacement) {
      print "ERROR: e2e_install function not found in input" > "/dev/stderr"
      exit 1
    }
  }
' "$TARGET" > "$WORK/frontend.sh"

# Safety checks.
# 1. Old buggy line must be gone.
if grep -qF 'npx playwright install --with-deps chromium' "$WORK/frontend.sh" \
   && ! grep -qF 'if (cd "$E2E_DIR" && npx playwright install --with-deps chromium); then' "$WORK/frontend.sh"; then
  die "internal: old --with-deps call still present in non-fallback form"
fi
# 2. New fallback line must be present.
if ! grep -qF 'npx playwright install chromium' "$WORK/frontend.sh"; then
  die "internal: fallback 'install chromium' line missing from patched file"
fi
# 3. File must syntax-check as bash.
if ! bash -n "$WORK/frontend.sh"; then
  die "internal: patched frontend.sh has syntax errors"
fi
# 4. Size sanity.
in_size=$(wc -c < "$TARGET")
out_size=$(wc -c < "$WORK/frontend.sh")
if [ "$out_size" -lt $((in_size * 8 / 10)) ]; then
  die "internal: patched file size ($out_size) suspiciously smaller than original ($in_size)"
fi
ok "patched frontend.sh built and syntax-checked"

log "diff against current $TARGET"
echo
if cmp -s "$TARGET" "$WORK/frontend.sh"; then
  ok "current frontend.sh already matches -- nothing to do"
  exit 0
fi
diff -u "$TARGET" "$WORK/frontend.sh" || true
echo

if [ "$DRY_RUN" = "1" ]; then
  warn "dry-run -- not writing changes"
  exit 0
fi

printf 'apply the fix? [y/N] '
read -r reply
case "$reply" in
  y|Y|yes|YES) ok "applying" ;;
  *) die "aborted by user" ;;
esac

ts="$(date +%Y%m%d-%H%M%S)"
backup="${TARGET}.bak-fix3-${ts}"
cp "$TARGET" "$backup"
ok "backup written: $backup"

cp "$WORK/frontend.sh" "$TARGET"
ok "patched $TARGET"

if [ "$DO_TEST" = "1" ]; then
  log "verifying lib is still sourceable"
  # Source the patched file in a subshell with the minimum env vars
  # the lib uses, to confirm it parses end-to-end.
  if ! (
    export CHALK_REPO_ROOT="$REPO"
    log_step() { :; }
    log_warn() { :; }
    log_ok()   { :; }
    log_dry()  { :; }
    die()      { return 1; }
    # shellcheck disable=SC1090
    . "$TARGET"
    # Verify the function got redefined as expected.
    type e2e_install >/dev/null 2>&1
  ); then
    err "patched lib failed to source; restoring backup"
    cp "$backup" "$TARGET"
    die "rolled back"
  fi
  ok "lib sources cleanly and exports e2e_install"
elif [ "$DO_TEST" = "0" ]; then
  warn "skipping source check (--no-test)"
fi

echo
ok "phase 07 fix 3 applied"
cat <<EOF

Next:
  cd $REPO
  ./bootstrap/phase-07-frontend-shell.sh

If the bootstrap fails at the playwright install step again,
something else is broken; paste the output.

If the bootstrap gets past install but the smoke spec fails with
"browser fails to launch", install Chromium's runtime libs manually:

  sudo apt-get update
  sudo apt-get install -y \\
    libnss3 libatk-bridge2.0-0t64 libgtk-3-0t64 \\
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 \\
    libgbm1 libasound2t64

Then re-run the bootstrap.

Rollback:
  cp $backup $TARGET

EOF
