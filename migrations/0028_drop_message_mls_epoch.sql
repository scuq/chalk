-- Phase 21-7e: drop messages.mls_epoch.
-- MLS gone (21-1..21-6); store stopped using mls_epoch in 21-7b. Phase 23
-- adds its own key-version column if needed (not a rename of this one).
-- No index/constraint references it. Partitioned-table safe.
ALTER TABLE messages DROP COLUMN IF EXISTS mls_epoch;
