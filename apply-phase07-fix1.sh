#!/usr/bin/env bash
# apply-phase07-fix1.sh
# Fix #1 for chalk phase 07.
#
# Patches internal/server/spa.go to fix TestSPA_DirectoryListingRefused.
#
# The bug: my v1 spa.go did the SPA fallback decision AFTER opening
# the file in the embedded FS. When the URL path resolved to a
# directory (e.g. /icons -> dist/icons/), Open succeeded as a dir
# handle, IsDir() was true, and the handler returned 404 -- killing
# the SPA route. SPAs route on URL pattern, not on FS state; the
# client should own all extensionless paths.
#
# The fix: decide SPA fallback by path.Ext == "" BEFORE touching the
# FS. Files with extensions still get the real-404-or-content
# treatment so missing assets are visible.
#
# Usage:
#   ./apply-phase07-fix1.sh                # apply, with diff preview
#   ./apply-phase07-fix1.sh --dry-run      # show the diff, change nothing
#   ./apply-phase07-fix1.sh --no-test      # skip the post-apply go test
#   ./apply-phase07-fix1.sh --repo=PATH    # explicit repo path

set -euo pipefail
IFS=$'\n\t'

# ---- args ----------------------------------------------------------------

DRY_RUN=0
DO_TEST=1
REPO=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-test) DO_TEST=0 ;;
    --repo=*)  REPO="${arg#*=}" ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown flag: $arg" >&2; exit 1 ;;
  esac
done

# ---- pretty output -------------------------------------------------------

c_reset=$'\033[0m'
c_dim=$'\033[2m'
c_red=$'\033[31m'
c_green=$'\033[32m'
c_yellow=$'\033[33m'
c_cyan=$'\033[36m'

log()  { printf '%s» %s%s\n' "$c_cyan" "$*" "$c_reset"; }
ok()   { printf '%s✓ %s%s\n' "$c_green" "$*" "$c_reset"; }
warn() { printf '%s! %s%s\n' "$c_yellow" "$*" "$c_reset" >&2; }
err()  { printf '%s✗ %s%s\n' "$c_red" "$*" "$c_reset" >&2; }
die()  { err "$*"; exit 1; }
dry()  { printf '%s[dry-run]%s %s\n' "$c_dim" "$c_reset" "$*"; }

# ---- locate repo ---------------------------------------------------------

looks_like_chalk_repo() {
  local d="$1"
  [ -f "$d/go.mod" ] && \
    [ -f "$d/internal/server/spa.go" ] && \
    grep -q '^module github.com/scuq/chalk$' "$d/go.mod" 2>/dev/null
}

if [ -z "$REPO" ]; then
  if looks_like_chalk_repo "$PWD"; then REPO="$PWD"
  elif looks_like_chalk_repo "$HOME/chalk"; then REPO="$HOME/chalk"
  else die "couldn't find chalk repo with internal/server/spa.go; cd into it or pass --repo=PATH"
  fi
fi
REPO="$(cd "$REPO" && pwd)"
looks_like_chalk_repo "$REPO" || die "not a chalk repo (or phase 07 not applied): $REPO"
ok "found repo: $REPO"

TARGET="$REPO/internal/server/spa.go"
[ -f "$TARGET" ] || die "$TARGET not found; apply phase 07 first"

# ---- embedded payload ----------------------------------------------------
# The corrected spa.go is embedded inline below in a heredoc with NO
# variable expansion (quoted 'EOF'). Writing to a temp file lets us
# diff before clobbering.

WORK="$(mktemp -d -t chalk-phase07-fix1-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/spa.go" <<'CHALK_SPA_GO_EOF'
package server

import (
	"errors"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// spaHandler serves the SPA from an embedded filesystem rooted at the
// dist/ subdirectory of webFS. The dist/ subtree is what esbuild emits
// (index.html, index.js, theme.css plus any chunk files); we serve it
// at the URL root.
//
// Behavior:
//   * GET /                       -> dist/index.html
//   * GET /<path> (no extension)  -> dist/index.html  (SPA fallback so
//                                    the client router owns deep links).
//                                    This applies whether or not the
//                                    path resolves to anything in the
//                                    embedded FS -- the SPA owns the
//                                    URL namespace for extensionless
//                                    routes.
//   * GET /<path>.<ext>           -> dist/<path>.<ext> if it exists,
//                                    404 otherwise (real not-found so
//                                    missing assets are visible to
//                                    devs and to the browser's network
//                                    panel)
//
// Caching: index.html is no-cache (always revalidate so users see new
// bundles on next load). Other assets get a short max-age (5 min)
// since the bundle filenames don't yet carry content hashes. Phase 13
// can switch to hashed filenames + immutable caching.
//
// Dotfiles and ".." traversal are refused as a defense-in-depth
// measure; the dist/ tree shouldn't have any.
func spaHandler(webFS fs.FS, distDir string) (http.Handler, error) {
	dist, err := fs.Sub(webFS, distDir)
	if err != nil {
		return nil, err
	}
	// Verify index.html exists at startup so a misconfigured embed
	// fails loudly rather than silently 404'ing every request.
	if _, err := fs.Stat(dist, "index.html"); err != nil {
		return nil, err
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serveSPA(w, r, dist)
	}), nil
}

