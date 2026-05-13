-- chalk -- migration 0014 (phase 09b)
-- Recovery codes.
--
-- Each user has at most ONE active recovery code: a 24-word BIP-39
-- phrase shown to them at registration. Stored as an argon2id hash
-- so a database leak doesn't expose recoverability. Using the code
-- consumes it (sets used_at) AND the application must immediately
-- generate a new code to keep the user out of a "no recovery"
-- state.
--
-- Schema design choice: a single row per user (PRIMARY KEY user_id).
-- When the user regenerates a code, we UPDATE in place (or DELETE +
-- INSERT in the same transaction) rather than keeping history.
-- Keeping history adds no security and tempts the application into
-- accepting an old code.
--
-- See docs/phase-09-plan.md DECISION 5.

BEGIN;

CREATE TABLE IF NOT EXISTS recovery_codes (
  user_id     UUID         PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hash        BYTEA        NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  used_at     TIMESTAMPTZ                                -- non-null once consumed
);

-- Index to find "users without an active recovery code" -- the
-- application warns them on welcome if used_at IS NOT NULL.
CREATE INDEX IF NOT EXISTS recovery_codes_used_idx
  ON recovery_codes(used_at)
  WHERE used_at IS NOT NULL;

COMMIT;
