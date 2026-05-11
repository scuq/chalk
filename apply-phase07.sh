#!/usr/bin/env bash
# apply-phase07.sh
# Apply chalk-phase07.tar.gz to a chalk repo checkout.
#
# Same shape as apply-phase06.sh. Differences:
#   - Adds Node.js >= 20 check (phase 07 needs npm)
#   - The archive contains a root-level embed.go that REPLACES the
#     existing one (changes embed pattern from "all:web" to "all:web/dist")
#   - 7 REPLACES files (vs 7 in phase 06; different set)
#   - 21 NEW files
#
# Flags: --dry-run, --no-diff, --no-backup, --no-build,
#        --archive=PATH, --repo=PATH

set -euo pipefail
IFS=$'\n\t'

ARCHIVE_DEFAULT="/media/psf/scuqosx/Downloads/chalk-phase07.tar.gz"
ARCHIVE=""
REPO=""
DRY_RUN=0
DO_DIFF=1
DO_BACKUP=1
DO_BUILD=1

for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_RUN=1 ;;
    --no-diff)   DO_DIFF=0 ;;
    --no-backup) DO_BACKUP=0 ;;
    --no-build)  DO_BUILD=0 ;;
    --archive=*) ARCHIVE="${arg#*=}" ;;
    --repo=*)    REPO="${arg#*=}" ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown flag: $arg" >&2
      exit 1
      ;;
  esac
done

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

[ -z "$ARCHIVE" ] && ARCHIVE="$ARCHIVE_DEFAULT"
[ -f "$ARCHIVE" ] || die "archive not found: $ARCHIVE"
ok "found archive: $ARCHIVE"

looks_like_chalk_repo() {
  local d="$1"
  [ -f "$d/go.mod" ] && [ -d "$d/internal/server" ] && \
    grep -q '^module github.com/scuq/chalk$' "$d/go.mod" 2>/dev/null
}

if [ -z "$REPO" ]; then
  if looks_like_chalk_repo "$PWD"; then REPO="$PWD"
  elif looks_like_chalk_repo "$HOME/chalk"; then REPO="$HOME/chalk"
  else die "couldn't find chalk repo; cd into it or pass --repo=PATH"
  fi
fi
REPO="$(cd "$REPO" && pwd)"
looks_like_chalk_repo "$REPO" || die "not a chalk repo: $REPO"
ok "found repo:    $REPO"

PHASE06_MARKER="$REPO/.bootstrap/phase-06.done"
if [ ! -f "$PHASE06_MARKER" ]; then
  warn "phase 06 doesn't appear complete (no $PHASE06_MARKER)"
  warn "phase 07 requires phase 06 done; this may fail."
fi

# Node.js >= 20 check (phase 07 specific)
if [ "$DRY_RUN" = "0" ]; then
  if ! command -v node >/dev/null 2>&1; then
    die "node not found; install Node.js >= 20 before applying phase 07"
  fi
  node_v="$(node --version 2>/dev/null | sed 's/^v//')"
  case "$node_v" in
    2[0-9].*|[3-9][0-9].*) ok "node ${node_v} ok" ;;
    *) die "node ${node_v} too old; require >= 20" ;;
  esac
  command -v npm >/dev/null 2>&1 || die "npm not found"
fi

if [ -d "$REPO/.git" ] && [ "$DRY_RUN" = "0" ]; then
  cd "$REPO"
  if ! git diff --quiet HEAD 2>/dev/null; then
    warn "your working tree has uncommitted changes."
    printf 'continue anyway? [y/N] '
    read -r reply
    case "$reply" in
      y|Y|yes|YES) ok "continuing on user confirmation" ;;
      *) die "aborted; commit or stash and re-run" ;;
    esac
  else
    ok "working tree clean"
  fi
fi

# Refuse to run if a leftover extracted archive sits at the repo root
# (the bug that bit phase-06 apply: go build ./... walked into it).
for leftover in chalk-phase06 chalk-phase06-v2 chalk-phase07; do
  if [ -d "$REPO/$leftover" ]; then
    warn "found leftover directory at repo root: $leftover"
    warn "this will confuse 'go build ./...' -- remove it first:"
    warn "  rm -rf $REPO/$leftover"
    die "remove leftover dirs and re-run"
  fi
