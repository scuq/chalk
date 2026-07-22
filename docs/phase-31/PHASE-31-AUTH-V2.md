# Phase 31 — Authentication v2 (base spec)

## 1. Problem statement

Chalk currently onboards users with a passkey plus a recovery phrase. Passkeys created
by platform authenticators are bound to the device's secure element and are not present
on a second device. The only cross-device path is the recovery phrase, which is designed
as break-glass and is unsuitable for routine login. The result is that a user who sets up
on a PC cannot log in on their phone without invoking recovery.

## 2. Design principle: separate authentication from key-unlock

In an end-to-end encrypted app a login credential does two independent jobs:

- **Authentication** — prove identity to the server so it will issue a session.
- **Key-unlock** — decrypt the user's private-key bundle so the client can read messages.

A platform passkey performs authentication well but performs cross-device key-unlock
badly. A password performs both well because it is *portable*: the same password on any
device deterministically derives the same key material. TOTP performs authentication only
— a rotating code cannot derive a stable secret — so it is never part of key-unlock.

Phase 31 therefore makes the **password the routine key-unlock root and one authentication
factor**, makes **TOTP the mandatory second authentication factor**, and makes **passkeys
an optional additional unlock method** that a user may add later.

## 3. Credential model (locked)

Every account, after enrollment, permanently holds:

- A **password**: ≥20 chars, with upper-case, lower-case, digit, and special character.
  Enforced client-side (Addendum D §4). From it the client derives `authProof`
  (sent to server) and `KEK_password` (never leaves the client).
- A **TOTP secret**: RFC 6238, generated server-side, stored encrypted at rest,
  required on every login.
- A **recovery phrase**: high-entropy, shown once, the forgot-password / lost-TOTP
  fallback and an independent unlock method for the key bundle.

Optionally, added later from profile:

- One or more **passkeys**: WebAuthn credentials whose PRF output provides an additional
  unlock method. A passkey removes the password-typing step on its own device but never
  the TOTP step.

Password and TOTP cannot be removed. Passkeys can be added and removed freely.

## 4. Key model (summary; full detail in Addendum B)

A single random 256-bit **Bundle Master Key (BMK)** encrypts the private-key bundle. The
BMK is then wrapped independently under each unlock method:

```
bundle_enc     = seal(private_key_bundle, BMK)
wrap_password  = seal(BMK, KEK_password)     # always present
wrap_recovery  = seal(BMK, KEK_recovery)     # always present
wrap_passkey_N = seal(BMK, KEK_passkey_N)    # zero or more, optional
```

Consequences: changing the password reseals only `wrap_password` — the BMK is unchanged
and the bundle is never re-encrypted (O(1)). Adding or removing a passkey adds or removes
one wrap. Nothing in this model lets the server unwrap the BMK.

## 5. Auth/key split from the password (summary; full detail in Addendum D)

Client-side only:

```
master     = Argon2id(password, auth_salt, params)
authProof  = HKDF(master, "chalk/auth")     # sent to server; server stores hash(authProof)
KEK_password = HKDF(master, "chalk/kek")     # never leaves client; unseals wrap_password
```

`authProof` and `KEK_password` are independent HKDF labels: knowledge of one does not
yield the other. A server or DB compromise exposes `hash(authProof)`, the salts, and
`wrap_password`, forcing an **offline** Argon2id brute-force of the password to recover
`KEK_password`. The 20-char full-composition policy behind Argon2id makes that
infeasible in practice.

## 6. Login state machine

TOTP is a single shared gate reached by either first factor.

```
Password path:
  1. client: password -> Argon2id -> authProof (+ KEK_password kept in memory)
  2. client -> server: POST /auth/login/password { username, authProof }
  3. server: constant-time verify hash(authProof) under s.withTx / FOR UPDATE
             -> issue short-lived single-purpose totp_pending token
  4. client -> server: POST /auth/login/totp { totp_pending, code }   # or backup code
  5. server: verify TOTP (skew +/-1, consume step) -> issue session
             -> return wrap_password
  6. client: KEK_password -> BMK -> bundle. Authenticated and unlocked.

Passkey path:
  1. client: WebAuthn assertion (PRF extension) -> KEK_passkey kept in memory
  2. client -> server: POST /auth/login/passkey { assertion }
  3. server: verify assertion -> issue totp_pending token
  4. client -> server: POST /auth/login/totp { totp_pending, code }
  5. server: verify TOTP -> issue session -> return wrap_passkey_N
  6. client: KEK_passkey -> BMK -> bundle.
```

Both paths converge on step 4. There is no login that skips TOTP.

The `totp_pending` token is single-purpose, short-lived (2–5 min, `CHALK_AUTH_TOTP_PENDING_TTL`),
bound to the user and the first-factor method, and consumed on use.

