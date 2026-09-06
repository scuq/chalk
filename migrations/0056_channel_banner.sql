-- chalk -- migration 0056 (111-1: the channel banner)
--
-- banner_attachment_id points at an ordinary attachments row: an image
-- uploaded through the existing chunked pipeline, encrypted client-side under
-- the channel's key version, and never linked to a message. The server holds
-- an opaque blob and this uuid; it cannot read either.
--
-- NOT a foreign key, and it cannot be one: attachments is range-partitioned on
-- created_at, so its primary key is (created_at, id) and there is no unique
-- index on id alone to reference. Readers resolve the id through
-- attachments_id_idx and treat a missing row as "no banner" -- the same
-- fail-closed shape the client already uses for an attachment it cannot fetch.
--
-- NULL means no banner, which is what every pre-111 channel has.

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS banner_attachment_id uuid;
