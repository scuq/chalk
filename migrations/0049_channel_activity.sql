-- chalk -- migration 0049 (phase 62-1: denormalized per-channel activity index)
--
-- One row per channel, pointing at its newest message. The unified mobile
-- conversation list (Zuckermode) sorts every conversation by "when did it
-- last say something" and previews that message -- a question the schema
-- could only answer with MAX(ts) GROUP BY channel_id over the partitioned
-- messages table, the exact all-partition aggregate 0046 exists to avoid.
-- Same cure, one level up: thread_activity is to threads what this table is
-- to channels.
--
-- last_msg_ts IS A PARTITION-PRUNING KEY, not display data. messages'
-- primary key is (ts, id) -- see 0003/0046 -- so storing the ts beside the
-- id turns "give me the newest message's body" into a single-partition
-- primary-key probe:
--
--     JOIN messages m ON m.ts = ca.last_msg_ts AND m.id = ca.last_msg_id
--
-- NO CIPHERTEXT IS COPIED HERE. Preview bodies stay in messages and are
-- joined in at read time; this table is metadata only (which message, when,
-- by which user) -- the same shape 0043/0045/0046 already hold and
-- docs/threat-model.md already documents. The server still cannot read a
-- body.
--
-- NO RECENCY INDEX, unlike thread_activity. Every read of this table is
-- "the caller's few dozen channels", joined from channel_members in
-- ListChannelsForUser -- never a global ORDER BY over the table. The
-- primary key is the only access path needed.
--
-- last_sender_id is users(id), resolved through devices at write time so
-- reads never have to; NULL after a phase-12 user purge, exactly like
-- messages.sender_device_id can be.
--
-- THE COMPOSITE FK (last_msg_ts, last_msg_id) -> messages (ts, id) follows
-- 0045/0046 and carries their caveat verbatim: it fires for a real SQL
-- DELETE but NOT for a partition DETACH. Ordinary deletion is a tombstone
-- UPDATE, so this constraint is a write-time integrity check, not a cleanup
-- mechanism -- with one deliberate exception: the voice-scratchpad purge
-- hard-DELETEs a channel's messages, and the cascade drops the activity row
-- with them, which is exactly the "this room went quiet" answer the list
-- wants.
--
-- A TOMBSTONED NEWEST MESSAGE STILL COUNTS AS ACTIVITY. Deleting a message
-- does not un-say it in the feed, and nothing on the delete path maintains
-- this table; the client renders such a preview as deleted.

BEGIN;

CREATE TABLE IF NOT EXISTS channel_activity (
  channel_id     UUID        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,

  -- Newest message. last_msg_ts is the partition-pruning half of the
  -- (ts, id) probe that fetches its body; last_msg_seq is the monotonic
  -- guard for the upsert and the client's staleness check.
  last_msg_id    UUID        NOT NULL,
  last_msg_ts    TIMESTAMPTZ NOT NULL,
  last_msg_seq   BIGINT      NOT NULL,
  last_sender_id UUID,

  PRIMARY KEY (channel_id)
);

ALTER TABLE channel_activity
  DROP CONSTRAINT IF EXISTS channel_activity_msg_fk;
ALTER TABLE channel_activity
  ADD  CONSTRAINT channel_activity_msg_fk
  FOREIGN KEY (last_msg_ts, last_msg_id) REFERENCES messages (ts, id) ON DELETE CASCADE;

COMMENT ON TABLE channel_activity IS
  'one row per channel: newest-message pointer, so recency-sorted channel lists never aggregate over the partitioned messages table.';

-- ---- backfill -------------------------------------------------------------
--
-- One-time full scan of messages -- the aggregate this table replaces, paid
-- once. On a fresh database it is a no-op. No deleted_at filter: a
-- tombstoned newest message is still the channel's latest activity.
INSERT INTO channel_activity (channel_id, last_msg_id, last_msg_ts, last_msg_seq, last_sender_id)
SELECT s.channel_id, s.id, s.ts, s.seq, d.user_id
  FROM (SELECT DISTINCT ON (channel_id)
               channel_id, id, ts, seq, sender_device_id
          FROM messages
         ORDER BY channel_id, seq DESC) s
  LEFT JOIN devices d ON d.id = s.sender_device_id
ON CONFLICT (channel_id) DO NOTHING;

COMMIT;
