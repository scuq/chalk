-- chalk -- migration 0047 (phase 42-1: per-user thread read cursors)
--
-- 0043 gave channels read state that follows the user across devices, and said
-- in its own header that threadSeen still lives in localStorage. This is that
-- hole. A thread reply is an ordinary channel message: it bumps the channel's
-- high-water seq and lights the sidebar dot, but the main feed filters replies
-- out, so opening the channel marks it read and clears the dot while the only
-- trace -- a badge on the thread HEAD row -- may be far up in scrollback.
-- Per-device thread state made that worse, not better: reading a thread on your
-- phone left the badge lit on your laptop forever.
--
-- SAME SHAPE AS channel_reads, DELIBERATELY. One row per (user, thread) holding
-- the highest reply seq that user has seen. Unread is a comparison against
-- thread_activity.last_reply_seq, so it needs no history and no plaintext. The
-- cursor is a seq, not a timestamp, for 0043's reason: seq is the ordering every
-- client already agrees on and it survives clock skew between devices.
--
-- WHY THERE IS AN involved FLAG. "Every thread I have ever been able to see,
-- with an unread reply" is not a useful list and not a bounded query -- at a
-- thousand threads per channel it is mostly threads the user never touched. The
-- list that matters is "threads I actually took part in". The server CAN compute
-- that without reading a body: sender_device_id -> devices.user_id tells it who
-- wrote the head and who wrote each reply. So involvement is written at reply
-- time and stored here, and the unbounded question is replaced by a bounded one:
-- a prefix scan of this user's involved threads.
--
-- A row therefore exists for two different reasons, and both are wanted:
--   involved = TRUE   you wrote the head, or you wrote a reply. You are on the
--                     hook; unread here is surfaced regardless of age.
--   involved = FALSE  you merely read the thread. The row exists so the badge
--                     you cleared on one device is cleared on all of them.
--
-- ABSENT ROW = NEVER READ = 0, same contract as channel_reads. For an uninvolved
-- thread that means "every reply is new", which is exactly what the head-row
-- badge has always said. It does NOT flood the inbox, because the inbox only
-- reaches beyond the recency window for INVOLVED threads.
--
-- MENTIONS ARE STILL NOT TRACKED HERE, for 0043's reason restated: bodies are
-- ciphertext the server cannot open, and we did not choose to have senders leak
-- a plaintext mention list. Mention state is derived client-side from decrypted
-- bodies; see web/src/chat/mentions.ts. The consequence for the thread inbox is
-- stated plainly: a mention inside a reply the client has never decrypted cannot
-- be flagged. Involvement is the server-side approximation of relevance;
-- mentions refine it where the client can.
--
-- NO FOREIGN KEY TO messages, unlike thread_activity. A composite FK into a
-- partitioned table needs all of the target's PK columns (0045's note), which
-- would force a head_ts column into this table for no read that wants it. The
-- channels FK's CASCADE is the cleanup that matters.

BEGIN;

CREATE TABLE IF NOT EXISTS thread_reads (
  user_id       UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  thread_id     UUID        NOT NULL,
  -- Denormalized so the inbox can filter and report by channel without joining
  -- back into the partitioned messages table -- the same reason
  -- message_reactions.channel_id exists (0045).
  channel_id    UUID        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_seq BIGINT      NOT NULL DEFAULT 0,
  involved      BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- user_id leads for 0043's reason: the hot read is "my involved threads with
  -- something unread", which this serves as a prefix scan. The per-thread
  -- lookup is a full-key probe.
  PRIMARY KEY (user_id, thread_id)
);

-- The bounded unread scan. PARTIAL on involved so the index contains only the
-- threads the user actually took part in -- a human-scale number -- and not one
-- entry per thread they have ever been able to read.
CREATE INDEX IF NOT EXISTS thread_reads_involved_idx
  ON thread_reads (user_id, thread_id) WHERE involved;

COMMENT ON TABLE thread_reads IS
  'per-user, per-thread read high-water mark (reply seq) plus whether the user took part. Absent row = never read = 0.';

-- ---- backfill -------------------------------------------------------------
--
-- Seed everyone who ever wrote in a thread as involved and FULLY CAUGHT UP.
--
-- Caught up, not "unread since your last message", and this is a policy decision
-- worth being explicit about: seeding real unread state would greet every
-- existing user with an inbox listing every thread they have ever typed in since
-- the server was installed, which is the opposite of the problem this feature
-- solves. seedChannelRead (0043) made the same call for the same reason -- a new
-- member starts caught up rather than staring at a backlog-sized dot. The
-- feature works forward from here.
--
-- Per-device localStorage threadSeen is NOT imported. Its values could only ever
-- be lower than "caught up", and the store refuses to move a cursor backwards,
-- so importing it would be a no-op with extra moving parts.
INSERT INTO thread_reads (user_id, thread_id, channel_id, last_read_seq, involved)
SELECT DISTINCT d.user_id, ta.thread_id, ta.channel_id, ta.last_reply_seq, TRUE
  FROM thread_activity ta
  JOIN messages m ON m.channel_id = ta.channel_id
                 AND (m.id = ta.thread_id OR m.thread_id = ta.thread_id)
  JOIN devices  d ON d.id = m.sender_device_id
ON CONFLICT (user_id, thread_id) DO NOTHING;

COMMIT;
