# Crypto agility in chalk

Status: active design. Implemented for the wrap + message layers in phase 23
(`web/src/crypto/spacekey.ts`); the identity layer is a documented future
step (see "The third layer" below).

## Why

chalk's cryptography will need to change over its lifetime. The most likely
driver is a **post-quantum (PQ) migration**, but the same machinery covers
any algorithm replacement. The hard requirement is that we can adopt new
algorithms **without losing the ability to read existing history** — a
re-encrypt/re-wrap recipe must always be possible. This document fixes the
design that makes that true, and it is cheapest to bake in *before* any
encrypted data exists (which is the state at phase 23).

## The key insight: not everything is equally at risk

- **Symmetric (AES-256-GCM) is already PQ-durable.** Grover's algorithm only
  halves the effective key strength, leaving AES-256 at ~128-bit PQ
  security. Messages encrypted under a space key do **not** need
  re-encrypting for PQ.
- **The asymmetric wrap is the vulnerable part.** Each space key is wrapped
  to a member via X25519 ECDH, which Shor's algorithm breaks. This is also
  the "harvest now, decrypt later" target: a recorded wrap can be opened by a
  future quantum computer, exposing the space key and thus the messages.

Therefore the primary agility need is the **wrap**, and the cheap PQ
migration is to **re-wrap space keys** under a PQ KEM — not to re-encrypt
messages.

(Honesty note, consistent with chalk's forward-secrecy non-goal: re-wrapping
protects *future* distribution of the key. Wraps already harvested by an
adversary remain vulnerable; re-wrapping cannot un-harvest them. PQ migration
is therefore best done before a cryptographically-relevant quantum computer
exists.)

## The mechanism: self-describing artifacts + a suite registry

Three properties together guarantee lossless migration.

1. **Every artifact is self-describing** — it carries the id of the suite
   that produced it.
   - Message body: `msgSuite(1 byte) || nonce || ciphertext || tag`.
   - Wrapped key: a `wrap_suite` id (stored in `channel_keys.wrap_suite`)
     beside an opaque, suite-defined `wrap_blob`. The blob is opaque
     precisely so a future KEM with a different shape (e.g. ML-KEM
     ciphertext is ~1 KB vs X25519's 32 bytes) fits without a schema change.

2. **Wrap and message suites are independent integers.** A PQ migration
   bumps only the wrap suite; the message suite (AES-256-GCM) stays. Old
   messages keep decrypting under the same space key.

3. **A suite registry dispatches by id and never drops an old suite.**
   `spacekey.ts` is a thin registry: `encrypt`/`wrap` produce under the
   *current* suite; `decrypt`/`unwrap` `switch` on the artifact's suite id.
   Retired suites stay in the `switch` forever, so old data is always
   decodable. New data uses the newest suite; mixed suites coexist.

Adding a suite later = add a constant, a `case`, and a `v_` implementation.
No format change, no migration of existing data required to *read* it.

## Suite 1 (today)

- `WRAP_SUITE_X25519_AESGCM = 1`: ephemeral-static sealed box —
  X25519 ECDH → HKDF-SHA256 → AES-256-GCM. Blob =
  `ephemeralPub(32) || nonce(12) || wrapped(48)`.
- `MSG_SUITE_AESGCM = 1`: AES-256-GCM.

AADs bind the suite + slot so nothing can be relocated/reinterpreted by the
(untrusted) server:
- message: `chalk-msg-s{suite}:{channelID}:{keyVersion}`
- wrap: `chalk-wrap-s{suite}:{channelID}:{keyVersion}:{recipientID}`

## The two migration recipes

**Re-wrap (cheap — the PQ path).** For each channel: a member who holds the
space key re-wraps it under the new wrap suite for every member, writes the
new `channel_keys` rows, and the old (e.g. X25519) wrap rows are dropped.
Messages are untouched and keep decrypting under the same, unchanged space
key. This is the expected PQ migration.

**Re-encrypt (full — rarely needed).** Only if the *message* AEAD itself must
change. For each message: decrypt under its tagged (old) message suite,
re-encrypt under the new one (new `key_version`), rewrite the body. Possible
and deterministic because every message is self-describing; expensive
because it rewrites all ciphertext. Old and new messages coexist throughout.

Neither recipe can lose history: a suite is only ever *added* to the
registry, never removed, so any artifact ever written stays decodable.

## The third layer: identity (future)

Full PQ also needs PQ **identity** keys (today: X25519 + Ed25519, derived
from the BIP-39 phrase). These are derivable from the same phrase via HKDF
with new info labels, so the phrase does not change. When PQ identity lands:
- introduce an identity suite id (the `identity_keys` table already carries
  `generation`; a `suite` tag would join it),
- derive the PQ identity alongside the classical one (likely a hybrid),
- then the wrap re-wrap above targets the PQ identity public key.

This is deferred (it is a larger change than the wrap/message layers and is
not required until PQ identity is actually adopted), but the wrap layer is
already suite-agile, so the identity migration plugs into it.

## Invariants to preserve

- Never remove a suite from the registry. Retire by ceasing to *produce*
  under it (don't make it `CURRENT_*`), not by deleting its `case`.
- Keep `wrap_blob` opaque and suite-defined; do not re-introduce
  fixed per-curve columns.
- Keep wrap and message suites independent.
- Every new artifact must be self-describing — a suite id on the message
  body and a `wrap_suite` on the key row.
