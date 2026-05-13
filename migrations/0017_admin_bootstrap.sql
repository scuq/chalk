-- chalk -- migration 0017 (phase 09b)
-- Admin bootstrap tokens.
--
-- On first startup (no admin row exists), chalkd creates the admin
-- user from CHALK_ADMIN_* env vars but the user has no passkey yet.
-- chalkd generates a single-use token, persists it here, and prints
-- a bootstrap URL to stderr. The admin visits the URL to complete
-- WebAuthn registration. The token can be reissued via the CLI
-- subcommand `chalkd admin-bootstrap-token` if it expires or the
-- admin is locked out.
--
-- Schema invariants:
--   - at most one ACTIVE (unused and unexpired) token at a time
--   - tokens expire 24h after creation
--   - used_at is set when the bootstrap ceremony completes
--
-- The partial unique index uses the constant expression ((1)) so
-- every active token maps to the same key, and inserting a second
-- active token fails. The same idiom we use for users_single_admin_idx
-- in migration 0011.
--
-- Note: this is a separate table from sessions because the lifecycle
-- and security model differ. Bootstrap tokens are very short-lived
-- (24h), single-use, and grant a specific narrow capability (complete
-- admin passkey registration), not a general session.
--
-- See docs/phase-09-plan.md DECISION 8 ("admin bootstrap recovery").

BEGIN;

CREATE TABLE IF NOT EXISTS admin_bootstrap_tokens (
  token       BYTEA        PRIMARY KEY,           -- 32 random bytes
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ  NOT NULL,
  used_at     TIMESTAMPTZ
);

-- At most one active token at a time. We use immutable predicates
-- in the partial index condition because PG requires the WHERE clause
-- to be immutable. We can't use `expires_at > now()` here (now() is
-- volatile), so the application is responsible for treating an
-- expired-but-unused token as "no active token." Operationally:
--   - on `chalkd admin-bootstrap-token`, the app first deletes any
--     unused-but-expired rows, then inserts a fresh row; the partial
--     unique index then rejects a second concurrent insert.
CREATE UNIQUE INDEX IF NOT EXISTS admin_bootstrap_tokens_active_idx
  ON admin_bootstrap_tokens((1))
  WHERE used_at IS NULL;

-- Index for the cleanup sweep.
CREATE INDEX IF NOT EXISTS admin_bootstrap_tokens_expires_idx
  ON admin_bootstrap_tokens(expires_at)
  WHERE used_at IS NULL;

COMMIT;
