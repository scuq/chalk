-- chalk -- migration 0053 (83-5: rotation-due carries the version it was
-- raised from)
--
-- 0034's rotation_pending is a bare boolean: "somebody was removed, the key
-- has not been rotated". Phase 83's D.2 makes rotation a first-responder
-- action any member performs atomically, gated by exactly WHICH version the
-- shrink happened at (P83-A-R17-N2): rotation_due_from = v means the
-- required successor is exactly v+1, the atomic rotate_channel_key must
-- present expected_version = v, and an ordinary send under v or older is
-- refused with rotation_required until it commits. A repeated shrink while
-- a rotation is pending re-marks from the same v (the send gate freezes the
-- version); after commit it clears; a later shrink marks v+1.
--
-- rotation_pending stays, kept equal to (rotation_due_from IS NOT NULL) by
-- every writer, so older clients and the existing members-panel badge keep
-- reading the same fact. Backfill: a channel already pending is due from its
-- current version -- the only version it can be.

BEGIN;

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS rotation_due_from INTEGER;

ALTER TABLE channels
  DROP CONSTRAINT IF EXISTS channels_rotation_due_from_positive;
ALTER TABLE channels
  ADD CONSTRAINT channels_rotation_due_from_positive
  CHECK (rotation_due_from IS NULL OR rotation_due_from >= 1);

UPDATE channels
   SET rotation_due_from = current_key_version
 WHERE rotation_pending AND rotation_due_from IS NULL;

COMMENT ON COLUMN channels.rotation_due_from IS
  'key version a membership shrink happened at; the next sender must rotate to +1 before sending (83-5)';

COMMIT;
