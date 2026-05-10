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

Use these in tests rather than creating your own. Other test data should
live in transactions that roll back, or be cleaned up explicitly.

## Library

| File | Purpose |
|---|---|
| `lib/common.sh` | Logging, phase markers, file/git helpers — sourced first |
| `lib/checks.sh` | Host environment checks (Go, Docker, OS) |
| `lib/postgres.sh` | Ephemeral Postgres start/stop/migrate/seed |
| `lib/testing.sh` | Test runners (Go, shellcheck) |
| `lib/browsers.sh` | Playwright orchestration (phase 13+) |

Source via `chalk_use_lib <name>` after `common.sh` is loaded.

## Requirements

- Bash 5.x or newer (macOS: `brew install bash`)
- Go 1.23+
- Docker 24+
- `git`
- Optional: `shellcheck`, `psql`

## Phases

| # | Script | Adds |
|---|---|---|
| 00 | `phase-00-init.sh` | Repo scaffold, hooks, library |
| 01 | `phase-01-go-skeleton.sh` | `chalkd` Go binary skeleton |
| 02 | `phase-02-container.sh` | Dockerfile, compose, healthcheck |
| 03 | `phase-03-postgres.sh` | pgx pool, migrations runner, store |
| 04 | `phase-04-ws-relay.sh` | WebSocket hub, ping/pong, plaintext echo |
| 05 | `phase-05-pubsub.sh` | LISTEN/NOTIFY fan-out, multi-instance |
| 06 | `phase-06-presence.sh` | Multi-device presence with TTL |
| 07 | `phase-07-frontend-shell.sh` | Theming, Hack font, sounds, roster, composer |
| 08 | `phase-08-channels.sh` | Channels, threading |
| 09 | `phase-09-blobs.sh` | Encrypted attachments (AES-256-GCM) |
| 10 | `phase-10-mls.sh` | CoreCrypto WASM, MLS groups |
| 11 | `phase-11-friending.sh` | Friend requests, encrypted presence |
| 12 | `phase-12-hardening.sh` | Rate limits, GC, metrics |
| 13 | `phase-13-cross-browser.sh` | Playwright matrix |
