#!/usr/bin/env bash
# apply-phase06.sh
# Apply chalk-phase06-v2.tar.gz to a chalk repo checkout.
#
# Usage:
#   apply-phase06.sh [--dry-run] [--no-diff] [--no-backup] [--no-build]
#                    [--archive=PATH] [--repo=PATH]
#
# Flags:
#   --dry-run    Print every cp/mkdir without doing it. No state changes.
#   --no-diff    Skip the diff preview of REPLACES files.
#   --no-backup  Skip the tarball backup of files about to be replaced.
#   --no-build   Skip `go build ./...` after copying (e.g. if you want to
#                inspect the tree first).
#   --archive=P  Path to the phase-06 tarball. Default:
#                /media/psf/scuqosx/Downloads/chalk-phase06-v2.tar.gz
#   --repo=P     Path to the chalk repo. Default: cwd if it looks like
#                a chalk repo; otherwise ~/chalk.
#
# What it does, in order:
#   1. Sanity-checks the repo (must be a git checkout with phase 05 done).
#   2. Extracts the archive into a temp directory.
#   3. Diffs every REPLACES file against your tree (unless --no-diff).
#   4. Pauses for your confirmation (unless --dry-run).
#   5. Backs up about-to-be-replaced files into a single tarball with
#      a timestamp (unless --no-backup or --dry-run).
#   6. Copies all phase-06 files into place.
#   7. Runs `go mod tidy` + `go build ./...` (unless --no-build).
#   8. Prints next steps.
#
# What it does NOT do:
#   - Run the bootstrap phase script. You do that yourself after the
#     applier completes, so you control timing.
#   - Commit anything to git. The applier leaves your working tree dirty
#     so you can review and stage as you like.
#   - Touch the migrations DB. Migrations apply when chalkd starts.
#
# Rollback:
#   If something looks wrong after applying, the easiest rollback is:
#       git checkout -- .
#       git clean -fd internal/friends internal/presence \
#                     internal/proto/frames_phase06.go \
#                     internal/server/ws_phase06.go \
#                     test/integration/presence_friends_test.go \
#                     migrations/0006_*.sql migrations/0007_*.sql \
#                     migrations/0008_*.sql migrations/0009_*.sql
#   Then re-apply the backup tarball if you want to restore exactly
#   what was on disk before:
#       cd <repo>
#       tar xzf .chalk-phase06-backup-<timestamp>.tar.gz
#
# Exit codes:
#   0  success
#   1  user-facing error (missing archive, repo not found, build fail, etc.)
#   2  internal error (this script has a bug)

set -euo pipefail
IFS=$'\n\t'

# ---- defaults & flag parsing --------------------------------------------

ARCHIVE_DEFAULT="/media/psf/scuqosx/Downloads/chalk-phase06-v2.tar.gz"
ARCHIVE=""
REPO=""
DRY_RUN=0
DO_DIFF=1
DO_BACKUP=1
DO_BUILD=1

for arg in "$@"; do
  case "$arg" in
    --dry-run)    DRY_RUN=1 ;;
    --no-diff)    DO_DIFF=0 ;;
    --no-backup)  DO_BACKUP=0 ;;
    --no-build)   DO_BUILD=0 ;;
    --archive=*)  ARCHIVE="${arg#*=}" ;;
    --repo=*)     REPO="${arg#*=}" ;;
    -h|--help)
      sed -n '2,/^# Exit codes:/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown flag: $arg" >&2
      echo "run with --help for usage" >&2
      exit 1
      ;;
  esac
done

# ---- pretty output ------------------------------------------------------

c_reset=$'\033[0m'
c_bold=$'\033[1m'
c_dim=$'\033[2m'
c_red=$'\033[31m'
c_green=$'\033[32m'
c_yellow=$'\033[33m'
c_cyan=$'\033[36m'

