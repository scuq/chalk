-- chalk -- migration 0060 (112-1: profile pictures)
--
-- One row per (channel, member) pointing at the picture that member shows in
-- that channel. Per channel, because a picture of a face is encrypted like
-- everything else chalk stores: under the channel key, so members can read it
-- and the server cannot. There is no user-level key shared with the people who
-- need to see an avatar, so the same picture is uploaded once per channel and
-- this table records which blob is whose where.
--
-- attachment_id is not a foreign key for the reason banner_attachment_id is
-- not one: attachments is range-partitioned on created_at, so its primary key
-- is (created_at, id) and there is no unique index on id alone to reference. A
-- dangling id resolves to no picture, which is the same fail-closed shape the
-- client already uses for an attachment it cannot fetch.
--
-- The two real foreign keys carry the lifecycle: leave a channel or delete a
-- user and the rows go with it. ON DELETE CASCADE rather than a janitor,
-- because a stale row here would keep pointing at a blob that is still
-- readable by the channel.

CREATE TABLE IF NOT EXISTS channel_avatars (
  channel_id    UUID        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  attachment_id UUID        NOT NULL,
  -- The channel key version the blob was encrypted under. Informational: the
  -- client reads the version off the attachment ref it fetches anyway, and
  -- this is here so an operator can see what a rotation left behind.
  key_version   INTEGER     NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (channel_id, user_id),

  CONSTRAINT channel_avatars_key_version_positive CHECK (key_version >= 1)
);

-- "What are this user's avatars?" -- the fan-out's read when a picture
-- changes, and the cleanup when one is removed. The primary key already
-- covers the per-channel listing.
CREATE INDEX IF NOT EXISTS channel_avatars_user_idx
  ON channel_avatars (user_id);