## 7. Signup flow

```
client:
  generate BMK (256-bit random)
  generate E2E keypair(s); bundle_enc = seal(bundle, BMK)
  enforce password policy (>=20, composition) locally
  master = Argon2id(password, auth_salt); authProof, KEK_password = HKDF split
  wrap_password = seal(BMK, KEK_password)
  generate recovery phrase; KEK_recovery; wrap_recovery = seal(BMK, KEK_recovery)

server:
  generate TOTP secret; store encrypted; return provisioning URI
client:
  render QR (from URI) + copy-paste secret; user confirms with one live code
server:
  verify confirm code -> mark totp_confirmed
  generate/accept backup codes (hashed at rest)

client -> server: POST /auth/signup {
  username, auth_salt, kdf_params, authProof,
  bundle_enc, wrap_password, wrap_recovery,
  totp_confirm_code, backup_code_hashes
}
```

Recovery phrase and backup codes are each shown exactly once.

## 8. Reset flows

- **Change password (knows current):** unwrap BMK with old `KEK_password`, derive new
  `KEK_password`, reseal `wrap_password`, replace `hash(authProof)`. Single tx. BMK and
  bundle untouched.
- **Forgot password:** recovery phrase → `KEK_recovery` → BMK → set new password →
  reseal `wrap_password`. The server cannot do this alone; this is inherent to E2E.
- **Lost TOTP:** a one-time backup code passes login step 4, after which the user
  re-enrolls TOTP from profile (new secret, new backup codes). If both authenticator and
  backup codes are lost, TOTP reset is recovery-phrase-gated.
- **Reset TOTP (routine):** from profile after full login; requires re-confirm with a
  live code before the new secret becomes active; old secret remains active until then.

## 9. E2E boundary and admin limits

State this plainly in UI copy and admin tooling:

- The server never sees the password (only `authProof`) and never holds the BMK in the
  clear. It cannot decrypt any user's messages.
- An admin can reset the **auth** side of an account (force re-enrollment) but **cannot
  recover E2E keys** without the user's recovery phrase. Admin is not key escrow — that
  is the point of the product.
- A user who, at any time, has lost every unlock method (no enrolled passkey device, no
  password, no recovery phrase) is unrecoverable. This is a property of E2E, not a defect.

## 10. Threat model summary

| Adversary | Gains | Does not gain |
|-----------|-------|---------------|
| Passive DB read | `hash(authProof)`, salts, `wrap_*`, `totp_secret_enc` (encrypted), backup-code hashes | password, `KEK_*`, BMK, plaintext keys, plaintext TOTP secret |
| Active malicious server | can log `authProof`, replay assertions | still cannot derive `KEK_password` from `authProof` (separate HKDF label); still cannot unwrap BMK |
| Stolen enrolled device | passkey first factor | still blocked by TOTP; still needs the authenticator |
| Phished password | first factor | still blocked by TOTP |

The residual risk is a weak password combined with a DB leak; the 20-char composition
policy plus Argon2id parameters is the mitigation, and it is enforceable only client-side
(Addendum D §4).

## 11. Configuration

| Env var | Purpose |
|---------|---------|
| `CHALK_AUTH_V2_REQUIRED`        | Hard-cutover switch (default true) — gate un-enrolled accounts |
| `CHALK_AUTH_TOTP_PENDING_TTL`   | Lifetime of the totp_pending token (default 300s) |
| `CHALK_AUTH_ARGON2_MEM_KIB`     | Argon2id memory (default 262144 = 256 MiB) |
| `CHALK_AUTH_ARGON2_ITERS`       | Argon2id iterations (default 3) |
| `CHALK_AUTH_ARGON2_PAR`         | Argon2id parallelism (default 1) |
| `CHALK_TOTP_ENC_KEY`            | 32-byte key (base64) for encrypting TOTP secrets at rest |
| `CHALK_TOTP_ISSUER`             | Issuer label in the provisioning URI (default "Chalk") |
| `CHALK_TOTP_SKEW`               | Accepted period skew in steps (default 1) |
| `CHALK_TOTP_MAX_FAILURES`       | Failed-code count before lockout (default 5) |
| `CHALK_TOTP_LOCKOUT`            | Lockout duration (default 900s) |
| `CHALK_BACKUP_CODE_COUNT`       | Backup codes issued per enrollment (default 10) |

## 12. Non-goals

- OPAQUE / asymmetric PAKE (future hardening; not required for v1).
- WebAuthn-as-second-factor in place of TOTP.
- Server-side password-policy enforcement (structurally impossible under E2E; see
  Addendum D §4).
- Account recovery that bypasses the recovery phrase (would break E2E).
