# Phase 99 — DBCREDS: hardening database credentials at rest and in memory

**Status: planned, not started — a sketch.** Commissioned by scuq on
2026-08-09 as one of the two mitigations shipped with the R18
trust-model narrowing (phase 83, P83-A-R18-01): chalk does not defend
its authorization tables against an attacker who can write the
database, so the credentials that make that write cheap should be as
hard to steal as this stack can make them. The other mitigation —
client-derived roster-change notices — is phase 83's D.6.

**Tag:** `#dbcreds`.

---

## The problem — where the credentials live today

Verified against the current code (2026-08-09):

- `chalkctl init` writes **one 0600 env file** holding every secret:
  `CHALK_DB_URL` (the `chalk_app` role's password inline in the DSN),
  `CHALK_PG_PASSWORD` / `POSTGRES_PASSWORD` (the superuser), plus
  `CHALK_TOTP_ENC_KEY` and friends (`internal/chalkctl/init.go` —
  "env file (0600 — holds secrets)").
- The podman quadlets pass that file as **container environment**, so
  every secret is also readable from `/proc/<pid>/environ` of the
  running processes by anything with that user's (or root's) access,
  and appears in `podman inspect` output.
- chalkd holds the DSN in ordinary Go strings inside the pgx pool
  config for the life of the process; nothing prevents it from
  reaching logs, error chains, or a core dump.

Under phase 83's claim 2 the host may be read by malicious code; one
0600 file read (or one `/proc` read) currently yields a credential
that grants exactly the database write the R18 attack needs.

## The goal, honestly bounded

Raise the cost of obtaining a DB-write credential from *"read one
file"* to *"be root on the live host at runtime and defeat unit
isolation"*. That is the achievable goal — nothing here makes an
owned host safe (root can ptrace chalkd or decrypt whatever the unit
can decrypt; that is the R18/claim-1 boundary, stated in
threat-model.md), and nothing here defends against a malicious
operator. What it removes: credential theft via file exfiltration,
backup leakage, `/proc/environ` reads by same-user code, accidental
logging, and cold artifacts (core dumps, swap) — which is where real
compromises live.

## The sketch

- **At rest: systemd encrypted credentials, not env lines.** The DB
  secrets move out of `chalk.env` into `systemd-creds encrypt`ed
  blobs — sealed to the host TPM2 where present, host-key fallback
  where not — delivered via the quadlet's `LoadCredentialEncrypted=`
  into the unit's private credentials directory (ramfs,
  non-swappable, unit-scoped). chalkd reads
  `$CREDENTIALS_DIRECTORY/chalk-db-url` when present and falls back
  to the env var for one release. `POSTGRES_PASSWORD` for the
  postgres container gets the same treatment (podman `Secret=` or a
  credential, whichever the quadlet supports cleanly on this Debian).
- **In memory: read once, keep narrow, never print.** chalkd reads
  the credential as bytes, hands pgx its parsed config, zeroes its
  own copies (`fill(0)` — with the honest note that Go strings pgx
  retains internally are pgx's; the point is chalk's copies and
  chalk's logs), never places the DSN in an error or log line, and
  the unit sets `LimitCORE=0`. Environment delivery of the DSN ends —
  `/proc/environ` stops carrying secrets.
- **Rotation becomes one command.** `chalkctl dbcreds rotate`:
  generate a new `chalk_app` password, `ALTER ROLE`, re-encrypt the
  credential, restart the unit — cheap because chalkctl already owns
  the roles (`ensureDBRoles`), and cheap rotation is what makes a
  suspected leak survivable.
- **The env-var contract holds** (CLAUDE.md): `chalkctl init`
  generates the credentials fresh, `--force` preserves them, `update`
  backfills — migrating an existing deployment converts the env-file
  values into encrypted credentials on the first `update` and then
  strips them from `chalk.env`, leaving a comment naming where they
  went.

## Open questions for the review

1. **Can the password be eliminated instead of hidden?** Postgres
   `peer` auth over a shared Unix socket would mean no `chalk_app`
   password exists at all. Feasibility depends on podman user-ns
   mapping between the chalkd and postgres containers on this stack —
   worth one investigation slice before committing to the
   credential machinery; if it works, it supersedes most of 99-1 for
   the app role (the superuser password remains).
2. Does `CHALK_TOTP_ENC_KEY` join the same mechanism in this phase or
   a follow-up? (Same storage pattern, same win; scoped out of scuq's
   commission but the marginal cost is small.)
3. TPM2-less hosts (VMs without vTPM): host-key sealing still beats a
   plaintext file (survives backup/file exfiltration, not live-host
   compromise) — is that accepted, or should such hosts warn?

## Slices (sketch)

| Slice | Content |
|---|---|
| 99-1 | The socket/peer-auth investigation (open question 1) — decides the shape of the rest |
| 99-2 | Encrypted credentials: chalkctl generation, quadlet `LoadCredentialEncrypted=`, chalkd `$CREDENTIALS_DIRECTORY` read with env fallback, migration on `update` |
| 99-3 | In-memory hygiene: bytes-not-strings at read, zeroize chalk's copies, no-DSN-in-logs assertion, `LimitCORE=0` |
| 99-4 | `chalkctl dbcreds rotate` + preserve/backfill paths (`--force`, `update`, `restore`) |
