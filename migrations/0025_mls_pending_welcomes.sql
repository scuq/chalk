-- Phase 11c-1 PR 4: buffered MLS Welcomes for offline recipients.
--
-- 11b-1 fan'd Welcomes to live recipients and dropped them for
-- offline users (see ws_mls.go's "user X offline, welcome dropped"
-- log). That was acceptable for two-party DMs where the recipient
-- was almost certainly online (you don't DM ghosts), but unworkable
-- for multi-member channels where adding a member can happen any
-- time regardless of whether they're connected.
--
-- This table buffers Welcomes until the recipient acks them. The
-- write path is in handleMlsCommitBundle (always buffer alongside
-- the live fanout, for simplicity -- the client deduplicates).
-- The read path is at hello time, after the Welcome frame is sent
-- the server queries this table and pushes any pending welcomes.
-- The delete path is handleMlsWelcomeAck.
--
-- Why PK (user_id, channel_id):
--   At most one pending Welcome per user per channel makes sense.
--   If a user is removed and re-added before they ack the original,
--   the second Welcome should replace the first (the fresher Welcome
--   reflects the current group state). ON CONFLICT DO UPDATE handles
--   this in the store layer.
--
-- Why opaque BYTEA:
--   Same reasoning as mls_commits.commit_bytes (PR 1). The server
--   is a relay; bytes are produced and consumed by clients.
--
-- Size cap: 64KB matches mls_commits. Real Welcomes for chalk's
-- ciphersuite are 1-4 KB; the cap rejects pathological inputs.

CREATE TABLE IF NOT EXISTS mls_pending_welcomes (
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id      UUID        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    mls_group_id    BYTEA       NOT NULL,
    welcome_bytes   BYTEA       NOT NULL,
    sender_user_id  UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    buffered_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, channel_id)
);

ALTER TABLE mls_pending_welcomes
    DROP CONSTRAINT IF EXISTS mls_pending_welcomes_size_cap;
ALTER TABLE mls_pending_welcomes
    ADD CONSTRAINT mls_pending_welcomes_size_cap
    CHECK (octet_length(welcome_bytes) <= 65536);

-- Lookup pattern for drain: "give me all pending welcomes for
-- user X." That uses the PK's user_id leading column directly,
-- no additional index needed.
--
-- NOTE: drain query is
--   SELECT channel_id, mls_group_id, welcome_bytes, sender_user_id
--     FROM mls_pending_welcomes
--    WHERE user_id = $1;
-- which uses the PK index (leading column scan).
