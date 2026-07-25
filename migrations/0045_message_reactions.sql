-- chalk -- migration 0045 (phase 37-4: message reactions)
-- One row per (message, reactor) holding that person's ENCRYPTED set of emoji.
--
-- WHY ONE ROW PER REACTOR, NOT ONE PER EMOJI:
--   * Uniqueness falls out of the primary key. A per-emoji table would need
--     the emoji itself in the key to stop "👍 twice from one person", which
--     means the emoji has to be readable (or deterministically tagged) by the
--     server -- exactly what we are avoiding.
--   * Toggling is a read-modify-write of your own tiny row. No delete-then-
--     insert race, no partial state.
--   * Key rotation is trivial: the row carries the key_version its body was
--     sealed under, and re-sealing is one UPDATE. Per-emoji rows tagged under
--     a channel key would produce DIFFERENT tags for the same emoji after a
--     rotation, silently breaking dedup across the rotation boundary.
--
-- WHAT THE SERVER LEARNS, stated plainly: that user X reacted to message Y,
-- and when. It cannot see WHICH emoji -- body is AES-256-GCM under the
-- channel space key, same suite as message bodies. Clients decrypt the rows
-- they can and tally counts locally; there is deliberately no server-side
-- GROUP BY emoji, because that would require plaintext.
--
-- This is a metadata leak of the same shape as the ones already documented in
-- docs/threat-model.md (who is in which channel, when messages were sent). It
-- is not a content leak.
--
-- The composite FK (message_ts, message_id) -> messages(ts, id) is required
-- because messages is partitioned by ts: Postgres can only validate an FK
-- into a partitioned table when it references ALL columns of the target's
-- primary key. Same pattern as message_acks (0004). It also means every
-- reaction row carries its message's ts, and every lookup must pass it.
--
-- ON DELETE CASCADE fires for a real SQL DELETE but NOT for partition DETACH
-- -- the same caveat 0004 documents. Note that deleting a MESSAGE in chalk is
-- a tombstone UPDATE, not a DELETE, so this cascade does not clean up
-- reactions on a deleted message; the handler refuses reactions on a
-- tombstoned message, and the store scrubs existing ones alongside the body.

BEGIN;

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id  UUID        NOT NULL,
  message_ts  TIMESTAMPTZ NOT NULL,
  -- Denormalized so the history backfill can page a whole channel's
  -- reactions without joining back into the partitioned messages table.
  channel_id  UUID        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  -- AES-256-GCM sealed JSON array of emoji, e.g. ["👍","🎉"]. Opaque here.
  body        BYTEA       NOT NULL,
  key_version INTEGER,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (message_id, message_ts, user_id)
);

ALTER TABLE message_reactions
  DROP CONSTRAINT IF EXISTS message_reactions_message_fk;
ALTER TABLE message_reactions
  ADD  CONSTRAINT message_reactions_message_fk
  FOREIGN KEY (message_ts, message_id) REFERENCES messages (ts, id) ON DELETE CASCADE;

-- The backfill query is "every reaction for these messages in this channel".
-- Leading with channel_id serves it as a prefix scan; message_id narrows it.
CREATE INDEX IF NOT EXISTS message_reactions_channel_msg_idx
  ON message_reactions (channel_id, message_id);

COMMENT ON TABLE message_reactions IS
  'per-(message,user) encrypted emoji set. Server sees who reacted to what, never which emoji.';

COMMIT;
