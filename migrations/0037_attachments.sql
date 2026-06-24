-- chalk -- migration 0037 (att-1: attachments server core)
-- Encrypted attachment blobs, range-partitioned by created_at (monthly),
-- aligned with the messages table.
--
-- WHY A DEDICATED, PARTITIONED TABLE (see docs/design attachments spec §0, S1):
--   * The hot message-feed query stays small: heavy ciphertext lives here, not
--     inline in messages.body. Postgres auto-TOASTs large bytea out-of-line.
--   * Partitioning by created_at on the SAME monthly cadence as messages means a
--     bounded history fetch touches only recent partitions on both tables, the
--     attachments<->messages correlation stays partition-aligned, and old blobs
--     prune by DROPping old partitions (constant-time retention, no DELETE storm).
--   * A 'storage' discriminator could later point the bytes at object storage;
--     v1 is db-only (ciphertext bytea). The store boundary is the only thing that
--     would change.
--
-- SERVER-VISIBLE COLUMNS LEAK NOTHING SENSITIVE: just sizes, channel, key
-- version, timestamps, and status. name/mime/kind/dimensions live INSIDE
-- enc_meta (E2E, server-opaque), exactly like message bodies. The server is a
-- blind store of ciphertext.
--
-- PARTITION KEY / PK: like messages, the partition key (created_at) must be in
-- every unique constraint, so the PK is (created_at, id). A lookup by id alone
-- (download/finalize/chunk-append) is served by the non-unique attachments_id
-- index below: an Append index-scan across the (few) monthly partitions. id is
-- a server-generated UUID so it is globally unique by construction even without
-- a single-partition unique index, the same contract messages already relies on.
--
-- Child partitions (attachments_YYYY_MM) are NOT created here; chalkd creates
-- the current + next month at startup and via the daily maintenance loop, the
-- same machinery as messages. See internal/store/partitions.go
-- (EnsureAttachmentPartitions).

BEGIN;

CREATE TABLE IF NOT EXISTS attachments (
  id                  UUID         NOT NULL,
  channel_id          UUID         NOT NULL,
  -- message_id / message_ts are NULL while uploading; set when the send frame
  -- that carries this attachment is recorded (LinkAttachmentsToMessage). Both
  -- are needed because messages is partitioned on ts.
  message_id          UUID,
  message_ts          TIMESTAMPTZ,
  uploader_device_id  UUID         NOT NULL,
  key_version         INTEGER      NOT NULL,        -- channel key version it's encrypted under
  byte_len            BIGINT       NOT NULL,        -- declared full ciphertext length (server-visible; fine)
  ciphertext          BYTEA,                        -- encrypted full blob (TOASTed); NULL until chunk-assembled
  enc_preview         BYTEA,                        -- encrypted low-res preview (image kinds only; NULL otherwise)
  preview_len         INTEGER      NOT NULL DEFAULT 0,
  enc_meta            BYTEA        NOT NULL,         -- encrypted {name,mime,kind,...} (server-opaque)
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  status              TEXT         NOT NULL DEFAULT 'uploading',  -- uploading|complete|orphaned

  PRIMARY KEY (created_at, id),

  CONSTRAINT attachments_status_valid
    CHECK (status IN ('uploading', 'complete', 'orphaned')),
  CONSTRAINT attachments_key_version_positive
    CHECK (key_version >= 1),
  CONSTRAINT attachments_byte_len_nonneg
    CHECK (byte_len >= 0),
  CONSTRAINT attachments_preview_len_nonneg
    CHECK (preview_len >= 0)
) PARTITION BY RANGE (created_at);

-- Point lookup by id (download / finalize / chunk-append / orphan delete).
-- Non-unique, so it does not need the partition key; created on every partition.
CREATE INDEX IF NOT EXISTS attachments_id_idx
  ON attachments (id);

-- Fetch-window-bounded list query (CHALK_ATTACH_FETCH_WINDOW_HOURS): the feed
-- eagerly loads recent attachments for a channel within the lookback window.
CREATE INDEX IF NOT EXISTS attachments_channel_created_idx
  ON attachments (channel_id, created_at DESC);

-- Per-message ref fetch (live push correlation). Partial: only linked rows.
CREATE INDEX IF NOT EXISTS attachments_message_idx
  ON attachments (message_id) WHERE message_id IS NOT NULL;

-- Orphan janitor: stale 'uploading' rows that never got a finalize/send. Tiny
-- partial index, usually empty in steady state.
CREATE INDEX IF NOT EXISTS attachments_orphan_idx
  ON attachments (created_at) WHERE status = 'uploading';

-- Chunk staging area for the chunked HTTP upload (the 1 MiB WS frame limit
-- makes WS unsuitable for multi-MB blobs; see auth/attachments_http.go).
-- Chunks land here keyed by (attachment_id, seq); FinalizeAttachment assembles
-- them in seq order into attachments.ciphertext and clears the staged rows.
--
-- Deliberately NOT partitioned and NOT FK-bound: it is transient (cleared on
-- finalize; the orphan janitor clears staged rows for stale uploads), and a
-- simple FK can't reference a partitioned parent whose PK includes created_at.
CREATE TABLE IF NOT EXISTS attachment_chunks (
  attachment_id  UUID     NOT NULL,
  seq            INTEGER  NOT NULL,
  data           BYTEA    NOT NULL,
  PRIMARY KEY (attachment_id, seq),
  CONSTRAINT attachment_chunks_seq_nonneg CHECK (seq >= 0),
  CONSTRAINT attachment_chunks_data_nonempty CHECK (octet_length(data) > 0)
);

COMMIT;
