-- Phase 11b-1: MLS group state per channel.
--
-- One row per channel that has been upgraded to MLS. Plaintext
-- channels (everything pre-11b, plus channels we never encrypt)
-- simply don't have a row here.
--
-- The PRIMARY KEY is channel_id so we get free idempotency: if
-- alice2 retries a commit_bundle (network blip), the second
-- UpsertMlsGroup is a no-op when the same group_id+epoch is
-- presented. Different epoch -> we update current_epoch.
--
-- mls_group_id: opaque bytes from CoreCrypto (the conversation_id
-- it assigned). Server stores them so other devices can look up
-- "which MLS group is this channel?" without re-deriving.
--
-- creator_user_id: who started the group. Useful for debugging,
-- not relied on by the protocol.
--
-- current_epoch: latest known epoch of the group. Server uses
-- this to detect stale commits (commit for epoch N+1 arrives, but
-- a different commit for epoch N+1 is already stored -> conflict,
-- which 11b-1 just logs; richer conflict resolution is a later phase).

CREATE TABLE IF NOT EXISTS mls_groups (
    channel_id      UUID        PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    mls_group_id    BYTEA       NOT NULL,
    creator_user_id UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    current_epoch   BIGINT      NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Looking up "what group does this mls_group_id refer to" is useful
-- when the server needs to validate that an incoming commit_bundle
-- targets a group we know about. The pair (mls_group_id) is unique
-- across channels (CoreCrypto generates fresh group IDs), so this
-- is a UNIQUE index, not just a regular one.
CREATE UNIQUE INDEX IF NOT EXISTS mls_groups_by_group_id
    ON mls_groups (mls_group_id);
