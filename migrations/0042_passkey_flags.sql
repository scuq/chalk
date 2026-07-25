-- chalk -- migration 0042 (webauthn BE-flag fix)
-- go-webauthn v0.17 compares the STORED credential's BackupEligible bit
-- against the BE bit in every incoming assertion and hard-fails on mismatch
-- ("Backup Eligible flag inconsistency"). chalk never stored the flags, so
-- the reconstructed credential always claimed BE=0 and any synced passkey
-- (iCloud Keychain, Google Password Manager, 1Password, Windows Hello with
-- sync) failed login. This column carries the raw AuthenticatorFlags octet
-- so the credential can be restored faithfully.
--
-- NULL is load-bearing: it distinguishes "row predates this migration, the
-- flags were never recorded" from "recorded, BE=0". A NULL row adopts the
-- asserted flags on its next successful login (trust-on-first-use, once per
-- credential); from then on the BE-change check applies in full.
--
-- Additive: one nullable column, no backfill (the true BE bit of an existing
-- row is not recoverable from anything we stored).

BEGIN;

ALTER TABLE passkeys
  ADD COLUMN IF NOT EXISTS flags SMALLINT;

COMMENT ON COLUMN passkeys.flags IS
  'raw WebAuthn AuthenticatorFlags octet (UP/UV/BE/BS/AT/ED). NULL = pre-0042 row; adopted from the assertion on next login.';

COMMIT;