done

WORKDIR="$(mktemp -d -t chalk-phase07-XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT
log "extracting archive to $WORKDIR"
[ "$DRY_RUN" = "0" ] && tar -C "$WORKDIR" -xzf "$ARCHIVE"
SRC="$WORKDIR/chalk-phase07"
[ "$DRY_RUN" = "0" ] && [ ! -d "$SRC" ] && die "archive doesn't contain chalk-phase07/"
[ "$DRY_RUN" = "0" ] && ok "archive extracted"

# Files that REPLACE existing tracked files. These get diffed and backed up.
REPLACES=(
  "embed.go"
  "web/index.html"
  "internal/server/server.go"
  "cmd/chalkd/main.go"
  "docker/Dockerfile"
  "docker/Dockerfile.dev"
  "bootstrap/phase-07-frontend-shell.sh"
)

# Files that are NEW.
NEW_FILES=(
  "web/package.json"
  "web/tsconfig.json"
  "web/build.mjs"
  "web/dist/.gitkeep"
  "web/dist/index.html"
  "web/src/index.tsx"
  "web/src/proto.ts"
  "web/src/ws-client.ts"
  "web/src/theme.css"
  "web/src/components/App.tsx"
  "web/src/components/StatusBar.tsx"
  "web/src/components/MessageList.tsx"
  "web/src/components/Composer.tsx"
  "internal/server/spa.go"
  "internal/server/spa_test.go"
  "bootstrap/lib/frontend.sh"
  "test/e2e/package.json"
  "test/e2e/tsconfig.json"
  "test/e2e/playwright.config.ts"
  "test/e2e/smoke.spec.ts"
)

ENSURE_DIRS=(
  "$REPO/web"
  "$REPO/web/src"
  "$REPO/web/src/components"
  "$REPO/web/dist"
  "$REPO/internal/server"
  "$REPO/cmd/chalkd"
  "$REPO/docker"
  "$REPO/bootstrap"
  "$REPO/bootstrap/lib"
  "$REPO/test/e2e"
)

log "verifying archive contents"
for f in "${REPLACES[@]}" "${NEW_FILES[@]}"; do
  if [ "$DRY_RUN" = "0" ] && [ ! -f "$SRC/$f" ]; then
    die "archive missing expected file: $f"
  fi
done
ok "all $((${#REPLACES[@]} + ${#NEW_FILES[@]})) phase-07 files present"

if [ "$DO_DIFF" = "1" ]; then
  log "diffing files about to be replaced"
  echo
  any=0
  for f in "${REPLACES[@]}"; do
    src="$SRC/$f"; dst="$REPO/$f"
    if [ ! -f "$dst" ]; then
      printf '  %s(new)%s %s\n' "$c_dim" "$c_reset" "$f"; continue
    fi
    if [ "$DRY_RUN" = "1" ]; then
      printf '  %s(would diff)%s %s\n' "$c_dim" "$c_reset" "$f"; continue
    fi
    if cmp -s "$dst" "$src"; then
      printf '  %s(no change)%s %s\n' "$c_dim" "$c_reset" "$f"
    else
      printf '  %s(differs)%s   %s\n' "$c_yellow" "$c_reset" "$f"
      any=1
    fi
  done
  echo
  if [ "$any" = "1" ] && [ "$DRY_RUN" = "0" ]; then
    warn "some REPLACES differ. expected: embed.go switches to all:web/dist,"
    warn "  web/index.html replaces the placeholder with the Preact shell,"
    warn "  server.go adds SPA mounting, main.go passes chalk.Web,"
    warn "  Dockerfiles add frontend stage, phase-07 script replaces stub."
    printf '\nshow full diff for each? [y/N] '
    read -r reply
    case "$reply" in
      y|Y|yes|YES)
        for f in "${REPLACES[@]}"; do
          src="$SRC/$f"; dst="$REPO/$f"
          [ -f "$dst" ] || continue
          if ! cmp -s "$dst" "$src"; then
            printf '\n===== %s =====\n' "$f"
            diff -u "$dst" "$src" || true
          fi
        done
        echo
        ;;
    esac
  fi
