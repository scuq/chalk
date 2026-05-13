-- chalk -- migration 0012 (phase 09b)
-- Passkeys (WebAuthn credentials).
--
-- A passkey is a public-key credential bound to a user. One user may
-- have multiple passkeys (e.g. iPhone + laptop + YubiKey). Each is
-- independently revocable. sign_count is used by WebAuthn for clone
-- detection: every successful authentication advances the counter,
-- and a counter that goes backwards is evidence of credential cloning.
--
-- Note: not all authenticators implement sign_count (some platform
-- authenticators that sync via iCloud Keychain return 0). The auth
-- layer must tolerate 0 -> 0 sequences; a strict monotonic check is
-- only meaningful when the authenticator opts in.
--
-- See docs/phase-09-plan.md DECISION 6.

BEGIN;

CREATE TABLE IF NOT EXISTS passkeys (
  credential_id    BYTEA        PRIMARY KEY,
  user_id          UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key       BYTEA        NOT NULL,                  -- CBOR-encoded COSE key
  sign_count       BIGINT       NOT NULL DEFAULT 0,
  transports       TEXT[]       NOT NULL DEFAULT '{}',
  name             TEXT,                                    -- user-chosen, "my iPhone"
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_used_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS passkeys_user_idx ON passkeys(user_id);

COMMIT;
