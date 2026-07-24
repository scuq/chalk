-- chalk -- migration 0041 (phase 31, slice 31-4)
-- TOTP reset staging: a re-enrolling user's NEW secret is staged in
-- totp_pending_secret_enc while the ACTIVE secret (totp_secret_enc) keeps
-- working. Confirm (one valid code against the pending secret) promotes
-- pending -> active atomically, so there is never a window without a working
-- second factor during a reset. First-time enrollment uses the same staging
-- path (active is simply NULL until the first confirm).
--
-- Additive: one nullable column, no backfill needed.

BEGIN;

ALTER TABLE user_auth
  ADD COLUMN IF NOT EXISTS totp_pending_secret_enc BYTEA;

COMMIT;
