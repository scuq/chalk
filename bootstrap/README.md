# Bootstrap

This directory builds chalk in phases. Each phase is a shell script that:

1. Adds files / makes mutations
2. Runs its own self-contained tests against an ephemeral Postgres
3. Commits its changes (if tests pass)
4. Writes a `.bootstrap/phase-NN.done` marker

## Usage

```sh
# Run every phase needed to bring the project to its current latest state
bootstrap/run-all.sh

# Force re-run of a specific phase
bootstrap/run-all.sh --only 03

# Re-run from a phase onward
bootstrap/run-all.sh --from 05

# Dry-run: show what would happen
bootstrap/run-all.sh --dry-run

# Quiet mode (errors only)
CHALK_QUIET=1 bootstrap/run-all.sh
```

## Phase contract

Every `phase-NN-*.sh` script:

- Sources `lib/common.sh` first
- Calls `phase_begin NN "name"` near the top
- Calls `require_phase NN-1` for prerequisites
- Uses `write_file_if_absent` (idempotent) or `write_file_force` (overwrite)
- Sets up an ephemeral Postgres via `pg_start_ephemeral` for tests, with `trap pg_stop_ephemeral EXIT`
- Calls `pg_apply_migrations` and `pg_seed_users` for tests that need them
- Runs its tests via `go_test_phase`, `go_build_check`, etc.
- Commits via `git_commit_phase NN "name"`
- Calls `phase_done NN` only on success

## Test users

Every phase test gets three canonical users (idempotent upsert):

| handle | UUID |
|---|---|
| alice  | `00000000-0000-0000-0000-00000000a11c` |
| bob    | `00000000-0000-0000-0000-000000000b0b`  |
| carol  | `00000000-0000-0000-0000-0000000ca201` |

For phases 11a onward, two additional MLS-capable fixture users exist
that have completed KeyPackage publishing:

| handle | UUID |
|---|---|
| alice2 | `00000000-0000-0000-0000-00000000a112` |
| bob2   | `00000000-0000-0000-0000-000000000b02` |

Use these in tests rather than creating your own. Other test data should
live in transactions that roll back, or be cleaned up explicitly.

## Library

| File | Purpose |
|---|---|
| `lib/common.sh` | Logging, phase markers, file/git helpers — sourced first |
| `lib/checks.sh` | Host environment checks (Go, Docker, OS) |
| `lib/postgres.sh` | Ephemeral Postgres start/stop/migrate/seed |
| `lib/testing.sh` | Test runners (Go, shellcheck) |
| `lib/frontend.sh` | Frontend test runners (esbuild, Playwright) |
| `lib/server.sh` | chalkd build + integration test helpers |
| `lib/browsers.sh` | Playwright browser-installation orchestration |

Source via `chalk_use_lib <name>` after `common.sh` is loaded.

## Requirements

- Bash 5.x or newer (macOS: `brew install bash`)
- Go 1.23+
- Docker 24+
- `git`
- Node 18+ (for phases 07 and later)
- Optional: `shellcheck`, `psql`

## Phases

Phase numbering reflects the current plan and may diverge from the
historical scaffold file names. See `CHANGELOG.md` "Phase numbering
note" for the canonical mapping. Phases 09 and onward shipped (or
will ship) as tarball patches rather than the original
`phase-09-*.sh` stubs; this table reflects what each phase actually
delivers.

| # | Status | Adds |
|---|---|---|
| 00 | `phase-00-init.sh` | Repo scaffold, hooks, library |
| 01 | `phase-01-go-skeleton.sh` | `chalkd` Go binary skeleton |
| 02 | `phase-02-container.sh` | Dockerfile, compose, healthcheck |
| 03 | `phase-03-postgres.sh` | pgx pool, migrations runner, store |
| 04 | `phase-04-ws-relay.sh` | WebSocket hub, ping/pong, plaintext echo |
| 05 | `phase-05-pubsub.sh` | LISTEN/NOTIFY fan-out, multi-instance |
| 06 | `phase-06-presence.sh` | Multi-device presence with TTL |
| 07 | `phase-07-frontend-shell.sh` | Theming, Hack font, SPA shell |
| 08 | `phase-08-channels.sh` | Channels, threading |
| 08b | (tarball patch) | SPA channels: sidebar, create modal, friend picker |
| 08c | (tarball patch) | Handles in UI: `you (alice)`, `@bob` |
| 09a | (tarball patch) | Multi-tab: hub keyed by userID |
| 09b | (tarball patch) | Passkey auth + recovery codes |
| 09c | (tarball patch) | Invites + profile + email-change |
| 09d | (tarball patch) | Admin moderation (server + SPA + e2e) |
| 11a | (tarball patch) | CoreCrypto WASM + KeyPackages; relicense to GPL-3.0 |
| 11b | (tarball patch) | MLS DM encryption (11b-1, 11b-2, 11b-3 + hotfixes) |
| 11c | 🔮 planned | MLS multi-member channel encryption |
| 11d | 📐 designed | Multi-device + history transfer (see `docs/design/`) |
| 12 | 🔮 planned | Account lifecycle write paths |
| 13 | 🔮 planned | Encrypted attachments (AES-256-GCM) |
| 14 | 🔮 planned | Rate limits, metrics, GC, `--migrate-only` |
| 15 | 🔮 planned | Playwright cross-browser matrix |

The legacy `phase-09-blobs.sh` and `phase-10-mls.sh` stubs in this
directory remain for historical reference but are no longer the
canonical path to the current state. New phases land as tarball
patches that include their own validators; `run-all.sh` skips
already-done phases via the `.bootstrap/phase-NN.done` markers, so
the legacy stubs don't need to be deleted.
