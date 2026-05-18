-- chalk -- migration 0019 (phase 09d-1)
-- Add admin-moderation lifecycle columns to users.
--
-- These two columns implement the two non-purge moderation states
-- listed in docs/phase-09-plan.md DECISION 8 ("Admin actions"):
--
--   blocked_at  — admin has suspended the user. Sessions are killed
--                 on transition; login is refused until unblocked.
--                 Account data, messages, channel memberships all
--                 stay intact so unblock is a clean restore.
--
--   deleted_at  — admin (or, in a later phase, the user themselves)
--                 has soft-deleted the account. Login refused.
--                 Messages stay because messages.sender_id still
--                 points to the user row; the UI shows the row's
--                 display_name with a "(deleted)" suffix. The user
--                 row persists so the email is still claimed (the
--                 users.email unique index blocks re-registration
--                 with the same address until the account is purged).
--
-- Both columns are nullable timestamps; the *_at convention matches
-- the existing email_verified_at / pending_email_expires_at columns
-- from migration 0011 (and matches the plan-doc's pseudocode).
--
-- This migration is additive only. No existing rows have non-null
-- values after applying it; existing semantics are preserved.
--
-- Hard purge (deleting the row entirely) is NOT represented by a
-- column. Purge uses the existing DELETE path; messages are kept
-- via the ON DELETE SET NULL on messages.sender_id (migration 0009);
-- everything else cascades. The refuse_admin_delete trigger from
-- migration 0011 already prevents purging the admin row.
--
-- See docs/phase-09-plan.md DECISION 8 + DECISION 10.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Partial indexes for the admin "list blocked / list deleted" queries
-- and for the soft-delete-aware login lookup. Cheap; both columns are
-- expected to be NULL for the overwhelming majority of rows, so the
-- partial form keeps the index small.
CREATE INDEX IF NOT EXISTS users_blocked_at_idx
  ON users(blocked_at)
  WHERE blocked_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS users_deleted_at_idx
  ON users(deleted_at)
  WHERE deleted_at IS NOT NULL;

-- The admin row must never be blocked or soft-deleted. The
-- refuse_admin_delete trigger from migration 0011 already protects
-- against hard delete; we extend that with a BEFORE UPDATE guard so
-- an accidental UPDATE users SET blocked_at = now() WHERE role='admin'
-- (which an admin endpoint should refuse before reaching the DB) is
-- also rejected at the storage layer. Defense in depth.
CREATE OR REPLACE FUNCTION refuse_admin_lifecycle_change() RETURNS trigger AS $$
BEGIN
  IF OLD.role = 'admin' THEN
    IF NEW.blocked_at IS NOT NULL AND OLD.blocked_at IS NULL THEN
      RAISE EXCEPTION 'cannot block admin user (id=%)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
      RAISE EXCEPTION 'cannot soft-delete admin user (id=%)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS admin_lifecycle_guard ON users;
CREATE TRIGGER admin_lifecycle_guard
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION refuse_admin_lifecycle_change();

COMMIT;
