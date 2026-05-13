-- chalk -- migration 0011 (phase 09b)
-- Extend users for real auth: usernames, display_name, email, role,
-- email verification + pending-change state.
--
-- This migration is additive. It adds new columns alongside the
-- existing handle column (which is preserved for now -- wire frame
-- rename happens in a later sub-step). Existing rows are backfilled
-- with sensible defaults derived from handle so the schema becomes
-- valid without any application logic running.
--
-- BACKFILL CAUTION:
-- Existing rows must have a handle that matches the username regex
-- (^[a-z0-9_]{3,32}$) for the constraint to apply cleanly. For dev
-- fixtures (alice/bob/carol) this is fine; for production data the
-- operator must clean up handles that don't match before running
-- this migration. The constraint addition will fail with a clear
-- error message listing the offending rows.
--
-- Backfill choices for existing rows:
--   username       <- handle (handle is CITEXT, fits the same shape)
--   display_name   <- handle (mutable going forward)
--   email          <- handle || '@localhost.invalid'
--                     (.invalid is reserved by RFC 6761 for cases like this;
--                      this lets the fixture users keep working without
--                      any operator action; production rows shouldn't
--                      exist yet at the point this migration runs)
--   role           <- 'user' (default; admin is bootstrapped separately)
--   email_verified_at <- now() for existing rows (they predate the
--                        verification requirement; treat as grandfathered)
--
-- New invariants this migration establishes:
--   - exactly-one admin row (partial unique index on role='admin')
--   - admin row cannot be deleted (refuse_admin_delete trigger)
--   - at most one pending email change per user
--   - email is globally unique
--   - username is globally unique and matches a strict shape
--   - role is constrained to ('user', 'admin')
--
-- See docs/phase-09-plan.md DECISIONs 1, 2, 8 for rationale.

BEGIN;

-- ---- new columns on users -----------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS username                  CITEXT,
  ADD COLUMN IF NOT EXISTS display_name              TEXT,
  ADD COLUMN IF NOT EXISTS email                     CITEXT,
  ADD COLUMN IF NOT EXISTS role                      TEXT        NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS email_verified_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pending_email             CITEXT,
  ADD COLUMN IF NOT EXISTS pending_email_token       BYTEA,
  ADD COLUMN IF NOT EXISTS pending_email_expires_at  TIMESTAMPTZ;

-- ---- backfill existing rows --------------------------------------------
-- handle is NOT NULL so this is safe. Use COALESCE to be defensive
-- against partial reapplies where some columns were already populated.
UPDATE users SET
  username          = COALESCE(username, handle::text::citext),
  display_name      = COALESCE(display_name, handle::text),
  email             = COALESCE(email, (handle::text || '@localhost.invalid')::citext),
  email_verified_at = COALESCE(email_verified_at, now())
WHERE
  username IS NULL OR display_name IS NULL OR
  email IS NULL OR email_verified_at IS NULL;

-- ---- enforce NOT NULL on backfilled columns -----------------------------
ALTER TABLE users
  ALTER COLUMN username     SET NOT NULL,
  ALTER COLUMN display_name SET NOT NULL,
  ALTER COLUMN email        SET NOT NULL;

-- ---- uniqueness ---------------------------------------------------------
-- Use unique indexes (not constraints) so re-running this migration after
-- a partial failure doesn't leave inconsistent constraint state.
CREATE UNIQUE INDEX IF NOT EXISTS users_username_idx ON users(username);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx    ON users(email);

-- ---- shape constraints --------------------------------------------------
-- Username: ASCII lowercase letters, digits, underscore; 3-32 chars.
-- This is strict on purpose to avoid impersonation games (e.g. Greek
-- upsilon vs Latin u). See plan DECISION 1.
--
-- NOTE: existing rows are backfilled with username = handle. If any
-- existing handle does not match ^[a-z0-9_]{3,32}$ (e.g. mixed case,
-- hyphens, fewer than 3 chars), this constraint addition will FAIL
-- and the migration aborts. For dev fixtures (alice/bob/carol) this
-- is fine; for production data the operator must clean up handles
-- before applying this migration. See the BACKFILL CAUTION block at
-- the top of the file.
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_username_shape;
ALTER TABLE users
  ADD  CONSTRAINT users_username_shape
  CHECK (username::text ~ '^[a-z0-9_]{3,32}$');

-- Role: only 'user' or 'admin'.
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_role_valid;
ALTER TABLE users
  ADD  CONSTRAINT users_role_valid
  CHECK (role IN ('user', 'admin'));

-- ---- admin singleton ----------------------------------------------------
-- At most one row in users may have role='admin'. Enforced as a partial
-- unique index on a constant expression: every admin row maps to the
-- same key (1), so two admins would collide.
CREATE UNIQUE INDEX IF NOT EXISTS users_single_admin_idx
  ON users((1))
  WHERE role = 'admin';

-- Admin cannot be deleted by ordinary DELETE. The plan calls for soft
-- delete and purge to leave the admin row alone; the application's
-- admin moderation code should never attempt to delete the admin
-- itself (refuse before reaching the database), but defense in depth
-- is cheap.
CREATE OR REPLACE FUNCTION refuse_admin_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.role = 'admin' THEN
    RAISE EXCEPTION 'cannot delete admin user (id=%)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS admin_delete_guard ON users;
CREATE TRIGGER admin_delete_guard
  BEFORE DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION refuse_admin_delete();

-- ---- pending email uniqueness ------------------------------------------
-- At most one user may have a given pending_email at a time. This
-- prevents two users from racing to claim the same new address before
-- one of them verifies. The PRIMARY uniqueness on users.email already
-- blocks the final state; this partial index blocks the intermediate.
CREATE UNIQUE INDEX IF NOT EXISTS users_pending_email_idx
  ON users(pending_email)
  WHERE pending_email IS NOT NULL;

-- ---- index for username lookup ----------------------------------------
-- Login looks up users by username. The unique index above already
-- supports this; no extra index needed.

COMMIT;
