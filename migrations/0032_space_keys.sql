-- chalk -- migration 0032 (phase 23)
-- Space keys: per-channel symmetric keys, wrapped per member, + the
-- message key-version column.
--
-- Phase 23 encrypts messages. Each channel ("space") has ONE long-lived
-- 256-bit symmetric space key per key_version; messages are AES-256-GCM
-- under it. The space key is wrapped once per member to that member's
-- X25519 identity public key (ephemeral-static sealed box). The server is a
-- BLIND RELAY: it stores these wraps opaquely and never sees a plaintext
-- space key.
--
-- CRYPTO AGILITY (see docs/design/crypto-agility.md). Algorithms will change
-- (esp. post-quantum), so storage is suite-tagged and self-describing:
--   * channel_keys.wrap_suite identifies the wrap construction; wrap_blob is
--     an OPAQUE, suite-defined serialization (no per-curve columns, so a
--     future KEM with a different shape -- e.g. ML-KEM's ~1 KB ciphertext --
--     fits with no schema change).
--   * messages.body carries a 1-byte message-suite tag as its prefix (the
--     body is self-describing; no separate column needed).
-- wrap_suite and the message suite are independent, so a PQ migration can
-- re-wrap keys (bump wrap_suite) while leaving AES-256-GCM messages as-is.
--
-- KEY DISTRIBUTION: the server cannot wrap (it has no plaintext key). When a
-- member lacks a wrapped key for the current version, an online member who
-- holds it wraps it for them and uploads the row (handled by the server
-- handlers in 23c + client wiring in 23d). channel_keys is where those wraps
-- land; a missing (channel_id, key_version, recipient_id) row is the signal
-- that a member still needs the key.
--
-- key_version is ROTATION (same algorithm, new key material; phase 25), NOT
-- the crypto suite. messages.key_version is NULL for legacy plaintext
-- messages (pre-phase-23, body is plaintext) and >= 1 for encrypted ones.
--
-- Suite 1 today: wrap = X25519 -> HKDF-SHA256 -> AES-256-GCM, blob =
-- ephemeralPub(32) || nonce(12) || wrapped(48) = 92 bytes; msg = AES-256-GCM.

BEGIN;

CREATE TABLE IF NOT EXISTS channel_keys (
  channel_id    UUID         NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  key_version   INTEGER      NOT NULL DEFAULT 1,
  recipient_id  UUID         NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  wrap_suite    SMALLINT     NOT NULL,            -- which wrap construction
  wrap_blob     BYTEA        NOT NULL,            -- opaque, suite-defined
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

  PRIMARY KEY (channel_id, key_version, recipient_id),

  CONSTRAINT channel_keys_version_positive CHECK (key_version >= 1),
  CONSTRAINT channel_keys_suite_positive   CHECK (wrap_suite >= 1),
  CONSTRAINT channel_keys_blob_nonempty    CHECK (octet_length(wrap_blob) > 0)
);

-- Fetch pattern: "give me my wrapped key(s) for this channel" and "which
-- members already have a wrap for (channel, version)" (so an online member
-- can wrap for those who don't). Both are covered by the PK prefix, plus a
-- per-recipient index for the cross-device "all my channel keys" lookup.
CREATE INDEX IF NOT EXISTS channel_keys_by_recipient
  ON channel_keys(recipient_id, channel_id);

-- messages.key_version: NULL = legacy plaintext (body is plaintext, no
-- suite prefix); >= 1 = encrypted (body is suite-tagged ciphertext under the
-- channel's space key of that version). Nullable + no default so existing
-- rows stay NULL (plaintext) and only new encrypted sends set it.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS key_version INTEGER;

COMMIT;
