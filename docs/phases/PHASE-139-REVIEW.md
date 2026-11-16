# Phase 139 — review: a second chalk instance for Apple App Review

A plan for a separate chalk instance that the Apple reviewer signs in to.
The instance has its own database and no TOTP step at password login.
The design was written on 16 November 2026.

**Status: in progress.** Slice 139-1 is built (2026-11-16, not committed). Slices 139-2, 139-3, and 139-4 are not started.
**Tag:** `#review` → `tools/where.sh -g review` (this file, the review-mode code in `internal/auth/`, and the migration).

Decisions from the operator:

- The review instance runs on the production host, at `chalk-a.abyle.org`.
- The review instance has its own database.
- Password login on that instance has no TOTP step.
- Voice is on, so the reviewer can test a call.
- The instance has an on/off switch.
- The operator creates the three demo users, the reviewer account, and the demo content by hand in the browser.

---

## Problem

Apple's reviewer must sign in to the iOS app.
chalk asks for a TOTP code at every login, and a reviewer cannot type one.
This is the open decision "Beta App Review sign-in" in `PHASE-136-IOS.md` (136-5).
It blocks the external TestFlight group and the App Store submission.

## Design

The review instance is a second chalkd on the production host.
It uses the same image digest as production and its own database.

| | Production (no change) | Review instance |
|---|---|---|
| Caddy | the one container on ports 80 and 443 | a second site block in the same Caddyfile |
| chalkd | `chalkd`, network `chalk` | `chalkd-review`, network `chalk-review` only |
| Postgres | `postgres`, volume `chalk-pgdata` | `postgres-review`, volume `chalk-review-pgdata`, network `chalk-review` only |
| Blobs | `chalk-blobs` | `chalk-review-blobs` |
| Env file | `/etc/chalk/chalk.env` | `/etc/chalk/review.env` (mode 0600) |
| coturn | `chalk-coturn` | shared |
| Update | `chalk-update.timer` | no own timer, `chalkctl update` also repins `chalkd-review` |

Caddy joins both networks. It is the only container on both.

`review.env` has its own TOTP key, server identity key, database passwords, and VAPID key pair.
It has the same `CHALK_TURN_SECRET` as `chalk.env`, and its TURN URLs point to the production domain.

Review mode is one new branch in the production binary.
The branch is in the password login handler.
It runs only if `HTTPDeps.ReviewMode` is true.
chalkd sets that field once at startup, from two gates.

## Rejected

- A second port on the production chalkd. One process and one database would hold both the demo accounts and the real accounts. A mistake in the switch would then affect real accounts.
- The ngrok dev tunnel. It is a development tool. Its address changes, and the reviewer needs a stable address.
- The TOTP secret in the review notes. The reviewer cannot run an authenticator, and a TOTP step that someone can pass with a published secret gives no protection.
- A separate coturn. The shared coturn is enough, and one more service needs more upkeep. The cost is a shared quota (see "Accepted exposure").
- Seeding the demo data with a script. The operator creates the users by hand, through normal signup. Signup still enrolls TOTP, so a script would need a second path.

## Production safety

Two independent gates decide the review mode.

1. The env gate. `CHALK_REVIEW_MODE` must be set in the process environment of chalkd.
   - Only `chalkctl review init` (slice 139-2) writes it, and only into `review.env`.
   - `chalk.env.tmpl`, `chalkd.container.tmpl`, and the backfill list in `update.go` never contain it. A chalkctl test (slice 139-2) asserts this.
2. The database gate. The table `review_instance` must have its one row.
   - Migration 0067 makes the table empty on every database, production included.
   - No migration and no HTTP endpoint writes the row. Only `chalkctl review init` (slice 139-2) writes it.

| Env gate | Database gate | Result |
|---|---|---|
| off | any | Normal TOTP login. This is production. |
| on | row missing | chalkd does not start and exits with `ErrReviewModeUnmarked`. |
| on | row present | Review mode. chalkd logs a banner at each start. |

If the env var reaches production by mistake, the result is an outage that anyone can see. It is not a bypass.

Review mode does not change these:

- The password is still necessary. `VerifyAuthProof` runs first.
- TOTP stays necessary for step-up: a password change, a TOTP replacement, a recovery phrase regeneration, and a passkey add or delete.
- TOTP stays necessary for the recovery reset, for signup enrollment, and for the second step of passkey login.

Review mode skips only the second step of password login.
It does so only for an account with a confirmed TOTP secret.
An account without one takes the normal path, and the TOTP step refuses it.
The security log line for a skipped step has `method=password-review`.

Isolation between the two instances:

