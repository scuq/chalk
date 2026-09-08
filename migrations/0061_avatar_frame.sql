-- chalk -- migration 0061 (115-5: the avatar frame)
--
-- One short string per user naming the decorative frame drawn around their
-- profile picture by anyone who has flair on: '' for none, otherwise one of a
-- small set the server allowlists in the handler (internal/auth/
-- avatar_frame_http.go) and the client draws in CSS. It is the wearer's
-- choice and public by design -- a frame is meant to be seen -- so it lives
-- on users beside display_name rather than in the opaque prefs blob, and
-- rides out on the user directory the hover cards already fetch.
--
-- Plaintext on purpose. The picture itself is encrypted per channel (0060)
-- because it is content; the frame is a style name and encrypting it would
-- be theatre. Nothing here says anything about a person the directory did
-- not already say.
--
-- Not an enum and not a CHECK against the allowlist: a new frame style is a
-- CSS rule and a line in two lists, and should not also need a migration.
-- The length cap keeps a hand-crafted request from storing a paragraph; the
-- client renders any name it does not know as no frame.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_frame TEXT NOT NULL DEFAULT '';

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_avatar_frame_len;
ALTER TABLE users
  ADD CONSTRAINT users_avatar_frame_len CHECK (char_length(avatar_frame) <= 16);
