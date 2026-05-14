-- Phase 09c: invites table.
--
-- Registration is invite-only by default in chalk; CHALK_OPEN_REGISTRATION
-- (used during 09b dev) becomes a per-deploy override. Existing users
-- generate single-use, time-limited tokens for friends/colleagues; the
-- token authorizes the invitee to register with a specific email
-- address.
--
-- Schema design notes:
--   - token PRIMARY KEY: 32 random bytes from CSPRNG, application-
--     generated, base64url-encoded on the wire.
--   - email CITEXT: case-insensitive. An invite for "Alice@Example.com"
--     matches a registration submission of "alice@example.com".
--   - inviter_id ON DELETE CASCADE: if the inviter is hard-deleted,
--     their pending invites go too (their soft-delete leaves invites
--     alone; the inviter row still exists in that case).
--   - used_by ON DELETE SET NULL: if the invitee is later hard-deleted,
--     keep the invite row for audit purposes but null out the
--     reference. Set-null is the right semantics here: the historical
--     fact "this token was used by some now-deleted user" should be
--     preserved.
--   - revoked_at: explicit revocation by the inviter (different from
--     expiry; expiry is time-based, revocation is intentional).
--
-- Indexes:
--   - invites_active_email_idx: partial unique. At any moment, at
--     most ONE invite for a given email may be active (not used, not
--     revoked, not expired). The partial WHERE handles all three
--     "inactive" states so superseded invites don't block re-issue.
--   - invites_inviter_idx: list-my-invites query.
--   - invites_expires_idx: janitor sweep for expired-but-not-cleaned
--     rows (partial, only active ones).
--
-- TTL: per the phase 09 plan, default invite TTL is 4 days. The
-- application sets expires_at on insert; the schema only enforces
-- that it's non-null and the indexes treat now() > expires_at as
-- "inactive".

BEGIN;

CREATE TABLE IF NOT EXISTS invites (
  token        BYTEA       PRIMARY KEY,
  email        CITEXT      NOT NULL,
  inviter_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  used_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
  revoked_at   TIMESTAMPTZ
);

-- One active invite per email at a time.
CREATE UNIQUE INDEX IF NOT EXISTS invites_active_email_idx
  ON invites(email)
  WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS invites_inviter_idx ON invites(inviter_id);

CREATE INDEX IF NOT EXISTS invites_expires_idx ON invites(expires_at)
  WHERE used_at IS NULL AND revoked_at IS NULL;

COMMIT;
