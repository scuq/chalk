# Phase 31 — Build slices

Nine slices, each independently applicable and verifiable in the standard rhythm
(`go build ./...` / `go vet ./...` for server; `npx tsc --noEmit` + `node test.mjs` +
`node build.mjs` for client). Slice 31-1 is the only invasive data-model change; every
later slice is additive.

## 31-1 — Envelope refactor + schema + bundle re-wrap migration
**Scope:** server + DB only, no UI.
**Deliverables:** `user_auth`, `user_auth_passkey_wrap`, `auth_backup_code` tables
(Addendum B §6, A §8); one-time migration that re-wraps any existing bundle into
BMK-envelope form; `bundle_enc`/`wrap_*` read/write plumbing in the store.
**Verify:** `go build ./...`, `go vet ./...`; migration applies and is idempotent; the
`bundle_enc`-written-once invariant holds; SELECT/scan three-site rule checked on the wide
`user_auth` row.
**Depends on:** nothing. **Risk:** highest — ship isolated and first.

## 31-2 — Server password auth
**Scope:** server.
**Deliverables:** `authProof` verify (constant-time) with `s.withTx` / `FOR UPDATE`;
Argon2 parameter floor enforcement; `POST /auth/login/password` issuing the short-lived
`totp_pending` token; `CHALK_AUTH_*` config.
**Verify:** `go build`/`go vet`; unit tests for constant-time compare, param-floor
rejection, token TTL and single-use.
**Depends on:** 31-1.

## 31-3 — Server TOTP
**Scope:** server.
**Deliverables:** `github.com/pquerna/otp` integration; enroll/confirm/verify; secret
enc-at-rest under `CHALK_TOTP_ENC_KEY`; skew, replay guard (`totp_last_step`), lockout;
`POST /auth/login/totp` completing the login and issuing the session.
**Verify:** `go build`/`go vet`; tests for skew window, replay rejection, lockout
threshold and expiry.
**Depends on:** 31-1, 31-2.

## 31-4 — Server backup codes + reset endpoints
**Scope:** server.
**Deliverables:** backup-code generation/hash/verify/consume; `/auth/totp/reset`,
`/auth/backup/regenerate`, change-password and recovery-gated forgot-password endpoints;
last-factor guard extended to password + TOTP presence.
**Verify:** `go build`/`go vet`; tests for one-time backup use, reset re-confirm, and the
guard rejecting removal of the last password/TOTP.
**Depends on:** 31-1, 31-2, 31-3.

## 31-5 — Client crypto core
**Scope:** client.
**Deliverables:** `hash-wasm` Argon2id wrapper; HKDF split (`chalk/auth`, `chalk/kek`);
`seal`/`unseal`; BMK unlock/change-password/add-remove-wrap helpers; `test.mjs` coverage
(Addendum D §8).
**Verify:** `npx tsc --noEmit`, `node test.mjs`, `node build.mjs`.
**Depends on:** 31-1 (wire format must match).

## 31-6 — Client signup flow
**Scope:** client.
**Deliverables:** password-set with client-side policy gate + strength meter; TOTP QR +
confirm; recovery-phrase display; backup-code display; signup POST assembling the
envelope.
**Verify:** `npx tsc --noEmit`, `node test.mjs`, `node build.mjs`; manual signup E2E.
**Depends on:** 31-2, 31-3, 31-5.

## 31-7 — Client login flow
**Scope:** client.
**Deliverables:** two-step password login; passkey branch coexisting; universal TOTP
step; `totp_pending` handling; backup-code entry path.
**Verify:** `npx tsc --noEmit`, `node test.mjs`, `node build.mjs`; manual login on both
paths, both requiring TOTP.
**Depends on:** 31-2, 31-3, 31-5.

## 31-8 — Profile management + passkey opt-in
**Scope:** client (+ minor server if needed for wrap CRUD).
**Deliverables:** add passkey (register + PRF + BMK wrap); change password (reseal
`wrap_password`); reset TOTP; regenerate backup codes; remove passkey.
**Verify:** `npx tsc --noEmit`, `node test.mjs`, `node build.mjs`; add/remove passkey
leaves BMK reachable; change-password leaves `bundle_enc` unchanged.
**Depends on:** 31-4, 31-5, 31-7.

## 31-9 — Hard-cutover gate + admin policy
**Scope:** server + client.
**Deliverables:** `auth_v2_enrolled` gate middleware and `CHALK_AUTH_V2_REQUIRED`
(Addendum C §3); migration wizard client routing on `409 AUTH_V2_ENROLLMENT_REQUIRED`;
`/auth/migration/*` endpoints; admin reset that respects the E2E boundary; mandatory-2FA
enforcement for all users incl. admin.
**Verify:** `go build`/`go vet`; `npx tsc --noEmit`, `node test.mjs`, `node build.mjs`;
Addendum C §7 checklist.
**Depends on:** 31-1 … 31-8.

## Suggested commit sequence

One commit per slice, `-m` form, e.g.
`git commit -m "phase 31-1: BMK envelope schema + bundle re-wrap migration"`.
Do not fold multiple slices into one commit; each must build and verify on its own.
