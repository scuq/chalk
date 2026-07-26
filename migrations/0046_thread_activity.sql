-- chalk -- migration 0046 (phase 42-1: denormalized per-thread activity index)
--
-- One row per thread, holding what every thread-shaped read wants to know
-- without touching the partitioned messages table: when the thread started,
-- when it was last replied to, by whom, and how many replies it has.
--
-- WHY THIS TABLE EXISTS AT ALL. The same three facts are today recomputed with
-- an aggregate that has no channel filter and no ts bound:
--
--     LEFT JOIN (SELECT thread_id, COUNT(*), MAX(seq) FROM messages
--                 WHERE parent_id IS NOT NULL GROUP BY thread_id)
--
-- (internal/store/channels.go, ListMessagesByChannel). messages is RANGE
-- partitioned by ts, so that is a sequential scan plus a group-by of EVERY
-- monthly partition, run to decorate at most 50 rows, on every history page
-- load. It is affordable only because the table is small today. A cross-channel
-- thread inbox asks the same question across every channel a user is in, so the
-- aggregate has to become a lookup.
--
-- THE PARTITION-KEY PROBLEM, AND WHY head_ts / last_reply_ts ARE COLUMNS.
-- messages' primary key is (ts, id) -- Postgres requires the partition key in
-- every unique constraint -- so a lookup by id ALONE scans every partition (see
-- the note in 0003). Storing the ts alongside each id turns "give me the head's
-- body" and "give me the newest reply's body" into single-partition
-- primary-key probes:
--
--     JOIN messages h ON h.ts = ta.head_ts       AND h.id = ta.thread_id
--     JOIN messages r ON r.ts = ta.last_reply_ts AND r.id = ta.last_reply_id
--
-- That is the whole reason the timestamps are duplicated here. They are not for
-- display; they are partition-pruning keys.
--
-- NO CIPHERTEXT IS COPIED HERE. Preview bodies stay in messages and are joined
-- in at read time. This table is metadata only: which thread, in which channel,
-- how many replies, when, by which user. That is the same shape of metadata the
-- server already holds (0043, 0045) and the same shape docs/threat-model.md
-- already documents. The server still cannot read a body.
--
-- PRIMARY KEY (thread_id) ALONE. A thread's id IS a message id, and message ids
-- are UUIDs, so thread_id is already globally unique; adding channel_id to the
-- key would only widen every index entry. channel_id is carried as a NOT NULL
-- FK column because every read either filters by it or reports it, and because
-- ON DELETE CASCADE from channels is the cleanup that actually matters (a
-- thread dies with its channel).
--
-- THE COMPOSITE FK (head_ts, thread_id) -> messages (ts, id) follows 0045's
-- pattern and carries 0045's caveat verbatim: it fires for a real SQL DELETE
-- but NOT for a partition DETACH. Since chalk deletes messages by tombstone
-- UPDATE, this constraint is a write-time integrity check, not a cleanup
-- mechanism. If an old partition is ever detached and dropped, the head join at
-- read time yields NULL and the row renders without a head preview --
-- navigable, honestly degraded, not broken.
--
-- A ROW EXISTS ONLY ONCE A THREAD HAS A REPLY. A top-level message with no
-- replies is not a thread; the client already gates its thread indicator on
-- replyCount > 0. This keeps the ordinary send path -- the overwhelming
-- majority of writes -- completely untouched by this table.
--
-- reply_count COUNTS TOMBSTONES, matching what the aggregate it replaces
-- counted (that WHERE clause has no deleted_at filter). Deleting a reply
-- therefore does not decrement it, and nothing on the delete path maintains
-- this table. That is deliberate: it is the existing, shipped behaviour.

BEGIN;