log()   { printf '%s» %s%s\n' "$c_cyan" "$*" "$c_reset"; }
ok()    { printf '%s✓ %s%s\n' "$c_green" "$*" "$c_reset"; }
warn()  { printf '%s! %s%s\n' "$c_yellow" "$*" "$c_reset" >&2; }
err()   { printf '%s✗ %s%s\n' "$c_red" "$*" "$c_reset" >&2; }
die()   { err "$*"; exit 1; }
dry()   { printf '%s[dry-run]%s %s\n' "$c_dim" "$c_reset" "$*"; }

# ---- locate archive -----------------------------------------------------

if [ -z "$ARCHIVE" ]; then
  ARCHIVE="$ARCHIVE_DEFAULT"
fi
if [ ! -f "$ARCHIVE" ]; then
  die "archive not found: $ARCHIVE
       pass --archive=PATH to override the default location"
fi
ok "found archive: $ARCHIVE"

# ---- locate repo --------------------------------------------------------

looks_like_chalk_repo() {
  local d="$1"
  [ -f "$d/go.mod" ] && \
    [ -d "$d/internal/server" ] && \
    [ -d "$d/internal/store" ] && \
    [ -d "$d/bootstrap" ] && \
    grep -q '^module github.com/scuq/chalk$' "$d/go.mod" 2>/dev/null
}

if [ -z "$REPO" ]; then
  if looks_like_chalk_repo "$PWD"; then
    REPO="$PWD"
  elif looks_like_chalk_repo "$HOME/chalk"; then
    REPO="$HOME/chalk"
  else
    die "couldn't find chalk repo; cd into it or pass --repo=PATH"
  fi
fi
REPO="$(cd "$REPO" && pwd)"
looks_like_chalk_repo "$REPO" || die "not a chalk repo: $REPO"
ok "found repo:    $REPO"

# ---- sanity: must be a clean-ish git tree --------------------------------

if [ -d "$REPO/.git" ] && [ "$DRY_RUN" = "0" ]; then
  cd "$REPO"
  if ! git diff --quiet HEAD 2>/dev/null; then
    warn "your working tree has uncommitted changes."
    warn "the applier overwrites several files; you'll lose those edits"
    warn "if you don't commit or stash first."
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

# ---- check phase 05 marker (informational, not blocking) ----------------

PHASE05_MARKER="$REPO/.bootstrap/phase-05.done"
if [ ! -f "$PHASE05_MARKER" ]; then
  warn "phase 05 doesn't appear complete (no $PHASE05_MARKER)"
  warn "phase 06 needs phase 05 done; this may fail."
  warn "(if you've completed phase 05 manually, ignore this warning)"
fi

# ---- extract archive into temp dir --------------------------------------

WORKDIR="$(mktemp -d -t chalk-phase06-XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT
log "extracting archive to $WORKDIR"
if [ "$DRY_RUN" = "0" ]; then
  tar -C "$WORKDIR" -xzf "$ARCHIVE"
fi
SRC="$WORKDIR/chalk-phase06-v2"

if [ "$DRY_RUN" = "0" ] && [ ! -d "$SRC" ]; then
  die "extracted archive doesn't contain chalk-phase06-v2/ at the top level"
fi
[ "$DRY_RUN" = "0" ] && ok "archive extracted"

# ---- file inventory -----------------------------------------------------

# Files that REPLACE existing tracked files. These get diffed and backed up.
REPLACES=(
  "internal/proto/proto.go"
  "internal/pubsub/notifier.go"
  "internal/server/ws.go"
  "internal/server/server.go"
  "cmd/chalkd/main.go"
  "bootstrap/lib/server.sh"
  "bootstrap/phase-06-presence.sh"
)

# Files that are NEW (don't yet exist in the repo). No diff possible; no
# backup needed.
NEW_FILES=(
  "migrations/0006_user_lifecycle.sql"
  "migrations/0007_friendships.sql"
  "migrations/0008_presence.sql"
  "migrations/0009_messages_nullable_sender.sql"
  "internal/friends/store.go"
  "internal/friends/store_test.go"
  "internal/presence/store.go"
  "internal/presence/loops.go"
  "internal/presence/config.go"
  "internal/proto/frames_phase06.go"
  "internal/server/ws_phase06.go"
  "test/integration/presence_friends_test.go"
)

