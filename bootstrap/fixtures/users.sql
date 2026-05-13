-- bootstrap/fixtures/users.sql
-- Three canonical test users with deterministic UUIDs.
-- Idempotent: safe to run repeatedly.
--
-- UUIDs must be exactly 8-4-4-4-12 hex digits (0-9, a-f). The values below
-- encode a recognizable suffix in each user's last segment for readability:
--
--   alice  →  00000000-0000-0000-0000-00000000a11c
--   bob    →  00000000-0000-0000-0000-000000000b0b
--   carol  →  00000000-0000-0000-0000-0000000ca201
--
-- Phase 09b update: every user now has username, display_name, and
-- email columns populated. The email uses the .invalid TLD (RFC 6761
-- reserved) so dev fixtures don't collide with any real email
-- address. email_verified_at is set to now() so the dev login bypass
-- (phase 09b-5) can mint sessions for these users without first
-- routing them through a verification ceremony.

INSERT INTO users (
  id, handle, username, display_name, email, email_verified_at, created_at
)
VALUES
  ('00000000-0000-0000-0000-00000000a11c',
   'alice', 'alice', 'alice',
   'alice@localhost.invalid', now(), now()),
  ('00000000-0000-0000-0000-000000000b0b',
   'bob',   'bob',   'bob',
   'bob@localhost.invalid',   now(), now()),
  ('00000000-0000-0000-0000-0000000ca201',
   'carol', 'carol', 'carol',
   'carol@localhost.invalid', now(), now())
ON CONFLICT (handle) DO UPDATE
  SET id                = EXCLUDED.id,
      username          = EXCLUDED.username,
      display_name      = EXCLUDED.display_name,
      email             = EXCLUDED.email,
      email_verified_at = EXCLUDED.email_verified_at;
