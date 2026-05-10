-- chalk -- migration 0009
-- messages.sender_device_id: make nullable, change FK to ON DELETE SET NULL.
--
-- When a user is purged (tombstone grace period elapsed, GC removes the
-- user row), we want to preserve the messages they sent so channel history
-- doesn't get holes. The previous CASCADE on devices(id) would have
-- cascaded out the messages too. SET NULL keeps the row and unlinks the
-- sender; the wire frame surfaces NULL as sender:null and the client
-- renders "[unknown sender]".
--
-- This is a no-op for any deployment without purged users (i.e. all of
-- them, as of phase 06). It matters in phase 12+ when tombstone GC runs.

BEGIN;

ALTER TABLE messages
  ALTER COLUMN sender_device_id DROP NOT NULL;

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_sender_device_fk;
ALTER TABLE messages
  ADD  CONSTRAINT messages_sender_device_fk
  FOREIGN KEY (sender_device_id) REFERENCES devices(id) ON DELETE SET NULL;

COMMIT;
