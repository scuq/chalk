# Phase 31 — authentication v2 (password + TOTP)

**Status:** shipped and complete, slices 31-1 … 31-13, released v0.3.15 – v0.3.19.
**Tag:** `#auth` → `tools/where.sh -g auth`

*Consolidated record.* This replaces the seven-file spec that lived in
`docs/phase-31/` (base spec, addenda A–D, index, slices). The design rationale
is carried forward verbatim in substance; the mechanism is rewritten to what was
actually built. Where the build deliberately diverged from the spec, it is
called out in [Where the build diverged](#where-the-build-diverged). The
superseded spec remains in git history if the original wording is ever needed.

## Why this phase exists

chalk onboarded users with a passkey plus a recovery phrase. Platform passkeys
are bound to one device's secure element and are not present on a second device,
so the only cross-device path was the recovery phrase — which is break-glass by
design and unsuitable for routine login. A user who set up on a PC could not log
in on their phone without invoking recovery.

The central realisation: **in an end-to-end encrypted app a login credential
does two independent jobs.**

- **Authentication** — prove identity to the server so it issues a session.
- **Key-unlock** — decrypt the material the client needs to read messages.

A platform passkey does the first job well and the second badly across devices.
A password does both well because it is *portable*: the same password on any
device deterministically derives the same key material. TOTP does authentication
only — a rotating code cannot derive a stable secret — so it is never part of
key-unlock.

Phase 31 therefore makes the **password the routine key-unlock root and one
authentication factor**, **TOTP the mandatory second authentication factor**,
and **passkeys an optional additional unlock method** added later from the
profile.

## Locked policy decisions

1. **Every account permanently carries a password and a TOTP secret.** Neither
   can be removed. There is no password-less or TOTP-less account state after
   enrollment.
2. **Password policy:** minimum 20 characters with upper-case, lower-case, digit
   and special (space counts as special). Enforced **client-side** — see
   [why the server cannot](#password-policy-is-client-side-and-why).
3. **TOTP gates every login**, regardless of first factor. A passkey replaces
   only the password-typing step on its own device; it never skips TOTP.
4. **Passkeys are optional**, added later from the profile. An additional unlock
   method, never a replacement for the password or TOTP.
5. **Migration is a hard cutover**, enforced server-side rather than in the UI,
   staged by `CHALK_AUTH_V2_REQUIRED`.

## The key model, as built

The client holds one secret worth protecting: the **32-byte BIP-39 entropy**
from which every identity key (X25519, Ed25519) is deterministically derived.
That entropy is wrapped once per unlock method and stored in
`identity_seed_wrap` — `wrap_suite` and `wrap_blob` are **opaque to the server**,
which stays a blind relay.

```
identity_seed_wrap(user_id, method, credential_id, generation, wrap_suite, wrap_blob)

  method='password'  exactly one row per (user, generation); KEK from the
                     password; credential_id is empty.
  method='passkey'   one row per passkey credential; KEK from the WebAuthn PRF
                     output; credential_id is the credential.
```

`generation` tracks `identity_keys.generation`, so a phrase rotation can carry
fresh wraps while old-generation wraps stay resolvable through the re-wrap. The
schema enforces the credential-id shape per method, and the whole table is
per-user indexed for the new-device "give me all my wraps" fetch.

**Why there is no Bundle Master Key.** The spec called for a random BMK
encrypting a private-key *bundle*, with each credential wrapping only the BMK —
the point being that credential changes stay O(1) instead of re-encrypting a
large bundle. That indirection buys nothing here: what is protected is already
32 bytes, and every key is derived from it, so wrapping it directly is *already*
O(1). The envelope, `bundle_enc`, `wrap_recovery` and the separate passkey-wrap
table were dropped.

**Why there is no recovery wrap.** chalk ended up with two distinct 24-word
phrases doing two distinct jobs, and neither needs one:

- The **recovery phrase** is an *authentication* credential — it resets the
  password. It never unlocks key material, so it wraps nothing.
- The **encryption phrase** *is* the identity seed. Re-entering it reproduces
  the entropy directly, so there is nothing to unwrap.

Losing one does not cost you the other, and the schema's method check is
`('password','passkey')` precisely because a recovery method would be
meaningless.

## Client derivation

Client-side only, in `web/src/crypto/authkdf.ts`:

```
salt   = auth_salt                       # public, from the server; fresh at signup
master = argon2id(password, salt, { m: kdf_mem_kib, t: kdf_iters, p: kdf_par })

authProof = HKDF-SHA256(master, info="chalk/auth", 32)   # SENT; server stores its SHA-256
KEK       = HKDF-SHA256(master, info="chalk/kek",  32)   # NEVER sent; unwraps the seed wrap
```

The two HKDF `info` labels are exact constants and must never collide:
knowledge of one output does not yield the other. A server or database
compromise exposes `hash(authProof)`, the salts and the wrap blobs, forcing an
**offline** Argon2id brute-force of the password to reach the KEK.

Argon2id parameters travel with the account (`kdf_*` columns on `user_auth`), so
a future parameter bump is a per-account migration rather than a global break.
Argon2id comes from `hash-wasm`; HKDF, AES-256-GCM and randomness from WebCrypto.

Sensitive-material handling: password, `master` and KEK live in local variables
for the minimum time and are never persisted to IndexedDB, localStorage or logs.
Best-effort buffer overwrite after use — JS gives no guarantee, so minimising
lifetime is the real control.

### Password policy is client-side, and why

The composition gate (≥20 chars, four classes) runs in the client before
`master` is derived. The server structurally **cannot** enforce it: under E2E it
never receives the password, only `authProof` — an opaque 32-byte HKDF output
that reveals nothing about length or composition.

What the server *does* enforce is the **Argon2id floor**: `kdf_mem_kib`,
`kdf_iters` and `kdf_par` at or above the configured minimum (defaults 256 MiB /
3 / 1, with a hard schema floor of 8192 KiB), so a client that lowballed its
parameters is rejected.

This is a deliberate client-trust boundary — the same trade Bitwarden makes for
master-password policy. For a self-hosted app where the account owner sets their
own password it is the correct one, and the residual "weak password + database
leak" risk is mitigated by the composition policy plus the Argon2id cost.

## TOTP

RFC 6238 with authenticator-app defaults, so any standard app (Google
Authenticator, Aegis, 1Password) interoperates: **HMAC-SHA1, 6 digits, 30-second
period, 160-bit secret**. Implemented natively on the standard library
(`internal/auth/totp.go`) rather than pulling in a module — mirroring chalk's
hand-rolled BIP-39 — with correctness pinned by the canonical RFC 4226 HOTP
vectors in `totp_test.go`.

**Provisioning.** The server returns the `otpauth://` URI and the base32 secret;
the client renders the QR and shows the secret for manual entry. The server
never returns a pre-rendered image.

**Encryption at rest.** The secret is a shared secret — whoever holds it can
mint codes — so it is stored AES-256-GCM encrypted under `CHALK_TOTP_ENC_KEY`
as `nonce(12) || ciphertext || tag(16)`. This is server-symmetric encryption,
deliberately distinct from E2E: TOTP is authentication, not key material, so the
server is allowed to decrypt it. It is also why that key is the one secret
`chalkctl backup` carries alongside the database — restoring without it leaves
every user's authenticator dead.

**Confirm before activate.** Enrollment holds a pending secret; the account is
not TOTP-enabled until a live code confirms it (`totp_confirmed_at IS NOT
NULL`). This prevents locking a user out with a secret they never successfully
scanned.

**Verification** carries three guards, all applied under `s.withTx` with
`FOR UPDATE` on the auth row so concurrent attempts cannot race:

- **Skew** — `CHALK_TOTP_SKEW` steps each side (default 1), tolerating clock
  drift.
- **Replay** — `totp_last_step` records the highest consumed step; a code from
  that step or earlier is rejected even while still inside the skew window.
- **Lockout** — after `CHALK_TOTP_MAX_FAILURES` failures (default 5), lock for
  `CHALK_TOTP_LOCKOUT` (default 900s). Phase 85-1 logs these lockouts.

**Last-factor guard.** Because password and TOTP are permanent, the server
rejects any operation that would leave an account without a confirmed password
or a confirmed TOTP — the same `withTx` + `FOR UPDATE` pattern as the
last-passkey guard.

## Login state machine

TOTP is a single shared gate reached by either first factor.

```
Password path:
  1. client  GET/POST /api/auth/login/prelogin  -> auth_salt + kdf params
  2. client  password -> Argon2id -> authProof (KEK kept in memory)
  3. client  POST /api/auth/login/password { username, authProof }
     server  constant-time verify under withTx/FOR UPDATE
             -> short-lived single-purpose totp_pending token
  4. client  POST /api/auth/login/totp { totp_pending, code }
     server  verify TOTP (skew, replay, lockout) -> session
  5. client  fetch the seed wrap, KEK -> 32-byte entropy -> identity keys

Passkey path:
  1. client  WebAuthn assertion with the PRF extension -> KEK_passkey in memory
  2. server  verify assertion -> totp_pending token
  3. converges on step 4 above; the passkey's own wrap is what unlocks the seed
```

There is no login that skips TOTP. The `totp_pending` token is single-purpose,
short-lived (`CHALK_AUTH_TOTP_PENDING_TTL`, default 300s), bound to the user and
the first-factor method, and consumed on use.

## Signup

`POST /api/auth/register/v2/begin` performs admission (invite token, or the
one-shot admin token) and returns the TOTP provisioning URI plus a signup token;
`POST /api/auth/register/v2/finish` takes a **live** TOTP code and creates the
account and session in one step. The client then uploads the password-wrapped
entropy with `PUT /api/auth/seed-wrap`.

The client enforces the password policy locally, derives `authProof` and the
KEK, and shows both 24-word phrases exactly once — recovery and encryption,
clearly distinguished, because they have different jobs and different loss
consequences.

## Reset and recovery, as built

This is where the shipped behaviour differs most from the original spec, and
deliberately so — **31-13 made recovery a reset, not a login.**

- **Change password** (knows the current one): re-derive the KEK, re-wrap the
  entropy, replace the stored proof hash. One transaction.
- **Recovery = reset.** The phrase sets a *new password* via
  `POST /api/auth/recovery/reset-auth`, together with a **live `totp_code`** —
  or `reset_totp` when the authenticator is what was lost, which clears TOTP for
  re-enrollment through the session the reset mints.
- **Phrase-alone `POST /api/auth/recovery` is 409 `auth_reset_required`** for
  enrolled accounts. The old behaviour signed the user in from the phrase alone,
  which bypassed the second factor entirely *and* left them logged in but still
  unable to change the password they had forgotten.
- **The reset purges the password seed wraps.** Only the identity gate's
  `maybeUploadSeedWrap` re-creates them, from the encryption phrase — the new
  password cannot wrap entropy the resetting client does not hold.
- **TOTP rotation** runs through enroll → confirm-with-live-code; the old secret
  stays active until the new one is confirmed.
- **Step-up (81-2).** Rotating the recovery phrase, replacing the authenticator
  and adding or removing a passkey each require a password proof plus a live
  TOTP code. Being signed in used to be enough, which let anyone with a
  signed-in browser take the account over.
- **Session revocation (81-1).** A credential change revokes other sessions; a
  recovery reset revokes everything.

## Migration: the hard cutover

Existing accounts had a passkey plus a recovery phrase and no password or TOTP.

Enforcement is **server-side, not UI**: an account with `auth_v2_enrolled =
false` is blocked from every route except the enrollment routes and what is
needed to reach them, answered with `409` so the client routes into the
migration wizard regardless of what the user was trying to do. The gate is
staged by `CHALK_AUTH_V2_REQUIRED` (default on) so an operator can run soft
during testing and then enforce.

The enrolling device must first be able to reach the identity seed — via passkey
PRF or by entering the encryption phrase — then sets a password, derives the
KEK, wraps the entropy, enrolls and confirms TOTP, and completes with
`POST /api/auth/migration/complete`, which flips `auth_v2_enrolled` atomically.
Nothing is committed until it succeeds, so an abandoned wizard simply leaves the
account un-enrolled.

Edge cases held as designed: a fresh device with no local passkey and a lost
phrase is unrecoverable (already true before phase 31 — E2E, not a defect); an
admin can force re-enrollment but cannot supply the key material.

**Admin bootstrap (31-11 / 31-12).** The reserved admin username is claimable
only with the one-shot `CHALK_ADMIN_BOOTSTRAP_TOKEN`, carried as
`?admin_token=…` and dead the moment the admin account has credentials. This
retired the 09d passkey-based bootstrap.

## E2E boundary and admin limits

State plainly in UI copy and admin tooling:

- The server never sees the password — only `authProof` — and never holds the
  identity entropy in the clear. It cannot decrypt any user's messages.
- An admin can reset the **auth** side of an account (force re-enrollment) but
  **cannot recover key material** without the user's encryption phrase. Admin is
  not key escrow; that is the point of the product.
- A user who has lost every unlock method is unrecoverable. That is a property
  of E2E, not a defect.

## Threat model summary

| Adversary | Gains | Does not gain |
| --- | --- | --- |
| Passive DB read | `hash(authProof)`, salts, wrap blobs, encrypted TOTP secret | password, KEK, identity entropy, plaintext TOTP secret |
| Active malicious server | can log `authProof`, replay assertions | cannot derive the KEK from `authProof` (separate HKDF label); cannot unwrap the seed |
| Stolen enrolled device | passkey first factor | still blocked by TOTP |
| Phished password | first factor | still blocked by TOTP |

**The deliberate threat-model change.** Before phase 31 a database leak revealed
nothing decryptable at all, because the server held no form of the identity
secret — only public halves and opaque wraps. After phase 31 it holds the
entropy wrapped under a password-derived key, so a leak **plus a weak password**
becomes an offline attack that can recover the identity. That is the price of
password-based cross-device unlock, it is the standard trade for password-unlock
E2E (cf. Bitwarden), and the mitigation is the composition policy plus the
Argon2id cost floor — enforceable only client-side. The same note heads
`migrations/0040_auth_v2.sql`, beside the schema it describes.

## Configuration

| Env var | Purpose |
| --- | --- |
| `CHALK_AUTH_V2_REQUIRED` | Hard-cutover gate for un-enrolled accounts (default on) |
| `CHALK_AUTH_TOTP_PENDING_TTL` | Lifetime of the `totp_pending` token (default 300s) |
| `CHALK_AUTH_ARGON2_MEM_KIB` | Argon2id memory floor (default 262144 = 256 MiB) |
| `CHALK_AUTH_ARGON2_ITERS` | Argon2id iteration floor (default 3) |
| `CHALK_AUTH_ARGON2_PAR` | Argon2id parallelism floor (default 1) |
| `CHALK_TOTP_ENC_KEY` | 32-byte base64 key encrypting TOTP secrets at rest |
| `CHALK_TOTP_ISSUER` | Issuer label in the provisioning URI |
| `CHALK_TOTP_SKEW` | Accepted period skew in steps (default 1) |
| `CHALK_TOTP_MAX_FAILURES` | Failed codes before lockout (default 5) |
| `CHALK_TOTP_LOCKOUT` | Lockout duration in seconds (default 900) |
| `CHALK_ADMIN_BOOTSTRAP_TOKEN` | One-shot token for claiming the reserved admin account |

`chalkctl` generates `CHALK_TOTP_ENC_KEY` and `CHALK_ADMIN_BOOTSTRAP_TOKEN`
fresh on `init`, preserves them on `--force`, and backfills them on `update`
when absent — the reference pattern for any new server secret.

## Slices as shipped

| Slice | What landed |
| --- | --- |
| 31-1 | Data layer: `user_auth`, `identity_seed_wrap`, `auth_backup_code` (migration 0040) |
| 31-2 | Server password auth: prelogin, `login/password`, `totp_pending` |
| 31-3 | Server TOTP: native RFC 6238; login/totp mints the session; enroll/confirm |
| 31-4 | Reset endpoints and staging-aware TOTP handlers |
| 31-5 | Client auth crypto core: Argon2id + HKDF split, seal/unseal, policy gate |
| 31-6a / 31-6b | Server signup v2 and seed-wrap endpoints; client signup wizard (password + TOTP + QR, wrap upload) |
| 31-7 | Password + TOTP login with silent seed-wrap unlock |
| 31-8 | Profile security panel: change password, TOTP reset, phrase relink |
| 31-9 / 31-9a | Hard cutover — enrollment gate, passkey TOTP, migration wizard, and its CSS |
| 31-11 | One-shot admin bootstrap token (gated claim, enrollment URL) |
| 31-12 | Admin claim via `?admin_token=`; retires the 09d passkey bootstrap |
| 31-13 | Recovery phrase resets password + TOTP instead of signing in |

There is no 31-10 in the history. Phase 81 later hardened this surface
(step-up, session revocation, per-IP anonymous rate limits); see
[PHASE-81-SECAUDIT.md](PHASE-81-SECAUDIT.md).

## Where the build diverged

Recorded because the superseded spec described each of these differently, and a
reader coming from the git history will otherwise expect them.

1. **No Bundle Master Key envelope.** No `bundle_enc`, no `wrap_password` /
   `wrap_recovery` / `wrap_passkey` columns, no separate passkey-wrap table.
   The KEK wraps the 32-byte entropy directly in `identity_seed_wrap`. The
   envelope's O(1) benefit was already free at this size.
2. **No recovery wrap; two phrases instead of one.** The spec had a single
   recovery phrase serving as both auth fallback and an independent unlock
   method. Shipped: a recovery phrase for auth reset and a separate encryption
   phrase that *is* the seed.
3. **Recovery is a reset, not a login** (31-13). The spec's "recovery phrase →
   key → set new password" path bypassed the second factor.
4. **TOTP is hand-rolled**, not `github.com/pquerna/otp`. Same parameters; the
   motivation was keeping the auth path free of new dependencies.
5. **Backup codes were specified but never wired.** See below.
6. **Slices ran to 31-13**, not the 31-1 … 31-9 the spec planned.

## Open items

- **`auth_backup_code` is dormant.** Migration 0040 creates the table and
  `store/auth_v2.go` has `ReplaceBackupCodes` / `ConsumeBackupCode` /
  `CountUnusedBackupCodes`, with **no caller anywhere** — there is no
  backup-code login step, no regeneration endpoint, and no
  `CHALK_BACKUP_CODE_COUNT`. Lost-authenticator recovery is instead the
  recovery phrase with `reset_totp`. Drop the table and the functions together.
- **`RegisterFromInviteScreen` still registers passkey-first**
  (`navigator.credentials.create()`), out of step with the password + TOTP flow
  every other entry point uses.

## Non-goals

- OPAQUE / asymmetric PAKE — a future hardening that would remove even
  `authProof` visibility; not required for v1.
- WebAuthn as the second factor in place of TOTP.
- Server-side password-policy enforcement (structurally impossible under E2E).
- Any account recovery that bypasses the encryption phrase — it would break E2E.
