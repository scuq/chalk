-- chalk -- migration 0040 (phase 31, slice 31-1)
-- Auth v2 data layer: password + TOTP (mandatory 2FA), one-time backup
-- codes, and the password/passkey-wrapped identity entropy that lets a new
-- device unlock keys WITHOUT re-typing the 24-word phrase.
--
-- KEY-MODEL NOTE (corrects PHASE-31 Addendum B):
-- Chalk derives identity keys CLIENT-SIDE from the 24-word BIP-39 phrase
-- (256-bit entropy -> PBKDF2 seed -> HKDF -> X25519/Ed25519). The server
-- holds only PUBLIC halves and OPAQUE space-key wraps; it has never held any
-- form of the identity secret, and there is NO server-stored private-key
-- bundle. Phase 31 therefore does NOT re-wrap a bundle. Instead it stores the
-- 32-byte BIP-39 ENTROPY, encrypted CLIENT-SIDE under a key derived from the
-- user's password (and, later, from a passkey PRF). That entropy is the same
-- secret as the recovery phrase, so a device that authenticates with the
-- password can fetch its wrap, decrypt the entropy, and run the EXISTING
-- entropyToMnemonic -> mnemonicToSeed -> deriveIdentity path unchanged.
-- Existing users have no wrap yet; they supply their entropy during
-- enrollment (they hold the phrase or a cached identity) and the client wraps
-- it then (slice 31-9). Recovery needs no wrap: the phrase IS the entropy.
--
-- THREAT-MODEL CHANGE (deliberate, documented): before Phase 31 a database
-- leak revealed nothing decryptable, because the server held no form of the
-- identity secret. After Phase 31 the server holds the entropy wrapped under
-- a password-derived key; a leak PLUS a weak password becomes an offline
-- attack that can recover the identity. Mitigation: the >=20-char full-
-- composition password policy (client-enforced, Addendum D s4) plus the
-- Argon2id cost floor enforced below. This is the standard password-unlock
-- E2E trade (cf. Bitwarden) and the price of password-based cross-device
-- unlock.
--
-- Wrap blobs are OPAQUE and suite-tagged, mirroring 0032_space_keys.sql
-- (wrap_suite + wrap_blob): the server never interprets them, so a future
-- KDF/AEAD change is a suite bump with no schema change.
--
-- This migration is ADDITIVE: it creates three tables and alters nothing.
-- Forward-only (no down migration), per internal/migrate/migrate.go policy.

BEGIN;

-- ---- user_auth: password + TOTP, one row per user -----------------------
-- auth_proof_hash : server-side hash of the client-derived authProof. The
--   password and the key-wrapping KEK never reach the server; authProof is
--   HKDF(Argon2id(password), "chalk/auth") computed client-side (Addendum D).
-- kdf_*           : the Argon2id parameters the CLIENT used, stored so the
--   same password reproduces authProof on any device and so a future param
--   bump is a per-account migration, not a global break.
-- totp_secret_enc : AES-256-GCM (nonce||ct||tag) under CHALK_TOTP_ENC_KEY;
--   NULL until TOTP is confirmed.
-- totp_last_step  : highest consumed TOTP step (replay guard, Addendum A s5).
-- auth_v2_enrolled: hard-cutover flag (Addendum C); false until the account
--   has a confirmed password AND a confirmed TOTP.
CREATE TABLE IF NOT EXISTS user_auth (
  user_id            UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- password
  auth_proof_hash    BYTEA       NOT NULL,
  auth_salt          BYTEA       NOT NULL,
  kdf_alg            SMALLINT    NOT NULL DEFAULT 1,   -- 1 = argon2id
  kdf_mem_kib        INTEGER     NOT NULL,
  kdf_iters          INTEGER     NOT NULL,
  kdf_par            INTEGER     NOT NULL,

  -- totp
  totp_secret_enc    BYTEA,
  totp_confirmed_at  TIMESTAMPTZ,
  totp_last_step     BIGINT      NOT NULL DEFAULT 0,
  failed_totp_count  INTEGER     NOT NULL DEFAULT 0,
  locked_until       TIMESTAMPTZ,

  -- migration
  auth_v2_enrolled   BOOLEAN     NOT NULL DEFAULT false,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT user_auth_proof_nonempty CHECK (octet_length(auth_proof_hash) > 0),
  CONSTRAINT user_auth_salt_len       CHECK (octet_length(auth_salt) >= 16),
  CONSTRAINT user_auth_kdf_mem_floor  CHECK (kdf_mem_kib >= 8192),
  CONSTRAINT user_auth_kdf_iters_pos  CHECK (kdf_iters >= 1),
  CONSTRAINT user_auth_kdf_par_pos    CHECK (kdf_par >= 1),
  CONSTRAINT user_auth_kdf_alg_valid  CHECK (kdf_alg IN (1))
);

-- ---- identity_seed_wrap: 32-byte BIP-39 entropy wrapped per method -------
-- method='password' : exactly one row per (user, generation); KEK from the
--                     password. credential_id is empty.
-- method='passkey'  : one row per passkey credential; KEK from the WebAuthn
--                     PRF output. Added later from profile (slice 31-8).
-- generation tracks identity_keys.generation so a phrase rotation can carry
-- fresh wraps while old-generation wraps remain resolvable during re-wrap.
-- wrap_suite + wrap_blob are OPAQUE to the server (blind relay).
CREATE TABLE IF NOT EXISTS identity_seed_wrap (
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method        TEXT        NOT NULL,
  credential_id BYTEA       NOT NULL DEFAULT '\x'::bytea,  -- '' for password
  generation    INTEGER     NOT NULL DEFAULT 1,
  wrap_suite    SMALLINT    NOT NULL,
  wrap_blob     BYTEA       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, method, credential_id, generation),

  CONSTRAINT identity_seed_wrap_method_valid   CHECK (method IN ('password', 'passkey')),
  CONSTRAINT identity_seed_wrap_suite_pos      CHECK (wrap_suite >= 1),
  CONSTRAINT identity_seed_wrap_blob_nonempty  CHECK (octet_length(wrap_blob) > 0),
  CONSTRAINT identity_seed_wrap_generation_pos CHECK (generation >= 1),
  -- password wraps use the empty credential_id; passkey wraps must not
  CONSTRAINT identity_seed_wrap_cred_shape CHECK (
    (method = 'password' AND octet_length(credential_id) = 0) OR
    (method = 'passkey'  AND octet_length(credential_id) > 0)
  )
);

-- Per-user lookup for the new-device "give me all my wraps" fetch.
CREATE INDEX IF NOT EXISTS identity_seed_wrap_by_user
  ON identity_seed_wrap(user_id, generation);

-- ---- auth_backup_code: one-time TOTP fallbacks --------------------------
-- Stored only as a hash (Addendum A s6). Single-use: used_at set on
-- redemption. Regeneration deletes all rows for the user and inserts fresh.
CREATE TABLE IF NOT EXISTS auth_backup_code (
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  BYTEA       NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, code_hash),

  CONSTRAINT auth_backup_code_hash_nonempty CHECK (octet_length(code_hash) > 0)
);

-- Fast "how many unused codes remain" and "is this code still redeemable".
CREATE INDEX IF NOT EXISTS auth_backup_code_unused
  ON auth_backup_code(user_id)
  WHERE used_at IS NULL;

COMMIT;
