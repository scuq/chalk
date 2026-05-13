-- chalk -- migration 0015 (phase 09b)
-- Link a device row to the passkey credential that registered it.
--
-- Phase 05's ensureDeviceForTesting upserts a device row tied to alice
-- for any client-supplied device_id. Phase 09b replaces that with
-- session-based device resolution at WS hello: the cookie-authorized
-- user id becomes the device's owner, and the device row tracks the
-- specific passkey credential the user authenticated with for this
-- connection. This lets the SPA show "you logged in with: my iPhone"
-- in the sessions panel and lets admin moderation tie a device to
-- the credential that minted it.
--
-- ON DELETE SET NULL: revoking the passkey leaves the device row
-- intact (so historical messages still resolve sender->device) but
-- nulls the back-reference. The device can re-authenticate with a
-- different passkey on next login and the column updates.

BEGIN;

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS passkey_credential_id BYTEA
    REFERENCES passkeys(credential_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS devices_passkey_idx
  ON devices(passkey_credential_id)
  WHERE passkey_credential_id IS NOT NULL;

COMMIT;
