# Phase 31 — Addendum A: TOTP server part

## 1. Parameters

RFC 6238 with authenticator-app defaults so any standard app (Google Authenticator, Aegis,
1Password, etc.) works without special handling:

- Algorithm: SHA-1 (app default; do not use SHA-256/512 unless every target app is known).
- Digits: 6.
- Period: 30 seconds.
- Secret: 160 bits (20 bytes) from `crypto/rand`, base32 (no padding) in the URI.

Library: `github.com/pquerna/otp` (`otp/totp`). It provides secret generation, the
`otpauth://` provisioning URI, and code validation with a configurable skew window.

## 2. Provisioning URI

```
otpauth://totp/{CHALK_TOTP_ISSUER}:{account}?secret={BASE32}&issuer={CHALK_TOTP_ISSUER}&algorithm=SHA1&digits=6&period=30
```

`{account}` is the username or email. The client renders the QR from this URI and also
displays the base32 secret for manual entry. The server returns the URI, never a
pre-rendered image.

## 3. Encryption at rest

The TOTP secret is a shared secret: whoever holds it can generate valid codes. Store it
encrypted under `CHALK_TOTP_ENC_KEY` (32-byte key, base64 in env), using AES-256-GCM with
a per-row random nonce. Layout of `totp_secret_enc`: `nonce(12) || ciphertext || tag(16)`.
This is server-held symmetric encryption, distinct from E2E — TOTP is authentication, not
key material, so the server is allowed to decrypt it.

## 4. Enrollment (confirm before activate)

```
POST /auth/totp/enroll          -> { provisioning_uri, secret_b32 }   (no server state change yet,
                                     secret held in a short-lived enrollment record)
POST /auth/totp/confirm {code}  -> verify against the pending secret; on success:
                                     persist totp_secret_enc, set totp_confirmed_at = now()
```

An account is not considered TOTP-enabled until `totp_confirmed_at IS NOT NULL`. This
prevents locking a user out with a secret they never successfully scanned.

## 5. Verification (login step 4)

```
verify(user, code):
  if locked_until > now(): reject (locked)
  step_now = floor(unix / 30)
  for delta in [-CHALK_TOTP_SKEW .. +CHALK_TOTP_SKEW]:
      if totp_valid(secret, code, step_now + delta):
          if (step_now + delta) <= totp_last_step: reject (replay)   # code already consumed
          totp_last_step = step_now + delta
          failed_totp_count = 0
          accept
  failed_totp_count += 1
  if failed_totp_count >= CHALK_TOTP_MAX_FAILURES:
      locked_until = now() + CHALK_TOTP_LOCKOUT
  reject
```

- **Skew:** `CHALK_TOTP_SKEW` steps each side (default 1 → accepts the adjacent 30s
  windows to tolerate clock drift).
- **Replay guard:** `totp_last_step` records the highest consumed step; a code from that
  step or earlier is rejected even if still inside the skew window. Prevents reuse of a
  captured code within its validity window.
- **Lockout:** after `CHALK_TOTP_MAX_FAILURES` failures, lock for `CHALK_TOTP_LOCKOUT`.
  All counters and the lock update must occur under `s.withTx` with `FOR UPDATE` on the
  auth row to avoid a concurrent-attempt race.

## 6. Backup codes

- `CHALK_BACKUP_CODE_COUNT` (default 10) single-use codes generated at enrollment and at
  every TOTP reset.
- Each code: high-entropy (>= 80 bits), shown once, stored only as a hash
  (Argon2id or a slow hash; these are short-lived and low-volume so cost is acceptable).
- A backup code is accepted in place of a TOTP code at login step 4; on use it is marked
  `used_at` and cannot be reused.
- Present remaining-count in profile; warn when low; allow regeneration (which invalidates
  all previous backup codes).

## 7. Endpoints

| Method | Path | Auth required | Purpose |
|--------|------|---------------|---------|
| POST | `/auth/totp/enroll`  | full session (or migration-enrollment token) | issue pending secret + URI |
| POST | `/auth/totp/confirm` | same as enroll | activate TOTP |
| POST | `/auth/login/totp`   | valid `totp_pending` token | second-factor gate |
| POST | `/auth/totp/reset`   | full session + live current code | rotate secret |
| POST | `/auth/backup/regenerate` | full session + live current code | new backup codes |

## 8. Schema additions

Extend the auth row (see Addendum B §3 for the full `user_auth` shape):

```
totp_secret_enc     BYTEA,          -- nonce||ct||tag, AES-256-GCM under CHALK_TOTP_ENC_KEY
totp_confirmed_at   TIMESTAMPTZ,    -- NULL until confirm succeeds
totp_last_step      BIGINT NOT NULL DEFAULT 0,
failed_totp_count   INT    NOT NULL DEFAULT 0,
locked_until        TIMESTAMPTZ
```

New table:

```
CREATE TABLE auth_backup_code (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  BYTEA NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, code_hash)
);
```

## 9. Interaction with the last-factor guard

Because password and TOTP are permanent, the "last-passkey guard" pattern generalises:
the server must reject any operation that would leave an account without a confirmed
password or without a confirmed TOTP. Reuse the `s.withTx` + `FOR UPDATE` guard already
established for the last-passkey case.