func serveSPA(w http.ResponseWriter, r *http.Request, dist fs.FS) {
	upath := strings.TrimPrefix(r.URL.Path, "/")
	if upath == "" {
		serveIndex(w, r, dist)
		return
	}
	// Reject path traversal and any dotfile segments before anything
	// else -- these always return 404 regardless of routing.
	clean := path.Clean(upath)
	if clean == "." || strings.HasPrefix(clean, "../") {
		http.NotFound(w, r)
		return
	}
	for _, seg := range strings.Split(clean, "/") {
		if strings.HasPrefix(seg, ".") {
			http.NotFound(w, r)
			return
		}
	}

	// Extensionless paths belong to the SPA client router. Serve
	// index.html unconditionally; the client decides what to render
	// for /channels/general, /settings, /icons, whatever. Doing this
	// BEFORE the fs.Open avoids two pitfalls:
	//   1. If the path happens to resolve to a directory inside dist/
	//      (e.g. dist/icons), Open returns a successful directory
	//      handle and we'd 404 on the IsDir() check below, hiding the
	//      SPA route from the client.
	//   2. If the path resolves to nothing, we'd 404 instead of
	//      letting the SPA route handle it.
	if path.Ext(clean) == "" {
		serveIndex(w, r, dist)
		return
	}

	f, err := dist.Open(clean)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			http.NotFound(w, r)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		http.Error(w, "stat: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if info.IsDir() {
		// Has an extension and resolves to a directory? Bizarre but
		// we treat as 404 -- directory listings would leak the bundle
		// layout and the client never asks for one with a real .ext.
		http.NotFound(w, r)
		return
	}

	// embed.FS files implement io.ReadSeeker; http.ServeContent handles
	// content-type sniffing, ETag, range requests, conditional GETs.
	rs, ok := f.(io.ReadSeeker)
	if !ok {
		http.Error(w, "internal: file not seekable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=300")
	http.ServeContent(w, r, clean, info.ModTime(), rs)
}

func serveIndex(w http.ResponseWriter, r *http.Request, dist fs.FS) {
	f, err := dist.Open("index.html")
	if err != nil {
		http.Error(w, "index.html missing", http.StatusInternalServerError)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	rs, ok := f.(io.ReadSeeker)
	if !ok {
		http.Error(w, "internal: index.html not seekable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, "index.html", info.ModTime(), rs)
}
CHALK_SPA_GO_EOF

# Sanity-check the payload actually wrote.
if ! grep -q 'func spaHandler' "$WORK/spa.go"; then
  die "internal: embedded payload is malformed (no spaHandler func)"
fi
ok "extracted patched spa.go to temp"

# ---- diff preview --------------------------------------------------------

log "diff against current $TARGET"
echo
if cmp -s "$TARGET" "$WORK/spa.go"; then
  ok "current spa.go already matches the fix -- nothing to do"
  exit 0
fi
diff -u "$TARGET" "$WORK/spa.go" || true
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

# ---- backup + write ------------------------------------------------------

ts="$(date +%Y%m%d-%H%M%S)"
backup="${TARGET}.bak-fix1-${ts}"
cp "$TARGET" "$backup"
ok "backup written: $backup"

cp "$WORK/spa.go" "$TARGET"
ok "patched $TARGET"

# ---- verify --------------------------------------------------------------

if [ "$DO_TEST" = "1" ]; then
  cd "$REPO"
  log "running 'go build ./...'"
  if ! go build ./...; then
    err "go build failed after patch -- restoring backup"
    cp "$backup" "$TARGET"
    die "rolled back; check error above"
  fi
  ok "go build clean"

  log "running spa unit tests"
  if ! go test -race -count=1 ./internal/server/...; then
    err "tests still failing after patch -- restoring backup"
    cp "$backup" "$TARGET"
    die "rolled back; check test output above"
  fi
  ok "tests pass"
elif [ "$DO_TEST" = "0" ]; then
  warn "skipping go build/test (--no-test)"
fi

echo
ok "phase 07 fix 1 applied"
cat <<EOF

Next:
  cd $REPO
  ./bootstrap/phase-07-frontend-shell.sh

Rollback:
  cp $backup $TARGET

EOF
