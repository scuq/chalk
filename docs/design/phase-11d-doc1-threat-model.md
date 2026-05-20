# Phase 11d Design Doc #1 — Threat Model & Crypto Primitives

**Status:** Approved for repo (revision 2)
**Author:** Claude, per scuq's design choices
**Date:** 2026-05-26 (Vienna)
**Scope:** chalk phase 11d — multi-device support with full history transfer

This is the first of eight design documents for phase 11d. It establishes
what we are defending against and what cryptographic building blocks the
rest of the design will use. Subsequent docs (wire protocol, serialization,
server schema, etc.) all reference decisions made here.

**Revision 2 changes from initial draft:** the passphrase model was replaced
with chalk's existing 24-word BIP-39 recovery phrase. zxcvbn-style entropy
checks were dropped (BIP-39 already provides 256 bits). Backup encryption
moved to envelope encryption (single backup_master_key, wrapped under
per-credential keys). Passkey-PRF integration deferred to v2 of this phase.
See §3.7 for the resulting decision log (D1–D6).

---

## 1. The problem in one paragraph

A chalk user has multiple devices (phone + laptop is the common case). Each
device runs its own MLS session with its own keystore. When the user logs
in on a brand-new device, that device must be able to read all historical
messages and join all groups the user is already in, without the server
ever seeing the message contents. This document defines exactly what
"without the server ever seeing" means under what attacker assumptions, and
which cryptographic primitives we will use to achieve it.

---

## 2. Threat model

### 2.1 Actors

The system has these parties:

- **User**: a human with login credentials (passkey + 24-word recovery
  phrase) and zero or more active devices.
- **Device**: a browser instance (or future native app) holding an MLS
  client identity, a keystore in IndexedDB, and a session with the
  server.
- **Chalk server (chalkd)**: the Go process holding the Postgres database,
  routing WS frames, storing ciphertext-at-rest, KeyPackages, MLS group
  metadata, and (per phase 11d) encrypted device backup blobs.
- **Other users**: chalk users who are members of channels with our user,
  or any other chalk user not in those channels.
- **Network**: the public internet between devices and the server.

### 2.2 Attackers we defend against

We classify attackers by what they can do, then say which guarantees hold
against each.

**A1. Passive network attacker.**
Can observe TLS traffic between devices and the server but not decrypt it.
This is a baseline assumption; chalk only serves over HTTPS/WSS. Defended
against by TLS — out of scope for phase 11d design beyond "WS traffic is
TLS."

