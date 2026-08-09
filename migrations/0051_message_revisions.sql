-- chalk -- migration 0051 (83-3: append-only message revisions)
--
-- Phase 83 reverses 0044's overwrite-in-place decision, deliberately. 0044's
-- rationale ("the point is typo correction, not an audit trail") predates the
-- signed sealed envelope: once every message body is an Ed25519-signed
-- envelope (83-1/83-2), an in-place overwrite DESTROYS signed evidence -- the
-- displaced ciphertext is the only thing that can ever prove what the author
-- originally signed, and the revision chain (each edit envelope's
-- prev_rev_hash naming its predecessor's object hash) is only verifiable if
-- the predecessors still exist. Decision recorded 2026-08-07, folded into
-- PHASE-83-MSGSIG.md.
--
-- WHAT THIS STORES: the DISPLACED ciphertext of each edit, moved here in the
-- same transaction that overwrites messages.body (store.EditMessage). rev_seq
-- counts from 1 in displacement order: rev_seq 1 is the ORIGINAL body (what
-- the first edit displaced), rev_seq N is what the Nth edit displaced. The
-- current body lives on messages as before, so history fetches and the
-- message feed are untouched.
--
-- WHAT 0044 WORRIED ABOUT, answered:
--   * "retained revisions preserve exactly the text the author meant to
--     retract" -- true, and now the point: the retraction itself is what the
--     signature chain makes verifiable. The 15-minute edit window bounds how
--     much can ever accumulate, and MAX_MESSAGE_REVISIONS (64, enforced in
--     store.EditMessage -- the 65th edit is refused) bounds it hard.
--   * "a revision table would have to be scrubbed by DeleteMessage" -- it is:
--     the tombstone transaction deletes this message's revisions alongside
--     the body scrub and the reaction scrub (both or neither), so "the
--     ciphertext is gone from the server" stays true. The composite FK's
--     ON DELETE CASCADE covers real SQL DELETEs (partition maintenance);
--     the tombstone path deletes explicitly because it is an UPDATE.
--
-- key_version is nullable for the same reason messages.key_version is: a
-- pre-encryption legacy row that gets edited displaces a plaintext body.
--
-- The composite FK (message_ts, message_id) -> messages(ts, id) follows
-- 0045's pattern -- messages is ts-partitioned, so an FK into it must
-- reference the full primary key, and every revision row carries its
-- message's full-precision ts.
--
-- No chalk_guest grants: guests cannot edit and are not offered revision
-- fetches; absence of a grant is the fence (0050's model).

BEGIN;

CREATE TABLE IF NOT EXISTS message_revisions (
  message_id   UUID        NOT NULL,
  message_ts   TIMESTAMPTZ NOT NULL,
  rev_seq      INTEGER     NOT NULL,
  -- Denormalized like message_reactions.channel_id: fetch authz is "member
  -- of this channel", and answering it must not join the partitioned table.
  channel_id   UUID        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  -- The displaced ciphertext, byte-identical to what messages.body held.
  body         BYTEA       NOT NULL,
  key_version  INTEGER,
  displaced_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (message_id, message_ts, rev_seq)
);

ALTER TABLE message_revisions
  DROP CONSTRAINT IF EXISTS message_revisions_message_fk;
ALTER TABLE message_revisions
  ADD  CONSTRAINT message_revisions_message_fk
  FOREIGN KEY (message_ts, message_id) REFERENCES messages (ts, id) ON DELETE CASCADE;

COMMENT ON TABLE message_revisions IS
  'displaced ciphertexts of edited messages, append-only; the signed revision chain''s evidence (83-3)';

COMMIT;