# Directories that may need to be created. Listed explicitly so we never
# rely on brace expansion (which has bitten this delivery before).
ENSURE_DIRS=(
  "$REPO/migrations"
  "$REPO/internal/friends"
  "$REPO/internal/presence"
  "$REPO/internal/proto"
  "$REPO/internal/pubsub"
  "$REPO/internal/server"
  "$REPO/cmd/chalkd"
  "$REPO/bootstrap"
  "$REPO/bootstrap/lib"
  "$REPO/test/integration"
)

# ---- verify every expected source file is present in the archive --------

log "verifying archive contents"
for f in "${REPLACES[@]}" "${NEW_FILES[@]}"; do
  if [ "$DRY_RUN" = "0" ] && [ ! -f "$SRC/$f" ]; then
    die "archive missing expected file: $f"
  fi
done
ok "all 19 phase-06 files present in archive"

# ---- diff REPLACES -------------------------------------------------------

if [ "$DO_DIFF" = "1" ]; then
  log "diffing files about to be replaced"
  echo
  any_changes=0
  for f in "${REPLACES[@]}"; do
    src="$SRC/$f"
    dst="$REPO/$f"
    if [ ! -f "$dst" ]; then
      printf '  %s(new)%s %s\n' "$c_dim" "$c_reset" "$f"
      continue
    fi
    if [ "$DRY_RUN" = "1" ]; then
      printf '  %s(would diff)%s %s\n' "$c_dim" "$c_reset" "$f"
      continue
    fi
    if cmp -s "$dst" "$src"; then
      printf '  %s(no change)%s %s\n' "$c_dim" "$c_reset" "$f"
    else
      printf '  %s(differs)%s   %s\n' "$c_yellow" "$c_reset" "$f"
      any_changes=1
    fi
  done
  echo
  if [ "$any_changes" = "1" ] && [ "$DRY_RUN" = "0" ]; then
    warn "some replaces show diffs (expected: proto.go gets DeviceType field,"
    warn "  pubsub/notifier.go extends Event, server files add phase-06 wiring,"
    warn "  main.go gets 2 imports + 3 lines, lib/server.sh adds server_kill_n,"
    warn "  phase-06-presence.sh replaces the stub)."
    printf '\nshow full diff for each replaced file? [y/N] '
    read -r reply
    case "$reply" in
      y|Y|yes|YES)
        for f in "${REPLACES[@]}"; do
          src="$SRC/$f"
          dst="$REPO/$f"
          [ -f "$dst" ] || continue
          if ! cmp -s "$dst" "$src"; then
            printf '\n%s===== %s =====%s\n' "$c_bold" "$f" "$c_reset"
            diff -u "$dst" "$src" || true
          fi
        done
        echo
        ;;
    esac
  fi
fi

# ---- confirm before changes ---------------------------------------------

if [ "$DRY_RUN" = "0" ]; then
  printf '\nready to apply. proceed? [y/N] '
  read -r reply
  case "$reply" in
    y|Y|yes|YES) ok "applying" ;;
    *) die "aborted by user" ;;
  esac
fi

# ---- backup --------------------------------------------------------------

if [ "$DO_BACKUP" = "1" ] && [ "$DRY_RUN" = "0" ]; then
  ts="$(date +%Y%m%d-%H%M%S)"
  backup="$REPO/.chalk-phase06-backup-$ts.tar.gz"
  log "backing up replaced files to .chalk-phase06-backup-$ts.tar.gz"
  # Build the list of files that actually exist in the repo (some may not
  # if the user is mid-migration). Use -T to read paths from a temp file
  # so file names with whitespace don't break.
  bk_list="$WORKDIR/backup-list.txt"
  : > "$bk_list"
  for f in "${REPLACES[@]}"; do
    [ -f "$REPO/$f" ] && printf '%s\n' "$f" >> "$bk_list"
  done
  if [ -s "$bk_list" ]; then
    tar -C "$REPO" -czf "$backup" -T "$bk_list"
    ok "backup written: $backup"
  else
    warn "no existing files to back up (all REPLACES are actually NEW?)"
  fi
