-- Phase 21-7e: drop channels.is_mls.
-- Per-channel MLS flag removed in code (21-7d); every channel is plaintext.
-- CreateChannel INSERT already stopped writing it (DEFAULT false covered
-- the gap), so the server ran correctly before this. No index refs it.
-- Phase 23's encrypted-channel concept uses its own schema, not this column.
ALTER TABLE channels DROP COLUMN IF EXISTS is_mls;
