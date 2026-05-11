#!/usr/bin/env bash
# apply-phase07-fix2.sh
# Fix #2 for chalk phase 07.
#
# Patches web/src/theme.css to remove the @font-face block that
# references /fonts/hack-regular.woff2 -- a file the project doesn't
# yet ship. esbuild treats absolute URLs in CSS url() as paths to
# resolve at build time, not as runtime references, so the build
# fails with "Could not resolve /fonts/hack-regular.woff2".
#
# The font chain still names "Hack" first; if you later drop a
# hack-regular.woff2 into web/fonts/ and want it loaded, add an
# @font-face back with a RELATIVE url like
# url("../../fonts/hack-regular.woff2") so esbuild can resolve and
# fingerprint it. For phase 07 we're fine without it -- ui-monospace
# is the OS default monospace on every modern platform.
#
# Usage:
#   ./apply-phase07-fix2.sh                # apply, with diff preview
#   ./apply-phase07-fix2.sh --dry-run      # show the diff, change nothing
#   ./apply-phase07-fix2.sh --no-test      # skip the post-apply npm build
#   ./apply-phase07-fix2.sh --repo=PATH    # explicit repo path

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
      sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
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

# Pattern that actually breaks the build: a CSS url() pointing at the
# missing font file. We grep for this -- not the bare filename -- so
# the safety check doesn't fire on harmless comment mentions.
BROKEN_PATTERN='url("/fonts/hack-regular.woff2")'

looks_like_chalk_repo() {
  local d="$1"
  [ -f "$d/go.mod" ] && \
    [ -f "$d/web/src/theme.css" ] && \
    grep -q '^module github.com/scuq/chalk$' "$d/go.mod" 2>/dev/null
}

if [ -z "$REPO" ]; then
  if looks_like_chalk_repo "$PWD"; then REPO="$PWD"
  elif looks_like_chalk_repo "$HOME/chalk"; then REPO="$HOME/chalk"
  else die "couldn't find chalk repo with web/src/theme.css; cd into it or pass --repo=PATH"
  fi
fi
REPO="$(cd "$REPO" && pwd)"
looks_like_chalk_repo "$REPO" || die "not a chalk repo (or phase 07 not applied): $REPO"
ok "found repo: $REPO"

TARGET="$REPO/web/src/theme.css"
[ -f "$TARGET" ] || die "$TARGET not found; apply phase 07 first"

# Idempotent: if the broken url() is already gone, exit cleanly.
if ! grep -qF "$BROKEN_PATTERN" "$TARGET"; then
  ok "broken url() reference not found -- nothing to do"
  exit 0
fi

WORK="$(mktemp -d -t chalk-phase07-fix2-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# Build the patched file by removing the @font-face block. State-
# machine awk: when we see the @font-face opening line, switch to
# "skipping" mode and emit a replacement comment. When we see a line
# starting with "}" (the closing brace of the @font-face block),
# exit skipping mode.
#
# The replacement comment intentionally does NOT mention the missing
# filename, so the safety check below doesn't false-positive on it.
awk '
  BEGIN { skip = 0 }
  /^@font-face \{/ && !skip {
    print "/* Phase 07 ships without a bundled font file. The font chain"
    print " * below names \"Hack\" first; OS monospace fallback covers the"
    print " * gap. To enable a real font later, add an @font-face block"
    print " * here with a RELATIVE url so esbuild can resolve it. */"
    skip = 1
    next
  }
  skip && /^\}/ {
    skip = 0
    next
  }
  !skip { print }
' "$TARGET" > "$WORK/theme.css"

# Safety checks against the patched output.
# 1. The broken url() pattern must be gone.
if grep -qF "$BROKEN_PATTERN" "$WORK/theme.css"; then
  die "internal: patched file still contains the broken url() pattern"
fi
# 2. Braces must still balance.
open_count=$(grep -c '{' "$WORK/theme.css" || true)
close_count=$(grep -c '}' "$WORK/theme.css" || true)
if [ "$open_count" != "$close_count" ]; then
  die "internal: brace count mismatch after patch ($open_count vs $close_count)"
fi
# 3. The file must not be empty or wildly truncated.
in_size=$(wc -c < "$TARGET")
out_size=$(wc -c < "$WORK/theme.css")
min_size=$((in_size * 90 / 100))
max_size=$((in_size * 105 / 100))
if [ "$out_size" -lt "$min_size" ] || [ "$out_size" -gt "$max_size" ]; then
  die "internal: patched file size ($out_size bytes) outside sanity range ($min_size..$max_size)"
fi
ok "extracted patched theme.css to temp"

log "diff against current $TARGET"
echo
if cmp -s "$TARGET" "$WORK/theme.css"; then
  ok "current theme.css already matches -- nothing to do"
  exit 0
fi
diff -u "$TARGET" "$WORK/theme.css" || true
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
backup="${TARGET}.bak-fix2-${ts}"
cp "$TARGET" "$backup"
ok "backup written: $backup"

cp "$WORK/theme.css" "$TARGET"
ok "patched $TARGET"

if [ "$DO_TEST" = "1" ]; then
  cd "$REPO/web"
  log "running 'npm run build'"
  if ! npm run build 2>&1; then
    err "npm build failed after patch -- restoring backup"
    cp "$backup" "$TARGET"
    die "rolled back; check error above"
  fi
  ok "npm build clean"

  log "verifying bundle artifacts"
  for f in index.html index.js theme.css; do
    if [ ! -f "$REPO/web/dist/$f" ]; then
      err "expected web/dist/$f after build; restoring backup"
      cp "$backup" "$TARGET"
      die "rolled back; rerun manually to debug"
    fi
  done
  ok "web/dist/index.html, index.js, theme.css present"
elif [ "$DO_TEST" = "0" ]; then
  warn "skipping npm build (--no-test)"
fi

echo
ok "phase 07 fix 2 applied"
cat <<EOF

Next:
  cd $REPO
  ./bootstrap/phase-07-frontend-shell.sh

Rollback:
  cp $backup $TARGET

EOF