elif [ "$DO_BACKUP" = "0" ]; then
  warn "skipping backup (--no-backup)"
fi

# ---- ensure directories --------------------------------------------------

log "ensuring target directories exist"
for d in "${ENSURE_DIRS[@]}"; do
  if [ "$DRY_RUN" = "1" ]; then
    dry "mkdir -p $d"
  else
    mkdir -p "$d"
  fi
done

# ---- copy files ----------------------------------------------------------

copy_file() {
  local rel="$1"
  local src="$SRC/$rel"
  local dst="$REPO/$rel"
  if [ "$DRY_RUN" = "1" ]; then
    dry "cp $rel"
    return
  fi
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

# Preserve executable bit on the phase script (tar already set it but cp
# preserved file mode of the source, which should be fine; double-check).
if [ "$DRY_RUN" = "0" ]; then
  chmod +x "$REPO/bootstrap/phase-06-presence.sh"
fi
ok "files in place"

# ---- go mod tidy + build -------------------------------------------------

if [ "$DO_BUILD" = "1" ] && [ "$DRY_RUN" = "0" ]; then
  cd "$REPO"
  log "running 'go mod tidy'"
  if ! go mod tidy; then
    err "go mod tidy failed; check the error above"
    err "(common cause: new imports for friends/presence packages need"
    err " entries in go.sum -- tidy should fix this; if it doesn't,"
    err " run 'go mod download' then try again)"
    exit 1
  fi
  ok "go mod tidy clean"

  log "running 'go build ./...'"
  if ! go build ./...; then
    err "go build failed; see errors above"
    err ""
    err "first build is the hardest checkpoint. common causes:"
    err "  - drift between the patches and your local edits"
    err "  - missing imports in your tree (run go mod download)"
    err "  - phase 05 was not fully merged in"
    err ""
    err "if the error is unrelated to phase-06 packages, your phase-05"
    err "tree may already be broken (check 'git status' and 'go vet')."
    err ""
    err "rollback: 'git checkout -- .' restores everything; the backup"
    err "tarball at .chalk-phase06-backup-*.tar.gz holds the originals."
    exit 1
  fi
  ok "go build clean"

  log "running fast unit tests (friends, presence)"
  if ! go test ./internal/friends/... ./internal/presence/...; then
    warn "unit tests failed -- see output above"
    warn "this might be acceptable if presence tests need DB; check"
    warn "the failure message before deciding"
  else
    ok "unit tests pass"
  fi
elif [ "$DO_BUILD" = "0" ]; then
  warn "skipping go build (--no-build)"
fi

# ---- summary -------------------------------------------------------------

echo
ok "phase 06 patches applied"
if [ "$DRY_RUN" = "1" ]; then
  warn "this was a DRY RUN -- nothing was changed"
  exit 0
fi

cat <<EOF

${c_bold}Next steps:${c_reset}

  ${c_cyan}1.${c_reset} Review the diff one more time:
       cd $REPO
       git status
       git diff --stat

  ${c_cyan}2.${c_reset} Run the phase-06 bootstrap (this is the real test):
       ./bootstrap/phase-06-presence.sh

     Expected wall-clock: ~15 seconds. Ends with "phase 06 complete".

  ${c_cyan}3.${c_reset} If green, commit:
       git add -A
       git commit -m "phase 06: presence + friendships + lifecycle schema"

  ${c_cyan}4.${c_reset} If the bootstrap fails, paste the first error to me along
     with the chalkd log path it prints. The backup tarball can roll
     you back to pre-apply state.

EOF
