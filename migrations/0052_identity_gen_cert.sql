-- chalk -- migration 0052 (83-4: identity generations as a signed chain)
--
-- 0031 gave identity_keys a generation column and a retired_at stamp so a
-- rotated-out identity stays resolvable, and stated the model: at most one
-- active row per user, rotation retires the current generation as it inserts
-- the next. Nothing ever rotated, so nothing ever linked generations to each
-- other -- and under the phase-83 trust model (the host may WRITE the
-- database) an unlinked "retired generation of Alice" row is exactly what a
-- database write could fabricate to sign history as Alice (R16-1).
--
-- gen_cert closes that: for generation N >= 2 it holds the 64-byte Ed25519
-- signature by generation N-1's key over the chalk-idgen.v1 canonical that
-- names this user, this generation number, this key material and the
-- previous generation's hash (web/src/crypto/idgen.ts). Clients walk the
-- chain from generation 1 (whose hash is computed from its own bytes, never
-- from this table) to the key they have pinned; a row the chain does not
-- reach proves nothing, however it got here. The server stores and relays
-- the cert and never verifies it -- it is the party the cert defends
-- against.
--
-- NULL is legal exactly for generation 1 (a root has no predecessor) and for
-- a generation that starts a NEW chain after key loss -- which clients
-- render as the identity-changed wall. store.RotateIdentityKey is the only
-- writer of generations >= 2 and requires the cert; the DB only enforces the
-- length.

BEGIN;

ALTER TABLE identity_keys
  ADD COLUMN IF NOT EXISTS gen_cert BYTEA;

ALTER TABLE identity_keys
  DROP CONSTRAINT IF EXISTS identity_keys_gen_cert_len;
ALTER TABLE identity_keys
  ADD CONSTRAINT identity_keys_gen_cert_len
  CHECK (gen_cert IS NULL OR octet_length(gen_cert) = 64);

COMMENT ON COLUMN identity_keys.gen_cert IS
  'chalk-idgen.v1 cert: Ed25519 by generation N-1 over the canonical admitting generation N; NULL for a chain root (83-4)';

COMMIT;