**A2. Active network attacker.**
Can man-in-the-middle TLS connections via compromised CA, BGP hijack, or
similar. Sees and modifies traffic. Cannot bypass certificate pinning if
we add it (we currently don't). For phase 11d, we assume TLS holds; if TLS
is broken, MLS still protects message content via its own key agreement
(which is what MLS is designed for).

**A3. Compromised server (read-only).**
Adversary gains read access to the chalkd Postgres database and any
in-memory state of the server process. Can read every row of every table.
Can read any traffic the server sees in plaintext (e.g. the contents of
incoming WS frames before they're routed).
**This is the central attacker we defend against in phase 11d.**

**A4. Compromised server (active).**
A3 plus the ability to inject or modify messages, drop messages, serve
different responses to different clients (split-brain), mint malicious
KeyPackages on behalf of users, mint malicious device backups.

**A5. Compromised device (one of N).**
One of the user's devices has its keystore stolen — e.g., a stolen laptop
with an unlocked browser session. Attacker has full read access to the
IndexedDB on that device and can use the device normally.

**A6. Compromised device + compromised recovery phrase.**
A5 plus the attacker has the user's recovery words via phishing, shoulder-
surfing, or theft of the user's notebook.

### 2.3 Guarantees we provide

We make these guarantees, mapped to attackers above:

**G1. Confidentiality of message content.**
- Against A1–A3: full. Server never sees plaintext message bodies for
  MLS-flagged channels. Backup blobs are encrypted; server cannot read
  their contents. *This is the central E2E property.*
- Against A4: confidentiality of past messages holds (forward secrecy via
  MLS ratchet). Confidentiality of future messages depends on whether the
  active attacker can substitute KeyPackages for new devices — see Trust-
  on-First-Use discussion in §4.
- Against A5: messages encrypted under the COMPROMISED device's current
  epoch are exposed. Future messages remain confidential IF the compromised
  device is removed from groups via commit (post-compromise security, an
  MLS property we inherit).
- Against A6: full exposure of that user's history. Acceptable — losing
  both device and recovery phrase is "the user fully lost the battle" and
  we make no claim against this.

**G2. Authenticity of message sender.**
- Against A1–A4: full. MLS signatures bind messages to a specific client
  identity. Server cannot forge messages because it does not have client
  signature keys.
- Against A5: messages can be forged FROM the compromised device's identity
  until the device is removed from groups. Other devices' identities remain
  authentic.

**G3. Recovery for the user.**
- Against A5 with one compromised device but other devices still good: user
  can pair the new replacement device from an existing good device. History
  is intact via pairing flow.
- Against "user lost all devices, has recovery phrase": history recoverable
  via recovery-phrase flow.
- Against "user lost all devices AND lost recovery phrase": **explicit
  non-guarantee.** History is unrecoverable. This is the inherent floor of
  strict E2E and is documented for users.

**G4. Multi-device usability.**
- Adding a device must work in two flows: pairing with an existing device
  (preferred, online), or recovery via 24-word phrase (no other device
  available).
- The pairing flow must be resistant to remote attackers (a stranger cannot
  trigger pairing without physical access to one of the user's devices).
- The recovery-phrase flow must not enable server-side brute-force of weak
  phrases. Since chalk-generated phrases have 256 bits of entropy, brute
  force is mathematically infeasible regardless of the KDF, but we still
  use Argon2id for defense-in-depth — see §3.2.

### 2.4 Explicit non-goals

We do NOT promise:

- **Deniability.** MLS messages are signed; we don't try to provide
  cryptographic deniability of message authorship. Wire-level metadata
  (who messaged whom when) is fully visible to the server. This is
  consistent with current chalk.
- **Metadata privacy.** The server knows the social graph (who is in which
  channel, who is friends with whom), message timing, message sizes
  (within MLS padding), and KeyPackage publication times. Phase 11d does
  not address this.
- **Defense against malicious clients within a group.** If alice2's device
  is compromised AND alice2 is in a group with bob2, the attacker on
  alice2's device can leak group messages out-of-band. No protocol prevents
  this; we accept it.
- **Recovery from forgotten phrase + lost devices.** Stated above as G3;
  explicitly not provided.
- **Backwards-readability for users added to a group.** When carol3 is
  added to a channel that alice2 and bob2 have been chatting in, carol3
  sees only future messages. This is an MLS forward-secrecy property we
  inherit. Phase 11d does not change it.

### 2.5 Defense-in-depth assumptions

A few things we assume hold but treat as belt-and-suspenders rather than
primary defenses:

- Browser sandbox prevents JS on one origin from reading IndexedDB from
  another origin.
- CoreCrypto's encryption of the IndexedDB keystore (via the per-device
  32-byte key) survives offline attacks against a stolen laptop whose disk
  is encrypted by the OS, but does NOT survive an attacker with browser-
  runtime access to that device's localStorage (where the device DB key
  is stored — same protection level as passkey credentials).
- Postgres backups, if they exist, must be treated as "compromised server
  data" for threat modeling. Our E2E claims apply to backups too because
  we only ever store encrypted blobs server-side.

---

## 3. Cryptographic primitives

This section names the specific algorithms and parameters we will use. Each
is justified against attackers from §2.

### 3.1 Symmetric encryption: XChaCha20-Poly1305

For encrypting device backup blobs at rest on the server, for wrapping the
backup_master_key under credential-derived keys (envelope encryption — see
§3.7), and for encrypting pairing-transit blobs.

- **AEAD construction**: XChaCha20-Poly1305 (RFC 8439 + 192-bit nonce
  variant).
- **Key size**: 256 bits.
- **Nonce size**: 192 bits (24 bytes). Generated via `crypto.getRandomValues`.
  Nonce-misuse safe at this width — we can generate billions of backups
  without collision risk.
- **Additional data**: bind to context.
  - For backup blob: AAD = `"chalk.backup.v1" || user_id || device_id || version || created_at`.
  - For key-wrap envelope entries: AAD = `"chalk.kw.v1" || envelope_id || credential_kind`.
  - For pairing transit: AAD = `"chalk.pair.v1" || pairing_id`.

**Why XChaCha20-Poly1305 over AES-GCM:**

- WebCrypto only exposes AES-GCM with a 96-bit nonce, which has collision
  risk at high volumes and requires careful nonce management. XChaCha20's
  192-bit nonce is fully safe with random generation.
- XChaCha20 has constant-time software implementations available via
  libsodium-wasm (and is in `@noble/ciphers`, a small audited TS lib).
- Subtly: WebCrypto's AES-GCM is hardware-accelerated on most CPUs;
  XChaCha20 is software-only. For our backup-blob workload (a few KB
  every 30 seconds at most), performance is irrelevant; safety wins.

**Library choice**: `@noble/ciphers` for the JS side. It's a 30 KB
zero-dependency library by the same author as `@noble/curves`, audited,
no runtime allocation surprises, works in WASM-restricted environments.
Go side: `golang.org/x/crypto/chacha20poly1305`, standard-library-adjacent.

### 3.2 Key derivation: Argon2id

Used in two places: deriving an authentication key for the existing
recovery-words login flow (already implemented in `internal/auth/recovery.go`),
and deriving a backup-encryption key for phase 11d. Both derive from the
same recovery phrase, but produce cryptographically independent outputs
via HKDF separation (§3.7).

- **Algorithm**: Argon2id (the recommended hybrid variant; resists both
  GPU and side-channel attacks).
- **Salt**: 16 bytes, per-user, random. The existing recovery-words flow
  uses a salt stored alongside the hash in the `recovery_codes` table. The
  backup flow will use the SAME salt (no need to store a second value).
  Different users have different salts so a server-wide rainbow table is
  infeasible.
- **Output**: 32 bytes (256 bits) per derivation.
- **Parameters**:
  - `memoryCost`: 256 MB (262144 KB)
  - `timeCost`: 4 iterations
  - `parallelism`: 1
  - Expected derivation time on a modern laptop: 1.5–3 seconds.
  - Expected derivation time on a phone: 4–8 seconds.

These parameters land in OWASP's "high security" recommendation tier.

**Note on overlap with existing chalk recovery flow:** the current
`internal/auth/recovery.go` uses its own Argon2id parameters (`argonTime`,
`argonMemory`, `argonThreads`, `argonKeyLen`). Phase 11d must either:

1. Use whatever the existing code uses (consistency, no new code on server)
2. Bump the existing parameters to match the paranoid values above (a
   one-time migration: re-derive on next login and update stored hash)

Decision deferred to doc #4 (server schema). The existing code's parameters
should be inspected first; if they're already at or above the values above,
no change needed.

**Caveat about phone derivation time:** 4–8 seconds on a phone is real
friction at "type your words to restore on new device" time. We will show
a progress indicator. If the friction proves unacceptable in practice, we
can dial `memoryCost` down to 128 MB at the cost of some attack resistance.
Worth measuring on real devices before finalizing.

**Library choice**: `@noble/hashes/argon2` for JS. Pure JS, audited, no
native dependencies. Go side: `golang.org/x/crypto/argon2`.

### 3.3 Recovery phrase entropy: BIP-39 (already in chalk)

Chalk users already have a 24-word BIP-39 recovery phrase generated at
registration (see `internal/auth/recovery.go`). Phase 11d uses this same
phrase as the user's universal credential. No separate "backup passphrase"
exists.

- **Entropy**: 256 bits (24 words × 11 bits, minus 8 bits of checksum).
- **Wordlist**: BIP-39 English (2048 words).
- **Storage**: server stores an Argon2id hash for auth verification; never
  stores the phrase itself. Client receives the phrase once at signup
  (shown on `RecoveryScreen`) and at rotation. Client must NEVER persist
  the raw phrase.

**Strength check**: not needed. BIP-39 with 24 words is at the maximum
entropy tier (256 bits). zxcvbn or similar checks are irrelevant because
the user did not choose the phrase — chalk generated it from
`crypto/rand`. No weak-phrase failure mode exists.

**Rotation**: existing chalk UI allows the user to rotate their recovery
phrase (see `ProfilePanel`). Phase 11d must handle rotation by re-wrapping
the `backup_master_key` under the new derived key while keeping the old
wrap valid for a grace period — see §3.7 and decision D3.

### 3.4 Asymmetric primitives: Curve25519

We already use Ed25519 for MLS signatures (via the chosen ciphersuite
`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`). We will use X25519 for
the pairing flow's ephemeral key exchange.

This means we keep dependencies on the same family:

- Ed25519 signatures: already in via CoreCrypto.
- X25519 ECDH for pairing: from `@noble/curves/ed25519` (which exposes
  x25519).
- HKDF-SHA256 for deriving secrets from ECDH outputs: from
  `@noble/hashes/hkdf`.

No new primitive families introduced.

### 3.5 PAKE for pairing: SPAKE2+ (with fallback)

The pairing flow uses a short numeric code (6 digits — see doc #6 on UX)
to authenticate two devices to each other. A short code over an untrusted
network needs a PAKE; a plain HKDF on a 6-digit code can be brute-forced
(10⁶ guesses is trivial for an attacker with network access).

- **Algorithm**: SPAKE2+ (the augmented PAKE that resists offline attacks
  on the server-stored verifier).
- **Group**: Curve25519 (Ristretto255 encoding for cleaner math).
- **Verifier storage**: NONE on the server. The server only relays one
  round of messages between the two devices; the protocol is symmetric and
  runs end-to-end between the devices through the server. Server cannot
  brute-force the PIN even with captured transit data.

**Library availability concern**: audited SPAKE2+ implementations for
TypeScript are uncommon as of 2026. Two paths:

1. Use a J-PAKE or Magic-Wormhole-style PAKE via `@noble/curves` +
   `@noble/hashes`. Building crypto, with care.
2. Skip the short-PIN PAKE entirely; use QR codes carrying 128+ bits of
   entropy that the new device scans. Brute force becomes infeasible
   without needing PAKE math. The trade-off is UX: typing a 6-digit code
   is friendlier than scanning a QR, especially on devices without a
   camera.

**Decision**: support BOTH a QR code (default) AND a 6-digit code
(fallback with PAKE). QR works on devices with cameras. The PIN+PAKE
path is the second-priority work item and can ship after QR. Doc #6
(pairing flow) will spec this in detail and identify a specific library.

### 3.6 Hash and HMAC: SHA-256

- Wherever we need a hash (Merkle root for chunked backups, HKDF input,
  key fingerprinting), use SHA-256.
- HKDF-SHA256 for key derivation from ECDH outputs and Argon2id outputs
  that need to be split into multiple sub-keys.

No SHA-3 or BLAKE2 — keeping dependency surface minimal.

### 3.7 Envelope encryption design (the central pattern)

The system uses **envelope encryption** to support multiple credentials
for decrypting the same backup. A single random `backup_master_key`
encrypts the actual blob; that key is then separately wrapped under each
credential-derived key the user has configured.

**Master key:**
```
backup_master_key = random 32 bytes
                  (generated once, on first backup ever for this user)
```

**Backup blob:**
```
encrypted_backup = AEAD(
  key   = backup_master_key,
  nonce = random 24 bytes,
  aad   = "chalk.backup.v1" || user_id || device_id || version || created_at,
  body  = plaintext_blob
)
```

**Key derivation from recovery phrase:**
```
master_secret  = Argon2id(recovery_phrase, salt, paranoid_params)  // 32 bytes
auth_key       = HKDF-SHA256(master_secret, info="chalk.auth.recovery.v1")
backup_kw_key  = HKDF-SHA256(master_secret, info="chalk.backup.v1.kw")
```

- `auth_key` is what the existing recovery-login flow already uses
  (modulo any minor adjustment for unified parameters per §3.2).
- `backup_kw_key` is new in phase 11d; it wraps the master key.
- Both keys derive from the same Argon2id output, so a user-side
  recovery-words flow does ONE expensive derivation and gets both keys.
- Knowing either key tells you nothing about the other (HKDF info
  separation).

**Envelope structure stored server-side:**
```json
{
  "envelope_version": 1,
  "wraps": [
    {
      "kind": "recovery_phrase",
      "wrap_id": "<random 16 bytes>",
      "expires_at": null,
      "ciphertext": "<AEAD(backup_kw_key, ..., backup_master_key)>",
      "nonce": "<24 bytes>"
    }
    // Future entries:
    // { "kind": "passkey_prf", ... }   ← v2 of this phase
    // { "kind": "paired_device", ... } ← optional, post-pairing cache
  ]
}
```

When the user rotates their recovery phrase:

1. Client derives new `backup_kw_key` from new phrase.
2. Client decrypts existing recovery-phrase wrap with old key (or has it
   cached in memory if rotation happens during a logged-in session).
3. Client adds a new wrap entry under the new key.
4. Client marks the OLD wrap entry with `expires_at = now + 30 days`
   (per D3).
5. Server, on each backup operation, may prune wrap entries past their
   `expires_at`.

This means a backup downloaded 25 days ago, using the now-rotated old
words, is still decryptable for another 5 days. After day 30, only the
new-words wrap exists; old backups become unreadable.

**Why this matters:** multi-credential decryption WITHOUT re-encrypting
the whole backup blob on every credential change. The 30-day grace handles
the case where a user rotates their phrase, then immediately afterward
gets a new device and tries to restore from a backup that's a day or two
old.

### 3.8 Decisions log

The following decisions are locked for phase 11d as of this document.
Each downstream doc will reference them by ID.

| ID | Decision |
|----|----------|
| **D1** | Backup key derivation: envelope encryption (option δ in design discussion). v1 ships with only the `recovery_phrase` wrap. v2 (separate later phase) adds `passkey_prf` as a second wrap. No new user-remembered passphrase. |
| **D2** | After user types recovery words once during a session, derive `backup_master_key`, encrypt it under a key derived from the device's localStorage MLS-DB-key + a per-session salt, and persist the encrypted master_key in localStorage. Subsequent sessions on the same device retrieve it silently. Threat surface: same as existing IndexedDB (JS attacker on the device can already read IndexedDB; this is no worse). |
| **D3** | Recovery-phrase rotation: re-wrap `backup_master_key` under the new derived key, keep old wrap with `expires_at = now + 30 days`. Server may prune expired wraps. |
| **D4** | Tier 2 (full history cache) default-on for all users. No explicit user opt-in. A settings toggle exists to disable, but default is on. |
| **D5** | Backup snapshot frequency: event-driven (group joined, group changed, message sent) with debounce of approximately 30 seconds. |
| **D6** | Per-device backup with smart-restore. Server keeps up to N=5 latest backups per user. New device on restore picks the freshest backup per-group from across the user's backups. |

---

## 4. Trust-on-First-Use considerations

This is the design hole where strict-E2E with multi-device gets hard, and
it deserves explicit attention.

### 4.1 The KeyPackage substitution problem

When alice2 starts a DM with bob2, her device fetches bob2's KeyPackages
from the server. The server hands her a KP. Alice2's device trusts that KP
belongs to bob2's device. **The server could lie** — against an A4 (active
server attacker), the server could substitute a KP whose private key the
server knows. Alice2's welcome would encrypt to that malicious KP, and the
server could decrypt it.

Standard MLS deployments solve this via the "Authentication Service" (AS)
abstraction: an identity-provider component that signs each device's
KeyPackages with the user's identity key, so peers can verify "this KP
really belongs to bob2-on-his-laptop." MLS doesn't define how the AS
works; deployments build their own.

**Chalk's current state**: we don't have an AS. KPs are bare; trust is on
the server. Against an A3 (passive) attacker this is fine. Against an A4
(active) attacker, server-substituted KPs would compromise new
conversations. This was true in phase 11b-2 too; we didn't talk about it
then because alice2/bob2 was the only test scenario.

**Phase 11d implications**: with multi-device, KeyPackages multiply (each
device publishes its own). An A4 attacker has more KPs to attempt
substitution attacks on.

**Options**:

1. **Punt**: accept A4 as out-of-scope (only A3 is in scope). Note this
   clearly in user-facing security docs. This is what most small chat apps
   actually do.
2. **Add a minimal AS**: each user generates a long-lived identity keypair
   at signup, the public key is stored server-side, and the user signs
   their own device KPs with it. Other users fetch the identity key once
   (TOFU) and verify all subsequent KPs. Pinning + cross-signature; gives
   real A4 protection for users whose identity key they've seen.

**Recommendation**: defer this decision to phase 11g or later — it's
orthogonal to history transfer. Phase 11d should preserve the option to
add an AS later without breaking the on-disk format. Specifically: include
space in the backup blob and the wire protocol for a future "user identity
key" field, even if it's null/unused in v1.

### 4.2 New-device identity verification

When the new device pairs with alice2-phone, how does alice2-phone know
that the device asking to pair is actually alice2's new device and not an
attacker?

The PAKE pin gives some assurance — only a device that has the pin shared
via an out-of-band channel (in-person screen viewing or a trusted side
channel) can complete the protocol. So physical control of one of alice2's
devices for the duration of the pin is required.

What stops alice2's attacker, who has phished her chalk login but not her
phone, from initiating pairing? The pin display happens on alice2-phone;
the attacker must obtain it. Phishing the login doesn't get them the pin.
Acceptable.

What stops an attacker who has compromised alice2-phone (A5) from silently
pairing additional attacker-controlled devices to the user's account?
Nothing — by definition. Once a device is compromised, the attacker can
pair as many devices as they want. Mitigation in higher layers: phase 11h
or later could add an audit log of "devices added to your account" visible
to all the user's devices, with an "expel device" UI. Out of scope for
11d.

### 4.3 Group-member identity

This is the same problem at a different layer. When alice2 in a group
sends a message, all member devices see "from alice2-phone" on the message.
They trust the signature on the MLS frame, which is anchored to
alice2-phone's signature keypair. They have no protocol-level way to
verify that this signature key was generated by alice2 and not by an
attacker who claimed to be alice2.

Same mitigation path: an AS in phase 11g+. Out of scope for 11d.

---

## 5. What goes in the backup blob

We need to know, at the primitive level, what data the backup encryption
protects. The full format is doc #3; here we enumerate at a high level so
the threat model is concrete. Backups are split into two tiers per D4.

### 5.1 Tier 1 — Identity backup (always uploaded)

Small, ~500–2000 bytes. Sufficient for the new device to establish
identity continuity and join groups via fresh welcomes, but does NOT
restore history.

- **Schema version** (uint32)
- **User ID** (16 bytes) — sanity-check binding
- **Source device ID** (16 bytes) — for smart-restore freshness ordering
- **Backup timestamp** (uint64 unix-ms)
- **MLS client identity**: signature keypair (Ed25519 priv+pub), client_id
  bytes
- **Group manifest**: list of `{group_id, channel_id, last_known_epoch}`
  for every group the user is in. No ratchet state, just membership.
- **Reserved space** for future `user_identity_key` field (§4.1; null in
  v1)

Restore behavior with tier 1 alone: new device adopts the signature key,
publishes fresh KeyPackages signed under it, announces itself to the
server. Other devices then add it to all groups via commits. New device
joins groups at their current epoch. Past messages remain unreadable.

### 5.2 Tier 2 — History cache (default-on per D4, opportunistic upload)

Larger, potentially MBs. Contains the per-group MLS state needed to
decrypt historical messages.

- All fields from Tier 1
- **Per-group state**, one entry per group:
  - Group ID
  - Current epoch
  - Ratchet tree state
  - Past epoch secrets (for historical decryption)
  - Member list snapshot
  - Pending proposals (if any)
- **All KeyPackage private materials** (HPKE private keys corresponding to
  KPs published but not yet claimed)

Restore behavior with tier 2: new device imports per-group state, can
immediately decrypt historical messages from the server's ciphertext
storage.

**Tier 2 size note:** for a user in 50 groups, tier 2 might run to 1–5 MB
depending on how many past epochs are retained. Tier 1 stays small.

### 5.3 Encryption

Both tiers encrypted under the same `backup_master_key` (envelope per
§3.7), but uploaded as separate server-side blobs so a successful tier 1
write isn't blocked by a tier 2 failure (per D5 event-driven debouncing,
tier 1 ships first when state changes).

