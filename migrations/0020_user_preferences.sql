-- chalk -- migration 0020 (phase 9.7)
-- User preferences. One row per user, JSONB body, lazy-created.
--
-- Why JSONB? Adding new pref keys later doesn't need a migration --
-- the SPA decides the shape, the server treats it as an opaque blob
-- with one rule (partial-merge updates). This is fine because prefs
-- are non-critical, non-queried data; we never JOIN on them.
--
-- If a pref ever needs to be queried server-side (e.g. "find all
-- users with notification_email=true"), that key gets promoted to a
-- first-class column in a future migration. JSONB plays nicely with
-- that: we keep the JSONB column as-is and add a generated column
-- or a separate view.
--
-- updated_at is bumped on every UPSERT so the SPA can do timestamp-
-- based cache invalidation later if needed.

BEGIN;

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id      UUID         PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  prefs        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMIT;
