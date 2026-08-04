# Phase 72 — chalkctl backup, restore, and maintenance mode

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.5.9. Operator documentation in
[deployment.md](deployment.md).
**Tag:** `#chalkctl` → `tools/where.sh -g chalkctl`

## Why

Self-hosting is only real if you can leave the machine you started on. A `pg_dump`
alone is not enough for chalk, because the database is not the whole state: the
TOTP encryption key (`CHALK_TOTP_ENC_KEY`) lives in the env file, and without it
every user's authenticator app stops working after a restore — a dump that
restores "successfully" into a server nobody can log into.

Design decisions:

- **One password-protected archive** holding the database *and* the secrets that
  the database is useless without.
- **Restore into a working deployment, not a bare host.** You run `chalkctl
  init` on the new machine first, so it gets its own certificates and you can
  see it serving before any data is at stake; the restore then replaces the
  contents. Everyone stays signed in and keeps their history; only passkeys need
  re-adding, and only if the hostname changed.
- **Confirm before destroying.** Restore prints where the backup came from and
  asks; a failure mid-way leaves existing data exactly as it was.
- **Backups do not interrupt anyone.**
- **Maintenance mode is a served page, not a dead port.** Taking chalkd down
  gave users a browser error. `chalkctl maint` serves a real "chalk is under
  maintenance" page with an operator note, keeping the address and its
  certificate live throughout, so nothing has to be re-trusted when it comes
  back.

## What landed

- **72-1 … 72-4** — `chalkctl backup` / `restore`: archive format, secret
  capture, atomic replace, provenance display and confirmation, plus the
  integration test.
- **72-5** — `chalkctl maint` serves the notice page instead of the app.

## Where it lives

`internal/chalkctl/backup.go`, `restore.go`, `archive.go`, `maint.go`,
`state.go`, `render.go`; `test/integration/backup_restore_test.go`.

## Note on the numbering

One early commit (`745c68a`) is labelled `phase 72-1` but is unread-landing feed
work, unrelated to this phase — the number was reused by mistake. The
backup/restore arc is `25b4ef0` and `840c46e`.
