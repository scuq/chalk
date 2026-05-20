-- Phase 11c-1: stored MLS commits for late-joiner catchup.
--
-- One row per (channel_id, epoch). The PRIMARY KEY enforces "at
-- most one commit per epoch per channel"; the store's
-- InsertMlsCommit (internal/store/mls_commits.go) uses read-then-
-- write under the default READ COMMITTED isolation level and falls
-- back to re-reading the row on PK violation, treating same-sender-
-- same-bytes as an idempotent retry and different bytes at the
-- same epoch as a stale-commit race.
--
-- Why store commits at all:
--   11b-1 fans Welcomes to live recipients and drops them for
--   offline users. That works for two-party DMs because the Welcome
--   IS the group state for a fresh joiner. In 11c, multi-member
--   channels accumulate a sequence of Commits over their lifetime
--   (Add emma, Remove carol, Add dave, ...). A device that goes
--   offline mid-sequence and reconnects needs to replay every Commit
--   it missed to catch up. We can't reconstruct those Commits
--   server-side (they're opaque MLS bytes from the initiator's
--   CoreCrypto), so we store them at the moment they land.
--
-- Why opaque BYTEA:
--   Same reason as mls_groups.mls_group_id: the server is a relay,
--   not an MLS implementation. The bytes are produced and consumed
--   by clients. Server only verifies the wrapper (epoch number,
--   channel_id, requester identity).
--
-- Why a size cap:
--   A single Commit for a typical chalk channel is 2-8 KB. The 64KB
--   cap leaves headroom for very large group changes (bulk add) while
--   refusing pathological inputs.
--
-- Retention:
--   Indefinite for v1. A user offline for a year needs every Commit
--   their channels accumulated in that year. Storage cost is bounded
--   by membership-change frequency: weekly changes in 100 channels =
--   ~50 KB/channel/year = 5 MB/user/year. Acceptable. If pruning
--   ever becomes necessary, prune commits older than the OLDEST
--   currently-active member's last-seen epoch, per channel.

CREATE TABLE IF NOT EXISTS mls_commits (
    channel_id              UUID        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    epoch                   BIGINT      NOT NULL,
    commit_bytes            BYTEA       NOT NULL,
    committed_by_user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    committed_by_device_id  UUID        NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
    committed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (channel_id, epoch)
);

-- Size cap on the opaque commit bytes. 64KB is well above realistic
-- Commit sizes; this rejects pathological inputs.
ALTER TABLE mls_commits
    DROP CONSTRAINT IF EXISTS mls_commits_size_cap;
ALTER TABLE mls_commits
    ADD CONSTRAINT mls_commits_size_cap
    CHECK (octet_length(commit_bytes) <= 65536);

-- Lookup pattern for catchup: "give me all commits for channel X
-- after epoch N, in epoch order." The PK already supports this
-- (it's a (channel_id, epoch) composite), so no additional index
-- needed. Including this NOTE comment to make the intent explicit
-- for the next reader.
--
-- NOTE: catchup query is
--   SELECT epoch, commit_bytes, committed_by_user_id, committed_at
--     FROM mls_commits
--    WHERE channel_id = $1 AND epoch > $2
--    ORDER BY epoch ASC;
-- which uses the PK index directly.
