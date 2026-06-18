-- chalk -- migration 0031 (phase 22)
-- Identity keys: per-user X25519 + Ed25519 public keys.
--
-- Phase 22 reintroduces cryptographic identity after the 21-series
-- plaintext reset. Each user has ONE identity per generation, derived
-- client-side from their 24-word BIP-39 phrase:
--   * X25519 keypair  -- key agreement; wraps per-space keys (phase 23)
--   * Ed25519 keypair -- signatures; the identity trust anchor
-- The private halves never leave the device (derived from the phrase,
-- imported non-extractable into WebCrypto, cached in IndexedDB). Only the
-- public halves live here.
--
-- IDENTITY SCOPE: per-USER, not per-device. Every device the user signs
-- into derives the same keypair from the same phrase, so "add a device"
-- means "re-enter your recovery phrase," not a pairing handshake.
--
-- GENERATION: the phrase is the rotatable decryption root (see the crypto
-- rebuild AMENDMENT, Design B + external-backup). Rotating the phrase mints
-- a new generation; the old row is retired (retired_at set), not deleted,
-- so historical space-key wraps under the old identity remain resolvable
-- during re-wrap. PK is (user_id, generation).
--
-- SELF-SIGNATURE: self_sig is Ed25519(ed25519_pub) over x25519_pub. A
-- client verifies it on fetch, so a malicious server cannot substitute the
-- X25519 key without detection (it can't forge the signature). The Ed25519
-- key itself is pinned out-of-band by the phase-24 picture-word check; this
-- column extends that trust to the X25519 key. Chain:
--   picture-word -> Ed25519 pub -> self_sig -> X25519 pub -> space keys
--
-- Key sizes (validated): X25519/Ed25519 public = 32 bytes; Ed25519
-- signature = 64 bytes. CHECKs enforce these so a malformed publish is
-- rejected at the database boundary.

BEGIN;

CREATE TABLE IF NOT EXISTS identity_keys (
  user_id      UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generation   INTEGER      NOT NULL DEFAULT 1,
  x25519_pub   BYTEA        NOT NULL,
  ed25519_pub  BYTEA        NOT NULL,
  self_sig     BYTEA        NOT NULL,            -- Ed25519 over x25519_pub
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  retired_at   TIMESTAMPTZ,                      -- non-null once rotated out

  PRIMARY KEY (user_id, generation),

  CONSTRAINT identity_keys_x25519_len  CHECK (octet_length(x25519_pub)  = 32),
  CONSTRAINT identity_keys_ed25519_len CHECK (octet_length(ed25519_pub) = 32),
  CONSTRAINT identity_keys_self_sig_len CHECK (octet_length(self_sig)   = 64),
  CONSTRAINT identity_keys_generation_positive CHECK (generation >= 1)
);

-- At most ONE active (non-retired) identity per user. Rotation must retire
-- the current generation (set retired_at) before/as it inserts the next, so
-- "the user's current identity" is always an unambiguous single row.
CREATE UNIQUE INDEX IF NOT EXISTS identity_keys_one_active_per_user
  ON identity_keys(user_id)
  WHERE retired_at IS NULL;

COMMIT;
