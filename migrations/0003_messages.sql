-- chalk -- migration 0003
-- Partitioned messages table.
--
-- Why partitioned:
--   * Old delivered messages move to slower tablespace (see docs/architecture)
--     by ALTER TABLE ... SET TABLESPACE on individual partitions.
--   * Hot path queries are bounded by the most-recent partition(s).
--   * Pruning detached partitions is constant-time, no DELETE storm.
--
-- The partition key is ts. The PK is (ts, id); Postgres requires the partition
-- key to be in every unique constraint on a partitioned table. As a result,
-- application code looking up a single message by its UUID must also pass ts
-- (or a date range) to avoid scanning every partition. The wire protocol
-- carries ts on every message, so this is natural.
--
-- Partitions themselves (e.g. messages_2026_05) are NOT created here. They
-- are managed by chalkd at startup and via a daily background loop --
-- creating the current month's partition and the next month's. See
-- internal/store/partitions.go.

BEGIN;

CREATE TABLE IF NOT EXISTS messages (
  id                UUID         NOT NULL,
  channel_id        UUID         NOT NULL,
  thread_id         UUID,
  parent_id         UUID,
  sender_device_id  UUID         NOT NULL,
  seq               BIGINT       NOT NULL,
  ts                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  delivered_at      TIMESTAMPTZ,
  mls_epoch         BIGINT       NOT NULL DEFAULT 0,
  content_type      TEXT         NOT NULL,
  ciphertext        BYTEA        NOT NULL,
  meta              JSONB        NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (ts, id)
) PARTITION BY RANGE (ts);

-- Indexes are inherited by every partition.
CREATE INDEX IF NOT EXISTS messages_channel_seq_idx
  ON messages (channel_id, seq);
CREATE INDEX IF NOT EXISTS messages_channel_ts_desc_idx
  ON messages (channel_id, ts DESC);
CREATE INDEX IF NOT EXISTS messages_thread_idx
  ON messages (channel_id, thread_id, ts) WHERE thread_id IS NOT NULL;

-- Partial index for the GC sweep that finds undelivered messages older than
-- the purge window. WHERE delivered_at IS NULL keeps the index tiny: usually
-- empty in steady state, only populated for messages no one has seen yet.
CREATE INDEX IF NOT EXISTS messages_undelivered_idx
  ON messages (ts) WHERE delivered_at IS NULL;

-- Foreign keys on partitioned tables: Postgres supports outgoing FKs from
-- a partitioned table starting in PG 12. We add only the device FK here
-- (channel/sender are application-enforced; channel goes via channel_id
-- but the channel_members table that would enforce it lands in phase 08).
ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_sender_device_fk;
ALTER TABLE messages
  ADD  CONSTRAINT messages_sender_device_fk
  FOREIGN KEY (sender_device_id) REFERENCES devices(id) ON DELETE CASCADE;

COMMIT;
