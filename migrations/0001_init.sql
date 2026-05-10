-- chalk -- migration 0001
-- Initial schema: users and devices.
--
-- Future migrations add: keypackages, channels, channel_members, messages,
-- channel_seq, blobs, friendships, friend_requests, recovery_codes,
-- enrollment_tokens, device_presence, instances. They arrive in the phases
-- that introduce their respective features.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---- users ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id          UUID         PRIMARY KEY,
  handle      CITEXT       UNIQUE NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Cheap sanity check on handle shape; we don't try to be a Unicode policy.
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_handle_shape;
ALTER TABLE users
  ADD CONSTRAINT users_handle_shape
  CHECK (char_length(handle::text) BETWEEN 1 AND 32);

-- ---- devices -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_type   TEXT         NOT NULL DEFAULT 'browser-unknown',
  device_label  TEXT,
  identity_key  BYTEA,        -- MLS signature pubkey, populated in phase 10
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_seen     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

ALTER TABLE devices
  DROP CONSTRAINT IF EXISTS devices_type_valid;
ALTER TABLE devices
  ADD CONSTRAINT devices_type_valid
  CHECK (device_type IN ('phone','tablet','desktop','browser-unknown'));

CREATE INDEX IF NOT EXISTS devices_user_id_idx ON devices(user_id);
CREATE INDEX IF NOT EXISTS devices_last_seen_idx ON devices(last_seen);

COMMIT;
