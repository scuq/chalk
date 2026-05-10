-- chalk -- migration 0004
-- Per-recipient-device acknowledgements.
--
-- An ack records that a specific recipient device has received and surfaced
-- a specific message. Phase 05 only inserts acks via the wire protocol;
-- phase 12's GC pass uses them to determine when a message has been
-- "delivered" (first ack from any device that is NOT the sender's).
--
-- The composite FK (message_ts, message_id) -> messages(ts, id) is required
-- because messages is partitioned by ts. PG can only validate FKs into a
-- partitioned table when the FK references all columns of the target's PK.

BEGIN;

CREATE TABLE IF NOT EXISTS message_acks (
  message_id   UUID         NOT NULL,
  message_ts   TIMESTAMPTZ  NOT NULL,
  device_id    UUID         NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  acked_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, message_ts, device_id)
);

-- FK to messages. Note that ON DELETE CASCADE is honored only when the
-- delete happens via SQL DELETE; partition DETACH is a different operation
-- and won't fire cascade. That's fine: when we eventually move a partition
-- to cold storage, we'll move its acks alongside.
ALTER TABLE message_acks
  DROP CONSTRAINT IF EXISTS message_acks_message_fk;
ALTER TABLE message_acks
  ADD  CONSTRAINT message_acks_message_fk
  FOREIGN KEY (message_ts, message_id) REFERENCES messages (ts, id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS message_acks_device_idx
  ON message_acks (device_id, acked_at);

COMMIT;