Server schema (doc #4) will have separate columns or rows for each tier.

### 5.4 Re-encryption note

The keystore on disk is already encrypted under the per-device DB key (32
bytes in localStorage). We **decrypt** these stores when building the
backup blob, then **re-encrypt** under the backup_master_key.

We do NOT just copy the encrypted IndexedDB bytes wholesale. Reasons:

- Old device's DB key is device-local and we don't want to ship it with
  the backup (that would leak the per-device encryption key to the
  server-side blob, which the recovery-phrase-holder can decrypt;
  acceptable but messy)
- New device will use its OWN fresh DB key, so the on-disk format has to
  be re-keyed anyway
- Versioning is cleaner — we own the format

Trade-off: the moment of backup-blob construction has plaintext keystore
material in JS memory. This is unavoidable; the alternative would be a
different on-disk encryption scheme entirely.

---

## 6. Open questions for resolution before doc #2

These remain open. Each affects later docs.

**Q1.** Tier 2 plaintext caching depth.
Tier 2 contains MLS state sufficient to decrypt historical ciphertext from
the server. Should we ALSO cache a snapshot of recently-decrypted
plaintexts for fast UI on restore (e.g. last 30 days), at the cost of
bytes? Or always lazy-decrypt from server ciphertext on restore?

- Option (a) Cache last 30 days of plaintexts in tier 2.
- Option (b) Cache only metadata (sender, timestamp, content_type), not
  body.
- Option (c) No plaintext caching; rely on ciphertext + restored MLS state
  on the new device.

**Q2.** Server-side backup retention exact count.
D6 sets N=5. Worth confirming: 5 backups per user × ~2 MB average × 1000
users = ~10 GB. Acceptable on chalk's current Postgres? If not, lower N.

**Q3.** Backup blob size ceiling.
At what size does a single backup blob become operationally problematic?
WS frame limits (if delivered via WS) likely cap around 16 MB. HTTP
endpoints (if used) have no such limit but should still have a sanity cap.

- Tier 1: ~5 KB ceiling per blob — easy.
- Tier 2: ~10 MB ceiling? 50 MB? Affects chunking logic in doc #3.

**Q4.** Pairing-flow channel: WS or HTTP?
Pairing-transit blobs are small (a few KB), short-lived (~5 minutes), and
need server-side ephemeral storage.

- Option (a) Reuse the WS frame infrastructure (TypePairingOffer,
  TypePairingResponse).
- Option (b) New HTTP endpoints (POST /api/pair/offer, POST /api/pair/respond).

WS is more natural for chalk's existing patterns. Lean toward (a).

**Q5.** Identity Service deferral.
Confirm phase 11d does NOT add an AS, but the on-disk format and wire
protocol reserve space for a future "user identity key" field. Defer A4
protection to phase 11g.

---

## 7. Summary for tomorrow's read-through

When scuq reads this fresh, the key points to push back on are:

1. **Is the attacker A3-only stance correct?** (i.e., we're protecting
   against passive server reads, deferring active server malice.) Most
   chat apps make this stance explicit. Worth a moment.
2. **Argon2id parameters at 256 MB / 4 iters might be too aggressive** for
   low-end mobile. Worth checking against expected device profile. If
   chalk targets desktop browsers primarily, this is fine. If we expect
   old mobile devices, may want to dial down. Recommend measuring before
   finalizing.
3. **PAKE library availability is uncertain.** Best plan today is "QR
   with 128-bit secret as default, 6-digit PIN with PAKE as second-priority
   work."
4. **The five open questions in §6 need answers before doc #2.** (Note: Q5
   probably already implicitly approved — phase 11d was scoped without an
   AS. Worth a one-liner confirmation.)

Once these are signed off, doc #2 is **Wire Protocol Spec** — every new
WS frame type, every new HTTP endpoint, with field-by-field definitions.

End of doc #1, revision 2. Vienna 2026-05-26.
