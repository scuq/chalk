-- chalk -- migration 0005
-- Sender purge-notification queue.
--
-- When the GC pass purges an undelivered message after the 90-day window,
-- it inserts a row here so the sender's device(s) can be notified that their
-- message never reached anyone.
--
-- Phase 05 only creates the schema. Phase 12 wires the GC sweep that
-- populates this, and a delivery loop that pushes pending notifications
-- over the WebSocket to the sender's connected devices.
--
-- Notifications themselves are NOT E2E encrypted: the server already knows
-- "device X sent message Y at time T", and a "Y was purged" notice leaks
-- nothing additional. The client correlates with its local outbox to surface
-- the purge in the UI.

BEGIN;

CREATE TABLE IF NOT EXISTS purge_notifications (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_device_id         UUID         NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  message_id               UUID         NOT NULL,
  channel_id               UUID         NOT NULL,
  reason                   TEXT         NOT NULL,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  delivered_to_sender_at   TIMESTAMPTZ
);

-- Phase 05 reasons:
ALTER TABLE purge_notifications
  DROP CONSTRAINT IF EXISTS purge_notifications_reason_valid;
ALTER TABLE purge_notifications
  ADD  CONSTRAINT purge_notifications_reason_valid
  CHECK (reason IN ('undelivered_purged'));

-- Pending-delivery index: cheap to scan, narrow because most notifications
-- are delivered quickly.
CREATE INDEX IF NOT EXISTS purge_notifications_pending_idx
  ON purge_notifications (sender_device_id) WHERE delivered_to_sender_at IS NULL;

COMMIT;
