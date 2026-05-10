-- chalk -- migration 0006
-- User lifecycle: status, status_reason, status_changed_at, last_seen_at.
--
-- Three runtime statuses collapse a richer lifecycle model:
--   active        -- normal
--   soft_blocked  -- account exists but inactive (dormant/locked/deactivated)
--   deleted       -- tombstoned; row preserved during grace period for
--                    history rendering and recovery-code-based undelete
--
-- status_reason narrows the reason within soft_blocked / deleted:
--   dormant      -- last_seen_at past dormancy threshold (2 years)
--   locked       -- admin or repeated-auth-failure lock (phase 11+)
--   deactivated  -- user self-paused (phase 11+)
--   tombstoned   -- user-deleted; in grace period
--
-- Phase 06 lands the schema and read-path enforcement. Write-path
-- transitions (account_delete, account_deactivate, admin_lock) ship in
-- phase 11 once authenticated sessions exist to gate them.
--
-- last_seen_at is bumped on every successful hello so the eventual
-- dormancy GC has something to scan. Phase 06 only writes the column;
-- the GC is phase 12.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS status            TEXT        NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS status_reason     TEXT,
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_status_valid;
ALTER TABLE users
  ADD  CONSTRAINT users_status_valid
  CHECK (status IN ('active', 'soft_blocked', 'deleted'));

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_status_reason_valid;
ALTER TABLE users
  ADD  CONSTRAINT users_status_reason_valid
  CHECK (
    status_reason IS NULL OR
    status_reason IN ('dormant', 'locked', 'deactivated', 'tombstoned')
  );

-- An active user must have a NULL reason; a non-active user must have one.
-- This is a soft invariant (we don't want startup to crash if existing rows
-- violate it during a deploy), so we don't add a CHECK. Phase 11's
-- transition code is responsible for upholding it.

-- Indexes for the lifecycle GC sweeps (phase 12 will scan these).
CREATE INDEX IF NOT EXISTS users_status_idx
  ON users (status) WHERE status <> 'active';
CREATE INDEX IF NOT EXISTS users_last_seen_idx
  ON users (last_seen_at) WHERE status = 'active';

COMMIT;