CREATE TABLE IF NOT EXISTS thread_activity (
  -- The thread head's message id. Globally unique on its own; see the header.
  thread_id            UUID        NOT NULL,
  channel_id           UUID        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,

  -- Head identity. head_ts is the partition-pruning half of the (ts, id) probe
  -- that fetches the head's body; head_seq orders the thread against the feed.
  head_ts              TIMESTAMPTZ NOT NULL,
  head_seq             BIGINT      NOT NULL,
  -- users(id) of whoever wrote the head, resolved through devices at write
  -- time so reads never have to. NULL after a phase-12 user purge, exactly
  -- like messages.sender_device_id can be.
  head_sender_id       UUID,

  -- Newest reply. Same (ts, id) pairing, same reason.
  last_reply_id        UUID        NOT NULL,
  last_reply_ts        TIMESTAMPTZ NOT NULL,
  last_reply_seq       BIGINT      NOT NULL,
  last_reply_sender_id UUID,

  reply_count          INTEGER     NOT NULL DEFAULT 0,

  PRIMARY KEY (thread_id)
);

-- The thread inbox's ordering column, and the only index this table needs.
--
-- NOT led by channel_id, which is the arrangement you would reach for first.
-- Both halves of the inbox query span every channel the caller is a member of
-- and order globally by recency, so a channel-led index cannot serve the
-- ORDER BY -- measured, it produced a bitmap scan plus a sort, or a per-channel
-- merge the planner declined to use. Leading with the timestamp lets the
-- aged-unread half walk newest-first and stop at its LIMIT, and lets the
-- active-window half evaluate its cutoff by range scan, so the work each does is
-- proportional to rows IN THE WINDOW rather than to the size of the table.
--
-- Membership filtering rides on channel_members_user_idx as a probe per
-- candidate row, which is cheap and bounded by the same LIMIT.
CREATE INDEX IF NOT EXISTS thread_activity_recent_idx
  ON thread_activity (last_reply_ts DESC);

ALTER TABLE thread_activity
  DROP CONSTRAINT IF EXISTS thread_activity_head_fk;
ALTER TABLE thread_activity
  ADD  CONSTRAINT thread_activity_head_fk
  FOREIGN KEY (head_ts, thread_id) REFERENCES messages (ts, id) ON DELETE CASCADE;

COMMENT ON TABLE thread_activity IS
  'one row per thread (created by its first reply): head + newest-reply pointers and reply count, so thread reads never aggregate over the partitioned messages table.';

-- ---- backfill -------------------------------------------------------------
--
-- One-time full scan of messages. This is the exact scan we are removing from
-- the hot path, paid once. On a fresh database it is a no-op.
--
-- DISTINCT ON rather than a window function: it reads as what it is ("the
-- newest reply per thread") and Postgres serves it from one sort.
WITH last_reply AS (
  SELECT DISTINCT ON (thread_id)
         thread_id, id, ts, seq, sender_device_id
    FROM messages
   WHERE parent_id IS NOT NULL AND thread_id IS NOT NULL
   ORDER BY thread_id, seq DESC
),
reply_counts AS (
  SELECT thread_id, COUNT(*) AS cnt
    FROM messages
   WHERE parent_id IS NOT NULL AND thread_id IS NOT NULL
   GROUP BY thread_id
)
INSERT INTO thread_activity (
  thread_id, channel_id, head_ts, head_seq, head_sender_id,
  last_reply_id, last_reply_ts, last_reply_seq, last_reply_sender_id, reply_count
)
SELECT h.id, h.channel_id, h.ts, h.seq, hd.user_id,
       lr.id, lr.ts, lr.seq, rd.user_id, rc.cnt
  FROM last_reply lr
  JOIN reply_counts rc ON rc.thread_id = lr.thread_id
  -- No ts predicate on purpose: the planner hash-joins this against the
  -- already-materialized reply set instead of doing one all-partition probe
  -- per thread.
  JOIN messages h      ON h.id = lr.thread_id
  LEFT JOIN devices hd ON hd.id = h.sender_device_id
  LEFT JOIN devices rd ON rd.id = lr.sender_device_id
ON CONFLICT (thread_id) DO NOTHING;

COMMIT;
