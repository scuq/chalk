-- chalk -- migration 0036 (gov-1a: governance schema)
--
-- The generic proposal -> votes -> resolution engine's data layer, plus the
-- per-channel governance config columns. No wire/handler surface yet (that is
-- gov-1b); this migration + the store primitives + the pure tally evaluator
-- are the engine foundation.
--
-- MODEL (from the hardened spec):
--   * Governance is a channel-level MODE: 'dictator' (owner acts unilaterally,
--     today's behavior, the default) or 'democratic' (privileged actions need a
--     passed proposal).
--   * Eligibility is a FROZEN SNAPSHOT taken at proposal creation
--     (proposal_eligibility), never a live query -- the denominator cannot be
--     shifted after the question is asked (defeats the timing/denominator
--     attack).
--   * Tally is a two-part test: turnout quorum of the snapshot AND a
--     (super)majority of those who actually voted, resolving early only when the
--     result is mathematically LOCKED (remaining un-cast votes can't change it).
--   * Every proposal MUST expire (no zombie votes).
--
-- The per-channel config columns are seeded at channel creation from the
-- server-wide env defaults (CHALK_VOTE_*); changing an env var affects only
-- channels created afterward. Existing rows get the migration DEFAULTs below
-- (which match the env defaults).

BEGIN;

-- ---- per-channel governance config (H9/H14) --------------------------------
ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS governance_mode          TEXT NOT NULL DEFAULT 'dictator',
  ADD COLUMN IF NOT EXISTS vote_window_days         INT  NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS vote_expiry_hours        INT  NOT NULL DEFAULT 168,
  ADD COLUMN IF NOT EXISTS min_eligible             INT  NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS quorum_percent           INT  NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS pass_percent             INT  NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS supermajority_percent    INT  NOT NULL DEFAULT 67,
  ADD COLUMN IF NOT EXISTS repropose_cooldown_hours INT  NOT NULL DEFAULT 168;

-- Constrain the mode to the two known values. Idempotent guard so a manual
-- re-run doesn't error (the migrate runner already applies each file once).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'channels_governance_mode_chk'
  ) THEN
    ALTER TABLE channels
      ADD CONSTRAINT channels_governance_mode_chk
      CHECK (governance_mode IN ('dictator', 'democratic'));
  END IF;
END $$;

-- ---- proposals -------------------------------------------------------------
-- One row per governance question. type is a discriminated string (the engine
-- is type-agnostic; only the action dispatch in gov-1b switches on it). The
-- tally parameters are FROZEN onto the row at creation so a later change to the
-- channel's config can't move the goalposts of an in-flight vote.
CREATE TABLE IF NOT EXISTS proposals (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id            UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  type                  TEXT NOT NULL,                       -- 'remove_member' | 'add_member' | 'set_mode' | 'delete_message'
  target_id             UUID,                                -- subject member (remove/add); NULL for set_mode
  payload               JSONB NOT NULL DEFAULT '{}'::jsonb,  -- generic slot (e.g. {"mode":"dictator"} for set_mode)
  created_by            UUID NOT NULL REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ NOT NULL,                -- H8: mandatory; unresolved -> failed at expiry
  status                TEXT NOT NULL DEFAULT 'open',        -- open|passed|failed|cancelled|passed_moot
  resolved_at           TIMESTAMPTZ,
  -- frozen tally parameters (snapshot of the channel config at creation):
  window_days           INT NOT NULL,
  min_eligible          INT NOT NULL,
  quorum_percent        INT NOT NULL,
  pass_percent          INT NOT NULL,
  supermajority_percent INT NOT NULL,
  CONSTRAINT proposals_status_chk
    CHECK (status IN ('open', 'passed', 'failed', 'cancelled', 'passed_moot'))
);

-- List open/recent proposals per channel.
CREATE INDEX IF NOT EXISTS proposals_channel_status_idx
  ON proposals (channel_id, status);

-- Expiry sweeper (gov-1b) finds open proposals past their deadline.
CREATE INDEX IF NOT EXISTS proposals_open_expiry_idx
  ON proposals (expires_at) WHERE status = 'open';

-- H3 uniqueness: at most ONE open proposal per (channel, type, target). NULL
-- target (e.g. set_mode) collapses to a sentinel so there is at most one open
-- set_mode per channel. Different types for the same target may coexist (they
-- re-check at execution; first to fire wins, the other goes passed_moot).
CREATE UNIQUE INDEX IF NOT EXISTS proposals_one_open_per_target_idx
  ON proposals (
    channel_id,
    type,
    COALESCE(target_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE status = 'open';

-- ---- proposal_votes --------------------------------------------------------
-- One row per (proposal, voter). PK enables change-vote via UPSERT (votes are
-- mutable until the proposal resolves -- H6). Only yes/no are stored; an
-- abstention is simply the absence of a row (it still counts toward the
-- snapshot denominator, not toward turnout).
CREATE TABLE IF NOT EXISTS proposal_votes (
  proposal_id UUID NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  voter_id    UUID NOT NULL REFERENCES users(id),
  vote        TEXT NOT NULL CHECK (vote IN ('yes', 'no')),
  voted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id, voter_id)
);

-- ---- proposal_eligibility (the frozen snapshot, H1) ------------------------
-- The materialized eligible-voter set captured at creation. THE denominator
-- for the proposal's whole life. Membership in this table is also the authz
-- for casting a vote: if you're not in here, you can't vote on this proposal.
CREATE TABLE IF NOT EXISTS proposal_eligibility (
  proposal_id UUID NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  voter_id    UUID NOT NULL REFERENCES users(id),
  PRIMARY KEY (proposal_id, voter_id)
);

COMMIT;
