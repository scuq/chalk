-- chalk -- migration 0044 (phase 37-1: message edits)
-- edited_at: an in-place edit stamp on messages.
--
-- WHY OVERWRITE, NOT A REVISION TABLE:
--   * The point of the feature is typo correction on the message you just
--     sent, not an audit trail. Retaining every prior ciphertext would
--     preserve exactly the text the author meant to retract, indefinitely,
--     and every retained revision would pin its own key_version alive.
--   * A revision table would also have to be scrubbed by DeleteMessage, so
--     the tombstone's "the ciphertext is gone from the server" property
--     would silently become false. Overwriting keeps that property true.
--
-- The edit is a scrub-and-replace in the same shape as the 0035 tombstone:
-- body and key_version are overwritten, edited_at is stamped. seq is NEVER
-- reallocated -- it is the per-channel ordering every client agrees on, so
-- an edit must not move a message in history. ts is likewise untouched
-- (it is the partition key; changing it would move the row between
-- partitions).
--
-- NO INDEX: nothing queries "which messages were edited". The column is
-- read only as part of a row already being fetched by id or by the
-- (channel_id, seq) feed scan.
--
-- SCOPE OF THE PERMISSION, stated plainly so the column isn't read as a
-- stronger guarantee than it is: the server allows an edit when the caller
-- is the message's sender, the row is not tombstoned, and the message is
-- less than 15 minutes old (const editWindow in the WS handler). The UI
-- additionally only offers editing on your MOST RECENT message -- that part
-- is a client-side affordance, not a server rule. A crafted client can edit
-- any of its own messages inside the window. That is deliberate: it is the
-- author's own message either way, and the age window is the boundary that
-- actually constrains rewriting history.
--
-- ADD COLUMN IF NOT EXISTS on a partitioned table is metadata-only and
-- propagates to every existing and future partition (same pattern as 0032's
-- key_version and 0035's deleted_at). Default NULL means every existing
-- message is "never edited".

BEGIN;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

COMMIT;
