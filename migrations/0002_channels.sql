-- chalk -- migration 0002
-- Channels and per-channel monotonic sequence.
--
-- Schema only. The placeholder "default" channel that phase 05 tests
-- depend on is created at runtime by chalkd via store.EnsureDefaultChannel,
-- not in this migration. Reasoning:
--
--   * Migrations should describe schema, not seed runtime state.
--   * In production, a fresh DB has no users; a migration that inserts a
--     channel with FK created_by would fail.
--   * In dev/test, alice is created by the bootstrap fixture AFTER
--     migrations run, so an INSERT here would also fail.
--
-- Phase 08 introduces channel creation, membership, and the wire protocol
-- for managing channels.

BEGIN;

CREATE TABLE IF NOT EXISTS channels (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT         NOT NULL,
  -- created_by is NULLABLE so system-owned channels (the placeholder
  -- "default" channel, future system announcements, etc.) can exist
  -- without belonging to a user. User-created channels in phase 08 will
  -- always supply a creator.
  created_by  UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Per-channel monotonic sequence. We don't use a Postgres SEQUENCE here
-- because we want a sequence *per channel*, and creating thousands of
-- DB-level sequences is awkward. A small table + UPDATE ... RETURNING is
-- faster than people expect and matches our access pattern: one row per
-- channel, locked briefly per send.
CREATE TABLE IF NOT EXISTS channel_seq (
  channel_id  UUID    PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  next_seq    BIGINT  NOT NULL DEFAULT 1
);

COMMIT;
