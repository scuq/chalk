-- chalk -- migration 0013 (phase 09b)
-- Session tokens.
--
-- An opaque random token issued by the server at successful
-- registration or authentication. Stored as BYTEA in the table and
-- delivered to the browser via a Set-Cookie header with the HttpOnly,
-- Secure, SameSite=Strict attributes. The SPA never reads the raw
-- token; identity is discovered via /api/auth/me which the cookie
-- authorizes.
--
-- TTL is 30 days sliding: last_used_at is bumped on every successful
-- request that authorizes against this session (including each WS
-- hello), and a session is considered valid when expires_at > now().
-- A janitor goroutine sweeps expires_at < now() rows hourly. The
-- sliding-window behavior is enforced by the application code, not by
-- the schema -- the schema just stores when each session was last
-- touched and when it expires.
--
-- Multiple sessions per user are normal (phone + laptop + multiple
-- tabs). Users can see and revoke individual sessions via the
-- settings panel (phase 09c). Admin block / soft delete / purge all
-- cascade via the ON DELETE CASCADE on user_id.
--
-- See docs/phase-09-plan.md DECISION 4.

BEGIN;

CREATE TABLE IF NOT EXISTS sessions (
  token         BYTEA        PRIMARY KEY,           -- 32 random bytes
  user_id       UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ  NOT NULL,
  user_agent    TEXT,                                -- caller-supplied at create
  ip_address    INET                                 -- caller-supplied at create
);

CREATE INDEX IF NOT EXISTS sessions_user_idx    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

COMMIT;
