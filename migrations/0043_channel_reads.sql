-- chalk -- migration 0043 (phase 33-1: per-user channel read cursors)
--
-- The unread indicator needs read state that follows the user across
-- devices, so it cannot live in localStorage the way threadSeen does. One
-- row per (user, channel) holding the highest message seq that user has
-- seen. Unread is then a comparison the client can make without loading
-- any history: channel_seq.next_seq - 1 > last_read_seq.
--
-- The cursor is a seq, not a timestamp: seq is already the per-channel
-- monotonic ordering every client agrees on, and it survives clock skew
-- between devices.
--
-- Deliberately NOT a "has the user read this message" join table. A single
-- high-water mark is one row per membership instead of one per message,
-- and "read up to here" is the only question the UI asks.
--
-- MENTIONS ARE NOT TRACKED HERE. Message bodies are ciphertext the server
-- cannot open, and we chose not to have senders leak a plaintext mention
-- list. Mention state is derived client-side from decrypted bodies; see
-- web/src/state/mentions.ts.

BEGIN;

CREATE TABLE IF NOT EXISTS channel_reads (
  user_id       UUID    NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  channel_id    UUID    NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_seq BIGINT  NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- user_id leads the PK on purpose: the hot read is "every cursor for
  -- this user" (once per connect, to build the sidebar), which this
  -- serves as a prefix scan. The per-channel lookup is a full-key probe.
  PRIMARY KEY (user_id, channel_id)
);

COMMENT ON TABLE channel_reads IS
  'per-user, per-channel read high-water mark (message seq). Absent row = never read = 0.';

COMMIT;
