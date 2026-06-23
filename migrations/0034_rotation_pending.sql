-- chalk -- migration 0034 (member removal + rotate-on-removal)
-- channels.rotation_pending: a durable, visible "this channel needs a key
-- rotation" flag.
--
-- When a member is removed, the channel key MUST be rotated so the removed
-- member (who still holds the old-version wrap) cannot read messages sent
-- afterward. But rotation is client-minted (the creator's browser), so it can't
-- happen inside the removal transaction -- and the creator may be offline.
--
-- This flag makes the pending state DURABLE: removal sets it; the next
-- successful AdvanceChannelKeyVersion clears it. The creator's client rotates
-- on a rotate_needed push if online, or on next connect/channel-open if not.
-- The members panel surfaces it so an incomplete revocation is VISIBLE rather
-- than silently leaving the ex-member with read access.
--
-- Default false: existing channels are not pending.

BEGIN;

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS rotation_pending BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
