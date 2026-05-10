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

INSERT INTO users (id, handle, created_at)
VALUES
  ('00000000-0000-0000-0000-00000000a11c', 'alice', now()),
  ('00000000-0000-0000-0000-000000000b0b', 'bob',   now()),
  ('00000000-0000-0000-0000-0000000ca201', 'carol', now())
ON CONFLICT (handle) DO UPDATE
  SET id = EXCLUDED.id;
