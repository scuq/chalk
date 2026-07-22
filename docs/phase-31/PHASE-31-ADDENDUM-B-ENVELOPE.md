# Phase 31 — Addendum B: Bundle Master Key envelope

This is the key model the rest of Phase 31 sits on. Read it before A, C, or D.

## 1. Why an envelope

If each credential wrapped the private-key bundle directly, then every credential change
would re-encrypt the whole bundle, and every unlock method would need its own full copy.
Instead, a single random **Bundle Master Key (BMK)** encrypts the bundle once, and each
unlock method wraps only the BMK. Credential operations become O(1) and independent.

## 2. Primitives

- `seal(plaintext, key)` = AES-256-GCM, random 96-bit nonce, output `nonce||ct||tag`.
- `KEK` (key-encryption key) = 256-bit key derived from a credential (see below).
- `BMK` = 256-bit random key from `crypto/rand`, generated once at signup, never rotated
  during normal operation (rotate only on explicit "reset all keys", which is a bundle
  re-encryption event and out of scope for routine flows).

## 3. What is wrapped

```
bundle_enc      = seal(private_key_bundle, BMK)   # the E2E identity/device private keys

wrap_password   = seal(BMK, KEK_password)         # always present
wrap_recovery   = seal(BMK, KEK_recovery)         # always present
wrap_passkey[N] = seal(BMK, KEK_passkey_N)        # zero or more, optional, one per credential
```

## 4. KEK derivation per method

- `KEK_password` — client-side: `master = Argon2id(password, auth_salt, params)`, then
  `KEK_password = HKDF(master, "chalk/kek")`. See Addendum D.
- `KEK_recovery` — from the recovery phrase via a KDF (Argon2id or HKDF over the decoded
  entropy, consistent with the existing recovery-phrase design).
- `KEK_passkey_N` — from the WebAuthn PRF extension output for credential N:
  `KEK_passkey_N = HKDF(prf_output, "chalk/kek/passkey")`.

## 5. Operations

- **Unlock (any method):** derive that method's `KEK`, `BMK = unseal(wrap_method, KEK)`,
  `bundle = unseal(bundle_enc, BMK)`.
- **Change password:** unlock to obtain BMK via old `KEK_password`, derive new
  `KEK_password`, `wrap_password = seal(BMK, KEK_password_new)`. Replace the one wrap.
  BMK and `bundle_enc` are untouched.
- **Add passkey:** while unlocked (BMK in memory), register the WebAuthn credential with
  PRF, derive `KEK_passkey_N`, store `wrap_passkey[N] = seal(BMK, KEK_passkey_N)`.
- **Remove passkey:** delete `wrap_passkey[N]` and the credential. Password and recovery
  wraps guarantee the BMK remains reachable.
- **Forbidden:** removing `wrap_password` or `wrap_recovery`. The server rejects any
  mutation that would delete either (last-factor guard, Addendum A §9).

## 6. Schema

```
CREATE TABLE user_auth (
  user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- password auth
  auth_proof_hash    BYTEA NOT NULL,      -- server-side hash of client authProof
  auth_salt          BYTEA NOT NULL,      -- Argon2id salt (public)
  kdf_mem_kib        INT   NOT NULL,
  kdf_iters          INT   NOT NULL,
  kdf_par            INT   NOT NULL,
  kdf_ver            INT   NOT NULL,      -- argon2 version tag for future migration

  -- envelope
  bundle_enc         BYTEA NOT NULL,      -- seal(bundle, BMK)
  wrap_password      BYTEA NOT NULL,      -- seal(BMK, KEK_password)
  wrap_recovery      BYTEA NOT NULL,      -- seal(BMK, KEK_recovery)

  -- totp (Addendum A)
  totp_secret_enc    BYTEA,
  totp_confirmed_at  TIMESTAMPTZ,
  totp_last_step     BIGINT NOT NULL DEFAULT 0,
  failed_totp_count  INT    NOT NULL DEFAULT 0,
  locked_until       TIMESTAMPTZ,

  -- migration (Addendum C)
  auth_v2_enrolled   BOOLEAN NOT NULL DEFAULT false,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_auth_passkey_wrap (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id  BYTEA NOT NULL,          -- WebAuthn credential id
  wrap_passkey   BYTEA NOT NULL,          -- seal(BMK, KEK_passkey_N)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, credential_id)
);
```

The existing passkey/credential table remains for the WebAuthn public keys and sign
counters; `user_auth_passkey_wrap` only holds the BMK wrap keyed by credential id.

## 7. SELECT/scan three-site rule

Every RETURNING / SELECT on `user_auth` must keep column count, struct field count, and
scan-argument count in lockstep (the standing three-site rule). The auth row is wide;
treat additions to it as high-risk for that class of mismatch.

## 8. Consistency notes

- All multi-wrap mutations (change password, add/remove passkey, TOTP reset) run under
  `s.withTx`; those that must not race the last-factor guard take `FOR UPDATE` on
  `user_auth`.
- `bundle_enc` is written once at signup (or at migration re-wrap) and thereafter only by
  an explicit key-rotation flow. Routine credential changes never touch it — verify this
  invariant in tests.
