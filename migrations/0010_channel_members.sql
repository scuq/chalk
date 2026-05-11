-- chalk -- migration 0010 (phase 08)
-- channel_members + is_dm flag + DM-cardinality trigger.
--
-- channels.is_dm is added here rather than in 0002 because phase 02
-- didn't yet have the concept; making it nullable would let some
-- channels exist with NULL is_dm meaning "we don't know," which is
-- worse than defaulting them to false. Existing rows get is_dm=false.
--
-- channel_members is the membership table. PK is (channel_id, user_id)
-- so a user can't be doubly-added; both cardinalities have indexes for
-- the two natural read patterns (list members of a channel, list
-- channels a user is in).
--
-- DM cardinality is enforced with a constraint trigger: a channel
-- with is_dm = true must have exactly 2 members AFTER the transaction
-- that touches its membership. We use DEFERRABLE so we can INSERT the
-- channel row, INSERT 2 member rows, and commit -- the check runs at
-- commit, not after each insert.

BEGIN;

-- 1. is_dm flag on channels.
ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS is_dm BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Membership table.
CREATE TABLE IF NOT EXISTS channel_members (
  channel_id  UUID         NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id     UUID         NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  joined_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- "role" reserved for phase 11+ (owner / admin / member). For
  -- phase 08 we just record 'member'; the creator gets 'owner'.
  role        TEXT         NOT NULL DEFAULT 'member'
                CHECK (role IN ('owner', 'admin', 'member')),
  PRIMARY KEY (channel_id, user_id)
);

-- For "list members of channel X" we have the PK prefix.
-- For "list channels user Y is in" we need the reverse direction.
CREATE INDEX IF NOT EXISTS channel_members_user_idx
  ON channel_members (user_id, channel_id);

-- 3. DM cardinality trigger.
--
-- Why a constraint trigger and not a CHECK constraint:
--   * CHECK constraints can't aggregate across rows in the same table.
--   * A row-level trigger fires per row; we need set-level enforcement.
--   * A statement-level trigger after INSERT/DELETE/UPDATE gives us
--     post-statement visibility into the new state, and DEFERRABLE
--     lets us defer to commit so multi-statement create-with-members
--     transactions work.
CREATE OR REPLACE FUNCTION check_dm_cardinality() RETURNS TRIGGER AS $$
DECLARE
  cnt INT;
  is_dm_flag BOOLEAN;
BEGIN
  -- Iterate over channel_ids touched by this statement. NEW/OLD only
  -- give us per-row data for row-level triggers; for statement-level
  -- we'd need transition tables. For simplicity we just check all
  -- DM channels in the table at commit time. This is O(N) in DM
  -- count, fine for the size of a chat deployment.
  FOR is_dm_flag, cnt IN
    SELECT c.is_dm, COUNT(cm.user_id)
      FROM channels c
      LEFT JOIN channel_members cm ON cm.channel_id = c.id
     WHERE c.is_dm = TRUE
     GROUP BY c.id, c.is_dm
  LOOP
    IF is_dm_flag AND cnt <> 2 THEN
      RAISE EXCEPTION 'DM channel must have exactly 2 members, found %', cnt
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Replace any existing trigger to keep this idempotent on re-runs.
DROP TRIGGER IF EXISTS channel_members_dm_check ON channel_members;

CREATE CONSTRAINT TRIGGER channel_members_dm_check
  AFTER INSERT OR UPDATE OR DELETE ON channel_members
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION check_dm_cardinality();

-- 4. Backfill: the placeholder "default" channel (created at runtime by
--    store.EnsureDefaultChannel) is not a DM and has no members. After
--    phase 08, it stays accessible via the fallback path; the phase 08
--    SPA always uses real channels.

COMMIT;