fi

if [ "$DRY_RUN" = "0" ]; then
  printf '\nready to apply. proceed? [y/N] '
  read -r reply
  case "$reply" in
    y|Y|yes|YES) ok "applying" ;;
    *) die "aborted by user" ;;
  esac
fi

if [ "$DO_BACKUP" = "1" ] && [ "$DRY_RUN" = "0" ]; then
  ts="$(date +%Y%m%d-%H%M%S)"
  backup="$REPO/.chalk-phase07-backup-$ts.tar.gz"
  log "backing up to .chalk-phase07-backup-$ts.tar.gz"
  bk_list="$WORKDIR/backup-list.txt"
  : > "$bk_list"
  for f in "${REPLACES[@]}"; do
    [ -f "$REPO/$f" ] && printf '%s\n' "$f" >> "$bk_list"
  done
  if [ -s "$bk_list" ]; then
    tar -C "$REPO" -czf "$backup" -T "$bk_list"
    ok "backup written: $backup"
  fi
elif [ "$DO_BACKUP" = "0" ]; then
  warn "skipping backup (--no-backup)"
fi

log "ensuring target directories exist"
for d in "${ENSURE_DIRS[@]}"; do
  if [ "$DRY_RUN" = "1" ]; then dry "mkdir -p $d"
  else mkdir -p "$d"
  fi
done

copy_file() {
  local rel="$1"
  local src="$SRC/$rel" dst="$REPO/$rel"
  if [ "$DRY_RUN" = "1" ]; then dry "cp $rel"; return; fi
  cp "$src" "$dst"
}

log "copying NEW files"
for f in "${NEW_FILES[@]}"; do
  copy_file "$f"
  [ "$DRY_RUN" = "0" ] && printf '  %s+%s %s\n' "$c_green" "$c_reset" "$f"
done

log "copying REPLACES files"
for f in "${REPLACES[@]}"; do
  copy_file "$f"
  [ "$DRY_RUN" = "0" ] && printf '  %s~%s %s\n' "$c_yellow" "$c_reset" "$f"
done

if [ "$DRY_RUN" = "0" ]; then
  chmod +x "$REPO/bootstrap/phase-07-frontend-shell.sh"
fi
ok "files in place"

if [ "$DO_BUILD" = "1" ] && [ "$DRY_RUN" = "0" ]; then
  cd "$REPO"
  log "running 'go mod tidy'"
  go mod tidy || die "go mod tidy failed; see errors above"
  ok "go mod tidy clean"

  log "running 'go build ./...'"
  if ! go build ./...; then
    err "go build failed; see errors above"
    err ""
    err "common causes:"
    err "  - drift between the patches and your local edits"
    err "  - chalk-phase07/ leftover at repo root (delete it)"
    err "  - the web/dist/ placeholder index.html missing for the embed"
    err ""
    err "rollback: 'git checkout -- .' restores; backup tarball at"
    err "          .chalk-phase07-backup-*.tar.gz"
    exit 1
  fi
  ok "go build clean"

  log "running fast unit tests (server has new spa_test.go)"
  if ! go test -race -count=1 -short ./internal/server/...; then
    warn "unit tests failed -- see output above"
  else
    ok "unit tests pass"
  fi
elif [ "$DO_BUILD" = "0" ]; then
  warn "skipping go build (--no-build)"
fi

echo
ok "phase 07 patches applied"
if [ "$DRY_RUN" = "1" ]; then
  warn "this was a DRY RUN -- nothing was changed"
  exit 0
fi

cat <<EOF

Next steps:

  1. Review:
       cd $REPO
       git status
       git diff --stat

  2. Run the phase-07 bootstrap (this is the real test):
       ./bootstrap/phase-07-frontend-shell.sh

     Wall-clock target: ~2-3 minutes the first run (npm install +
     Playwright chromium download). Subsequent runs ~30 seconds.

  3. If green, commit:
       git add -A
       git commit -m "phase 07: frontend shell (Preact + esbuild + Playwright)"

  4. If the bootstrap fails, paste the first error and (if it's the
     Playwright spec) the trace file from test/e2e/test-results/.

EOF

