-- chalk -- migration 0035 (governance prerequisite: message deletion)
-- Soft-delete tombstone columns on messages.
--
-- Message deletion is a PREREQUISITE for the governance subsystem: you cannot
-- govern an action (the future `delete_message` proposal type) that has no
-- implementation. This phase builds owner-only (dictator-style) deletion; the
-- governance layer adds the democratic path later by wrapping the same store
-- primitive.
--
-- WHY A TOMBSTONE, NOT A HARD DELETE:
--   * The messages table is range-partitioned on ts and threads hang off
--     message ids (replies carry thread_id = head.id). Hard-DELETEing a row
--     would orphan a thread's replies and tear holes in the per-channel seq
--     ordering. Scrubbing in place keeps the structure intact.
--   * Governance wants an audit trail -- "this message was deleted, by whom,
--     when" -- which a tombstone preserves (status + actor + time) and a hard
--     delete destroys.
--   * The delete is a SERVER-SIDE SCRUB: the handler overwrites body with an
--     empty bytea and nulls key_version, so the ciphertext is gone from the
--     server. It is NOT guaranteed erasure from devices: anyone who already
--     decrypted the message still holds the plaintext locally. This is the
--     same forward-secrecy boundary as member removal / key revocation, and
--     is documented as a best-effort client tombstone, not a crypto-shred.
--
-- deleted_at: NULL = live message; non-NULL = tombstoned (the scrub time).
-- deleted_by: the user_id that performed the deletion (audit). Deliberately
--   NOT a foreign key -- consistent with how this partitioned table already
--   treats channel_id / sender (application-enforced), and so a later user
--   purge can't cascade-rewrite historical tombstones. A purged actor simply
--   leaves a dangling-but-harmless audit id.
--
-- ADD COLUMN IF NOT EXISTS on a partitioned table is metadata-only and
-- propagates to every existing and future partition (same pattern as 0032's
-- key_version). Default NULL means every existing message is "not deleted".

BEGIN;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS deleted_by UUID;

-- A partial index over the (rare) tombstoned rows. Stays tiny in steady state
-- because deletions are infrequent; lets future governance/audit queries that
-- scan "what was deleted in this channel" avoid a full partition scan.
CREATE INDEX IF NOT EXISTS messages_deleted_idx
  ON messages (channel_id, deleted_at) WHERE deleted_at IS NOT NULL;

COMMIT;