- Accounts and sessions. Separate databases mean separate users, sessions, TOTP secrets, and identities.
- Cookies. The session cookie has no `Domain` attribute, so it is host-only. The browser never sends it to the production host.
- Passkeys. The WebAuthn RP ID is `chalk-a.abyle.org`, so production passkeys do not work there, and the reverse.
- Server identity. The review instance has its own server identity key, so clients pin it as a different server.
- Network. `chalkd-review` and `postgres-review` are only on `chalk-review`. They cannot reach the production `chalkd` or `postgres`. Caddy routes by hostname.

### Accepted exposure

- The reviewer credentials are in App Store Connect, so treat them as public. While the instance is up, anyone with them can use it as a chat server and can get TURN credentials for the shared coturn. The phase 80-10 peer fence and the bandwidth limit still apply. The same exposure exists for a phase 80 guest link.
- Mitigation: registration closed, `chalkctl review down` outside a review, and `chalkctl review reset` after each review.
- The shared coturn quota (`--total-quota=64`) also covers review calls.

## Slices

### 139-1 review mode in chalkd

**Built (2026-11-16, not committed).**

- `migrations/0067_review_instance.sql` makes the table `review_instance`. The constraint on `id` keeps it at one row at most.
- `Store.IsReviewInstance` reports whether the row exists.
- `internal/auth/review.go` has `ReviewModeRequested` (reads `CHALK_REVIEW_MODE`), `ResolveReviewMode` (the gate table), `ErrReviewModeUnmarked`, and `ReviewModeBanner`.
- `cmd/chalkd/main.go` resolves the mode after the `--migrate-only` exit. It reads the database only if the env var asks for review mode. On the error, chalkd exits.
- `HTTPDeps.ReviewMode` and the `review_mode` field of `/api/auth/config`.
- `finishLogin` is the session mint and the response, moved out of the TOTP step. Both login steps call it.
- Client: `LoginPasswordResult` has a session case. The password screen calls `onLoggedIn` for it. A "Demo server" strip shows if `review_mode` is true.
- Tests: all four gate combinations, and the values of the env var. DB-backed tests show two facts. Without review mode, the password step gives no session. With review mode, the password and the step-up TOTP stay necessary. A client test covers the parsing of the login result.

Result of a real chalkd run:

- Env var set and no row: chalkd exits with the error.
- No env var: `review_mode` is false.
- Env var set and row present: `review_mode` is true, and the banner shows.

### 139-2 chalkctl review

Not started.

- `chalkctl review init --domain` generates the secrets, writes `review.env`, and renders the review units.
- It starts `postgres-review`, migrates, and writes the `review_instance` row.
- It starts `chalkd-review`, adds the second site block to the Caddyfile, and reloads Caddy.
- `review up`, `review down`, `review status`, and `review registration open|closed`.
- A `REVIEW=absent|up|down` key in `chalkctl.conf`, so `init --force` and `maint` keep the review block.
- `chalkctl push apns set --review` and the repin in `update.go`.
- Tests: the production env and units never contain `CHALK_REVIEW_MODE`. The review units never name `chalk.network`, `postgres`, or `chalk-pgdata`.

### 139-3 snapshot and reset

Not started.

- `review snapshot` writes a `pg_dump` of `postgres-review` and a tar of `chalk-review-blobs`.
- `review reset` stops `chalkd-review`, restores both, confirms that the `review_instance` row exists, and starts `chalkd-review`.
- `review.env` stays the same, so the TOTP key and the server identity key match the snapshot.

### 139-4 paperwork and review notes

Not started.

- Close the open decision at 136-5 in `PHASE-136-IOS.md`.
- Add the `CHANGELOG.md` entry and the `docs/phase-log.md` index row.
- Write the text for the App Store Connect review notes. It has the server address, the user name, the password, the three demo users, and the steps to start a call.

## Manual checklist

The operator does these after slices 139-1 to 139-3 ship:

1. Add a DNS A record for `chalk-a.abyle.org` that points to the production IP address.
2. Cut a release and run `chalkctl update` on production. The release is a minor bump, because the server changed.
3. Run `chalkctl review init --domain chalk-a.abyle.org`.
4. Use the bootstrap URL to make an admin account. Do not use it for the reviewer.
5. Create the three demo users and the reviewer account through normal signup. Signup still enrolls TOTP.
6. Make the users friends, then make a channel, messages, and direct messages.
7. Run `chalkctl review registration closed`, and then `chalkctl review snapshot`.
8. Optional: run `chalkctl push apns set --review` with the production key.
9. Test the iOS app against `chalk-a.abyle.org`. Sign in with no TOTP code, and then start a call with a demo user.
10. Run `chalkctl status` on production and sign in to production. The status must show no change, and the login must still ask for a TOTP code.

## Risk outside this phase

Apple guideline 5.1.1(v) says that an app that lets a user create an account must also let the user delete it in the app.
chalk has no self-service account deletion. A search of `web/src` and `internal` found none.
The reviewer can create an account in the iOS app, so Apple can reject the app, whatever the review instance does.
This needs its own phase. Ask the operator before work starts.
