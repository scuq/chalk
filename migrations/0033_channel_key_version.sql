-- chalk -- migration 0033 (phase 25)
-- Channel key rotation: the current key version per channel.
--
-- Phase 23 introduced per-channel space keys with a key_version column on
-- channel_keys + messages, but every channel stayed at version 1 (rotation
-- was deferred to phase 25). This adds the authoritative "what version is
-- current" to channels itself.
--
-- ROTATION (phase 25): the channel creator can mint a NEW space key at
-- version N+1 (fresh key material, same suite), wrap it for the CURRENT
-- membership, and advance current_key_version. New messages encrypt under the
-- new version; messages already stored keep their stamped key_version and
-- decrypt under the retained older key. A member removed before a rotation has
-- no wrap at the new version and cannot read anything sent after it -- this is
-- the forward access-control the rotation provides.
--
-- MONOTONICITY: current_key_version only ever moves forward. The server
-- enforces that a rotation advances it by exactly +1 and that sends carry the
-- channel's current version (see the handlers in 25-1b). Default 1 so every
-- existing channel is "version 1, never rotated", matching today's behavior.

BEGIN;

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS current_key_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE channels
  ADD CONSTRAINT channels_current_key_version_positive
  CHECK (current_key_version >= 1);

COMMIT;
