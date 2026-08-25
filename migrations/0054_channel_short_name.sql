-- chalk -- migration 0054 (106-3: channel short names)
--
-- short_name: an optional abbreviation of channels.name, at most ten
-- characters, for rosters that are too narrow for "[Gaming] General" and
-- for users who prefer a terse list (prefs.roster.nameStyle picks which
-- of the two the sidebar shows; the full name is always the fallback).
--
-- Same privacy class as name and group_name: server-side plaintext by
-- design. Empty means "none" -- NULL would only add a third state that
-- every reader has to fold into the same thing. char_length counts
-- characters, not bytes, so a ten-emoji short name is still ten.
--
-- 106-2 (rename) needs no schema: it updates channels.name in place.

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS short_name text NOT NULL DEFAULT '';

ALTER TABLE channels
  DROP CONSTRAINT IF EXISTS channels_short_name_len;
ALTER TABLE channels
  ADD CONSTRAINT channels_short_name_len
  CHECK (char_length(short_name) <= 10);
