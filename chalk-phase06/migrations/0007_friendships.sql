-- chalk -- migration 0007
-- Friendships: pending, accepted, blocked.
--
-- Storage convention:
--   * accepted: one row per pair, stored with user_a < user_b lexicographically.
--     Either party can find the friendship with a CHECK on both orderings.
--   * pending: user_a is the requester, user_b is the recipient. NOT
--     reordered -- direction matters.
--   * blocked: user_a is the blocker, user_b is the blocked. Asymmetric;
--     if alice blocks bob, only alice sees the blocked row.
--
-- This mixed convention means application code must check status before
-- assuming ordering. The advantage: accepted-friendship lookups are O(1)
-- by sorted key, and pending/blocked carry direction in the row itself.
--
-- Alternative considered: always store both directions (two rows per
-- friendship). Doubles row count, makes invariants harder. Rejected.

BEGIN;

CREATE TABLE IF NOT EXISTS friendships (
  user_a        UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b        UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT         NOT NULL,
  requested_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  accepted_at   TIMESTAMPTZ,
  PRIMARY KEY (user_a, user_b)
);

ALTER TABLE friendships
  DROP CONSTRAINT IF EXISTS friendships_status_valid;
ALTER TABLE friendships
  ADD  CONSTRAINT friendships_status_valid
  CHECK (status IN ('pending', 'accepted', 'blocked'));

ALTER TABLE friendships
  DROP CONSTRAINT IF EXISTS friendships_not_self;
ALTER TABLE friendships
  ADD  CONSTRAINT friendships_not_self
  CHECK (user_a <> user_b);

-- For 'accepted' rows, enforce the lexicographic ordering so we have a
-- single canonical row. For 'pending' and 'blocked' the direction matters,
-- so this constraint only applies to accepted.
ALTER TABLE friendships
  DROP CONSTRAINT IF EXISTS friendships_accepted_canonical;
ALTER TABLE friendships
  ADD  CONSTRAINT friendships_accepted_canonical
  CHECK (status <> 'accepted' OR user_a < user_b);

-- Quick lookup of "all of my friendships" from either side.
CREATE INDEX IF NOT EXISTS friendships_user_b_idx
  ON friendships (user_b, status);

-- Pending requests targeting a specific recipient (for the "incoming
-- requests" view).
CREATE INDEX IF NOT EXISTS friendships_pending_recipient_idx
  ON friendships (user_b) WHERE status = 'pending';

COMMIT;
