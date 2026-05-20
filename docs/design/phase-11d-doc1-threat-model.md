# Phase 11d Design Doc #1 — Threat Model & Crypto Primitives

**Status:** Draft for review
**Author:** Claude, per scuq's design choices
**Date:** 2026-05-27 (Vienna)
**Scope:** chalk phase 11d — multi-device support + full history transfer
for MLS-encrypted DMs and groups

This document defines the threat model, cryptographic primitives, and
high-level architecture for phase 11d. It is informed by source-code
reading of `@wireapp/core-crypto` main branch and sandbox testing
against `@wireapp/core-crypto@9.3.4` in Node + fake-indexeddb. The
companion sandbox tests live at `/home/claude/sandbox-history/`
(reproducible with `npm install && node test-*.mjs`).

---

## 1. The problem in one paragraph

A chalk user with multiple devices, or a user who lost all their
devices but retained their 24-word recovery phrase, must be able to
read their existing MLS-encrypted conversations. The chalkd server
holds only opaque MLS ciphertexts and must not be trusted with
plaintext message content. The user's local CoreCrypto keystore holds
the cryptographic material that allows decryption, but that material
lives on the device — so a fresh device starts with nothing.

We need a server-side, end-to-end encrypted backup of the small amount
of material a new device needs to read history, plus a transport for
device-to-device handoff when the user has another live device
available.

---

## 2. Threat model

### 2.1 Trust boundary

chalkd is **honest-but-curious**. We assume the server operator may
log everything they observe but does not actively manipulate
ciphertexts or tamper with returned data. Active tampering is detected
by AEAD authentication checks (see §6.2 of doc #3); honest-but-curious
captures the realistic deployment risk.

The user's device (browser + IndexedDB + localStorage) is trusted to
hold the device-local material at rest, encrypted by the OS / browser
sandbox. The recovery phrase, when typed by the user, is briefly
trusted in memory for derivation.

### 2.2 Attacker categories

We protect against the following attacker classes, ordered by capability:

| ID | Attacker | Threat |
|----|----------|--------|
| **A1** | Passive network observer | Sees ciphertexts in transit; learns no plaintext |
| **A2** | Compromised chalkd operator | Reads all server-stored data; sees ciphertexts, metadata, manifests, but no plaintext |
| **A3** | Honest chalkd, hostile chalkd peer | Server returns wrong-user backup or tampered manifest; detection required |
| **A4** | User's device stolen, no recovery phrase known | Attacker has the device but not the words; recovery phrase rotation must lock them out |
| **A5** | User's recovery phrase stolen, no device | Attacker types words into a new device; existing-device notification + revocation must catch this |
| **A6** | User's device stolen + recovery phrase known | Total compromise; out of scope (user must be aware and act) |

### 2.3 Security guarantees

For attackers A1-A3:
- **G1**: No plaintext message content is ever readable by chalkd.
- **G2**: No backup material is decryptable without the user's recovery
  phrase (or, eventually, their passkey PRF).
- **G3**: Server tampering of backup material is detectable on
  decryption (AEAD authentication).

For A4-A5:
- **G4**: Adding a new device — whether via pairing or via recovery
  phrase — surfaces a critical event to all the user's other devices
  with explicit acknowledgment required (D9). The user has a window
  in which to detect and revoke.

### 2.4 Non-goals

- **Deniability**: chalk does not aim to make MLS conversations
  deniable. MLS signatures bind authors to messages.
- **Metadata privacy from chalkd**: chalkd inherently sees who talks
  to whom, when, and group membership lists. This is a chalk-wide
  property unchanged by phase 11d.
- **Recovery from total loss**: a user who loses all devices AND
  forgets their recovery phrase has no path to recovery. This is a
  design constraint, not a limitation.
- **Forward secrecy of history**: by design, history-sharing erodes
  some forward secrecy. A user who can read past messages today (via
  the history-client mechanism) implicitly held that capability at
  the moment history sharing was enabled. See §4 for nuance.

---

## 3. Architecture overview

Phase 11d's architecture centers on **CoreCrypto's built-in
history-client mechanism**. Chalk acts as the persistence and
transport layer around CoreCrypto's native APIs rather than
implementing keystore export from scratch.

### 3.1 What CoreCrypto provides

CoreCrypto exposes a per-conversation feature called "history
sharing." When enabled on a conversation:

1. A **synthetic, passive group member** (the "history client") is
   added to the MLS group via a commit. Its ClientId is prefixed
   `"history-client-<uuid>"`.
2. The synthetic member's private material is bundled into a
   **HistorySecret** — a struct containing
   `{clientId: ClientId, data: Uint8Array}` where `data` is
   approximately 750 bytes of MessagePack-serialized state.
3. The HistorySecret is delivered by two paths simultaneously:
   - **In-band**: the secret is sent as an encrypted MLS application
     message bundled into the commit that added the history client.
     All existing group members receive and can decrypt this.
   - **Observer callback**: the local CoreCrypto fires
     `historyClientCreated(conversationId, historySecret)` on the
     application's registered HistoryObserver. The application's job
     is to persist this secret somewhere a future device can retrieve.

When a new device is added to the conversation and obtains a stored
HistorySecret (via the application's persistence layer), it calls
`CoreCrypto.historyClient(historySecret)` to instantiate a separate,
read-only CoreCrypto instance that can decrypt past messages from the
era the secret covers.

### 3.2 The era concept

A **history-sharing era** is the span of MLS epochs during which a
single history client is the group's history member. A new era begins
when:

- The conversation creator enables history sharing for the first time
  (era 1 begins at that epoch).
- Approximately once daily, CoreCrypto rotates the history client
  (PCS housekeeping; a new era begins).
- A non-history member is removed from the group. Removing a member
  requires removing the existing history client too (because the
  removed member still knows the history client's keys); a new history
  client and new era are added in the same commit.

Each era has its own HistorySecret. A new device that wants full
history needs **the secret for every era** that has occurred since
history sharing was first enabled.

### 3.3 chalk's job

Chalk's responsibility, given CoreCrypto handles the cryptographic
material, is reduced to:

1. **Enable history sharing on every new conversation by default**
   (per D10 below).
2. **Run a HistoryObserver** that catches every `historyClientCreated`
   event.
3. **Persist each captured HistorySecret server-side**, encrypted
   under the user's `backup_master_key`, keyed by
   `(user_id, conversation_id, era_epoch)`.
4. **On new-device restore**, download all of the user's stored
   HistorySecrets, decrypt them under `backup_master_key`, and call
   `CoreCrypto.historyClient(secret)` for each.
5. **Pair / self-add for ongoing participation** — orthogonal to
   history. A new device joins the group as a regular member via
   either the pairing flow (online handoff from existing device) or
   self-add from another existing device after `device_announce`.

The cryptographic concerns chalk owned in earlier revisions —
keystore serialization, signature keypair extraction, IndexedDB row
filtering, last-write-wins replay — are all obsolete.

### 3.4 Locked decisions

The following decisions are locked. They span backup-key handling,
transparency UX, and history-client orchestration.

| ID | Decision |
|----|----------|
| **D1** | Envelope encryption: `backup_master_key` wraps the secrets, itself wrapped under per-credential keys (recovery_phrase v1, passkey_prf v2) |
| **D2** | Cache derived `backup_master_key` in localStorage encrypted under device DB key |
| **D3** | Recovery-phrase rotation: re-wrap, keep old wrap with `expires_at = now + 30d` |
| **D4** | History sharing on by default |
| **D5** | Upload each captured HistorySecret immediately after the originating commit is acknowledged by the delivery service |
| **D6** | Envelope versions: server retains the current envelope plus the most recent N=5 rotation-superseded versions; HistorySecrets are retained indefinitely (see §4.3) |
| **D7** | Transparency UX: backup status awareness + operation visibility + critical-event notifications |
| **D8** | `backup_status_get` wire frame family for status queries |
| **D9** | Critical events require explicit user acknowledgment; cross-device synchronized so acking on one device dismisses on all |
| **D10** | History sharing enabled by default on every MLS DM/group at conversation creation time |
| **D11** | Each captured HistorySecret encrypted under `backup_master_key` and uploaded to chalkd after the originating commit is acknowledged, keyed by `(user_id, conversation_id, era_epoch)` |
| **D12** | Restore = download all secrets for user → decrypt → instantiate one history-client CoreCrypto per era |
| **D13** | After history-only restore, the new device pairs (PAKE/QR) or self-adds via `device_announce` to become a regular member for ongoing participation; the two flows are independent |

---

## 4. Important limitations imposed by the protocol

These come from CoreCrypto's design, not chalk's. We must be honest
with users about them.

### 4.1 History before enable is unrecoverable

If a conversation has been chatting for any time before history
sharing was enabled, the messages from that time are **not**
decryptable by future history clients. The history client starts
accumulating epoch secrets from its creation epoch forward, not
backward.

**Mitigation**: per D10, we enable history sharing at conversation
creation. New chalk DMs and groups thus get history-from-day-one. For
conversations created BEFORE phase 11d ships, history before the
phase-11d upgrade is permanently lost to new devices.

### 4.2 History sharing requires an active group member to mint secrets

The HistorySecret can only be created by an existing group member —
not by a passive observer, not by chalkd. In the recovery-only case
("user lost all devices, has only recovery phrase"):

- If at least one HistorySecret per conversation had been uploaded to
  chalkd before the loss → the user can restore history.
- If no secret was ever uploaded for a conversation → no history for
  that conversation, even with the recovery phrase. The new device
  joins as a fresh member, sees messages from re-join onward.

D10 (default-on history sharing) plus prompt server upload (D11)
minimize but cannot eliminate this risk.

### 4.3 History clients accumulate over conversation lifetime

For each conversation, the server stores one secret per era. Eras
rotate on member removal and ~daily. A long-running group with active
membership changes may accumulate dozens of secrets.

**Concrete estimate**: a 10-member group active for a year, with
weekly membership changes and daily rotation, would have ~52 + ~365 =
~400 eras. Each secret is ~1.1 KB on the wire. Total ~450 KB per
group on the server side. Acceptable.

**Retention policy**: server retains all secrets indefinitely. Pruning
older secrets would silently break old-history restoration for new
devices. We accept the storage cost. Per-user storage quota can be
imposed if it ever becomes a problem.

### 4.4 History client material is full decryption power for its era

A HistorySecret, in plaintext, allows decryption of every message in
its era. We must protect it as carefully as the user's own keys. The
envelope encryption design (D1) does this — the secret never sits
unencrypted on the server.

### 4.5 Untested-in-JS path

Wire's own JavaScript test suite covers `enableHistorySharing` (the
sender side) but **does not exercise `CoreCrypto.historyClient()`**
(the receiver side). That code path is only covered by Wire's Rust
integration tests. The chalk implementation will thus be among the
first JS consumers of the full end-to-end flow.

Sandbox testing (Vienna 2026-05-27) validated:
- `enableHistorySharing` works in our pinned 9.3.4 + Node +
  fake-indexeddb.
- `CoreCrypto.historyClient(secret)` returns a working CoreCrypto
  instance from a captured secret.
- HistorySecret round-trips correctly through base64 wire format
  using the plain-object `{clientId, data}` shape.

What was **not** tested: end-to-end decryption of past messages via a
history client. That requires full Alice ↔ Bob delivery service
routing in the harness. Wire's Rust tests cover it; chalk's
implementation should add an integration test for this path early.

---

## 5. Cryptographic primitives

### 5.1 Envelope and master key

Each user has one **envelope** stored at chalkd. The envelope is a
JSON object holding the `backup_master_key` wrapped under one or more
per-credential keys.

```
envelope = {
  envelope_version: 1,
  wraps: [
    {
      kind: "recovery_phrase",
      wrap_id: <uuid>,
      ciphertext: AEAD(kw_key, nonce, aad, backup_master_key),
      nonce: <24 bytes>,
      kdf_salt: <16 bytes>,
      kdf_params: { algorithm: "argon2id", memory, time, threads, key_len },
      expires_at: null | <unix-ms>,
    },
    ...
  ],
}
```

- **`backup_master_key`**: 32 random bytes, generated locally on first
  enablement of phase-11d backups.
- **`kw_key`** (the wrap key): derived from the recovery phrase via
  Argon2id with per-wrap salt. The wrap key is ephemeral; only the
  resulting ciphertext is stored.
- **AEAD**: XChaCha20-Poly1305. 24-byte nonces avoid nonce-reuse risk
  even with random generation.
- **Argon2id parameters** (v1): memory = 256 MB, time = 4 iterations,
  threads = 1, key_len = 32. Tuned for ~1s on a modern laptop.

### 5.2 HistorySecret encryption

Each captured HistorySecret is encrypted before upload:

```
secret_plaintext = CBOR({
  client_id: <bytes ~51>,
  data: <bytes ~750>,
})
secret_ciphertext = AEAD(backup_master_key, nonce, aad, secret_plaintext)
where aad = "chalk.history.v1" || user_id || conversation_id || u64_be(era_epoch)
```

The AAD binding ensures a hostile chalkd cannot return one user's
secret to another user, or swap eras within a user. Decryption fails
loudly if AAD mismatches.

### 5.3 Recovery phrase

Already present in chalk (`internal/auth/recovery.go`): 24-word
BIP-39 phrases, 256 bits of entropy. The same phrase is used for both
authentication (existing, Argon2id-hashed for login) and backup
encryption (new in phase 11d, separate KDF context).

KDF separation: `backup_kw_key = Argon2id(phrase || "chalk.backup.v1", salt, ...)`.
The `"chalk.backup.v1"` infix ensures the backup wrap key is
cryptographically unrelated to the auth hash, even though both derive
from the same phrase.

### 5.4 Curve25519, SHA-256

Used in:
- **Curve25519**: PAKE pairing (see doc #6 when written).
- **SHA-256**: AEAD AAD components, fingerprints in critical events.

### 5.5 SPAKE2+ / PAKE

The online device-to-device pairing flow uses a 128-bit out-of-band
secret (delivered via QR code) combined with X25519 ECDH and HKDF.
The 6-digit PIN variant would require a real PAKE (SPAKE2+ candidate)
and is deferred to v2.

Detailed in doc #6 (PAKE pairing flow) when that doc is written.

---

## 6. Trust-on-first-use considerations

When a new device joins via pairing, the existing device verifies the
new device's identity via the PAKE shared-secret proof. When a new
device joins via recovery phrase, there is no existing device
verifying it — the device demonstrates knowledge of the phrase and
that's the trust anchor.

To compensate for A5 (recovery phrase stolen), the new device's
arrival triggers a **critical event** (per D9) to all of the user's
other devices, with explicit acknowledgment required. The event
carries:

- The new device's fingerprint (SHA-256 of its MLS signature public
  key)
- Origin kind: `"recovery"` vs `"paired"`
- Approximate location and user-agent (server-observed)
- A "wasn't me" action that initiates recovery phrase rotation

This is the user's signal that a stolen phrase has been used. A
silent recovery is not possible.

---

## 7. What's stored where

| Item | Where | Encryption at rest |
|------|-------|---------------------|
| `backup_master_key` (cached) | localStorage | Encrypted under device DB key |
| Recovery phrase | Never persisted | User memory only |
| Argon2id `kw_key` | Memory only | Discarded after one use |
| Envelope (wraps) | chalkd, `backup_envelopes` table | Ciphertexts already pre-encrypted |
| HistorySecrets | chalkd, `history_secrets` table | AEAD-encrypted under master_key |
| MLS keystore | Browser IndexedDB (via CoreCrypto) | CoreCrypto's own AES-GCM under device DB key |
| Device DB key | localStorage | Plain-text per current chalk design (browser sandbox) |
| Device pairing state | Server in-memory (no DB) | 5-min TTL |

Note: nothing in this design requires CoreCrypto's IndexedDB to be
exported, walked, or copied. CoreCrypto's keystore is per-device,
local-only, and stays that way. Phase 11d operates entirely above the
CoreCrypto API surface.

---

## 8. Security considerations

This section catalogues concrete attack vectors and the design's
response to each. Items are ordered by severity, descending. Each
identifies the threat, the design's mitigation (if any), and any
residual risk we accept.

### 8.1 HIGH — Nonce reuse on HistorySecret encryption

**Threat**: XChaCha20-Poly1305 requires unique nonces per
(key, plaintext) pair. With random 24-byte nonces, collision
probability is cryptographically negligible — but only if generated
from a CSPRNG. A buggy or backdoored RNG would compromise the
`backup_master_key` catastrophically: an attacker observing two
ciphertexts under the same nonce can recover the keystream and read
both plaintexts.

**Mitigation**: clients MUST use `globalThis.crypto.getRandomValues`
for nonce generation. The implementation must abort with an explicit
error if the WebCrypto API is unavailable rather than fall back to
`Math.random()` or any non-cryptographic source. chalkd MAY validate
nonce uniqueness within a user's stored secrets as a defense-in-depth
check, rejecting any `history_secret_put` whose nonce collides with
any prior nonce for the same user.

**Residual risk**: a compromised browser runtime (malicious extension,
hostile WASM polyfill) could substitute the RNG without our knowing.
Out of scope; we trust the browser.

### 8.2 HIGH — `prepareForTransport` covert channel

**Threat**: CoreCrypto's history-client mechanism delivers the
HistorySecret to existing group members in two ways: via the
`HistoryObserver` (local) AND via an encrypted MLS application
message bundled into the commit (in-band, broadcast to all members).
The in-band delivery means **any current group member can decrypt the
HistorySecret** by decrypting that application message.

The implication: if any current member of a conversation is
compromised, the attacker obtains the HistorySecret for the current
era. They can then instantiate their own `historyClient(secret)` and
read all past messages from that era — a persistent decryption
capability that survives the compromised member being removed from
the group.

This is not strictly worse than the baseline (a current group member
can already read all current messages), but the persistence across
removal is new and undesirable. Removing a compromised member
SHOULD restore confidentiality going forward, but with the in-band
path, it doesn't.

**Mitigation**: chalk's `prepareForTransport` implementation should
return a **dummy value** (e.g. 32 random bytes) rather than the real
`HistorySecret.data`. This neutralizes the in-band path while
preserving CoreCrypto's protocol invariants (the callback must return
SOME bytes; they will still be encrypted and sent, but they're
meaningless on the receiving end).

The legitimate transfer path is exclusively via `history_secret_put`
+ `history_secret_get`, encrypted under `backup_master_key`. Only
the user's own devices (which know master_key) can decrypt — current
group members cannot, even with full session keystore access.

**Documented in doc #3 §4.6.**

**Residual risk**: if CoreCrypto in a future version starts depending
on the in-band path for some functionality, the dummy return value
might cause downstream issues. Sandbox testing on 2026-05-27
confirmed CoreCrypto in 9.3.4 doesn't observably depend on the
in-band content for the sender side. Receiver-side: CoreCrypto's
`decrypt_message` handles the bytes as a generic MLS application
message and doesn't attempt to interpret them as a HistorySecret
(verified by source-code reading of
`crypto/src/mls/conversation/conversation_guard/history_sharing.rs`
where the test pattern shows decrypt + manual handling). Receiver-
side parsing of the dummy bytes is therefore the application's
concern, and chalk simply ignores them.

### 8.3 HIGH — Replay of old HistorySecret ciphertexts

**Threat**: a hostile chalkd could store the user's history_secret_put
uploads, then later serve an OLDER ciphertext for an
`(conversation_id, era_epoch)` than the most-recent valid one. A new
device on restore would decrypt the old ciphertext (it still has a
valid AEAD tag because master_key didn't rotate), instantiate the
older history client, and miss messages from later in the era.

This is a rollback attack on history coverage.

**Mitigation (partial)**: chalkd's UPSERT semantics on the primary
key `(user_id, conversation_id, era_epoch)` mean the legitimate
last-write-wins SHOULD be authoritative. But a malicious chalkd
that ignores the upsert and serves an old row defeats this.

A stronger mitigation: include a `secret_version` integer in the AAD,
incremented on every put for the same `(conversation_id, era_epoch)`,
and have the client track the highest seen version per era. On
restore, reject any secret whose `secret_version` is lower than one
previously seen by this user.

**Decision**: defer the strong mitigation to a future hardening
phase. The threat requires active malicious chalkd behavior, which
puts it outside the honest-but-curious threat model (§2.1). If we
ever upgrade the threat model to "fully malicious server," this
mitigation becomes mandatory.

### 8.4 MEDIUM — Critical event acknowledgment can be forged by chalkd

**Threat**: critical events are acked via `critical_event_ack` WS
frames. If chalkd is compromised, it could synthesize an
`critical_event_dismissed_event` and push it to a client, making the
client remove the event from its UI without the user actually
acknowledging. The user thinks "no critical events to review" while
attacker activity (e.g. an unauthorized device add) goes unnoticed.

**Mitigation (partial)**: clients SHOULD maintain a local mirror of
seen-but-unacked critical events. A `critical_event_dismissed_event`
push should not silently remove an event from the UI unless the
client has a record of the corresponding `critical_event_ack` it
itself sent (or the ack came from another of the user's devices in
the same session).

This is fundamentally a notification-integrity problem and a fully
honest-server threat model can't completely close it. Cryptographic
signing of acks under the user's MLS signature key would close it but
adds significant client-side complexity. Defer to a future hardening
phase.

**Residual risk**: a compromised chalkd can silently dismiss critical
events on all devices that aren't currently online. The user has no
way to know an event was generated.

### 8.5 MEDIUM — QR-embedded 128-bit secret on pairing

**Threat**: phase 11d's online pairing (doc #6 when written) carries
a 128-bit shared secret in a QR code on the existing device's screen.
If the QR is observed by an attacker (camera shoulder-surf, screen
recording, leaked screenshot), the attacker has the full pairing
secret. No second factor.

**Mitigation**: QR-pairing should only be used in a private setting.
This is a user-discipline concern that the UI must reinforce.

A stronger version (deferred to v2): SPAKE2+ with a 6-digit PIN as
the password equivalent. This gives security even if the PIN is
observed (an attacker would need an online interaction with the
session). PIN flow specced in doc #6.

**Residual risk**: documented limitation of v1 pairing flow.

### 8.6 MEDIUM — Master_key never rotates

**Threat**: if `backup_master_key` ever leaks (e.g. via localStorage
compromise where the device DB key was also exposed), every past
and future HistorySecret encryption is broken. The attacker can
decrypt all stored secrets and read all history; they can also
decrypt all future uploads.

**Current design (doc #3 §8)**: master_key never rotates. Recovery
from compromise requires re-encrypting every stored secret under a
new master_key — an expensive O(N) operation where N is the user's
total secret count.

**Mitigation**: document the response playbook for a known compromise:
1. Detect compromise (out of scope here; logging / audit).
2. Generate new master_key on a trusted device.
3. Download all secrets, decrypt under old key, re-encrypt under
   new key, re-upload.
4. Update envelope wrap(s) to wrap the new master_key.
5. Mark all old secret rows (server-side) as superseded by new ones.
6. After all devices have re-synced, hard-delete superseded rows.

This is a manual operations procedure for v1. Phase 11g (or later)
should consider automating it.

**Residual risk**: until rotation is automated, a compromise event
requires significant manual coordination. Users with many
conversations may experience temporary inability to read history
during the rotation.

### 8.7 LOW — `producing_corecrypto_version` leaks to chalkd

**Threat**: each `history_secret_put` carries the producing
CoreCrypto version (per §6.3 of doc #3) for forward-compat diagnosis.
This leaks to chalkd which version a given chalk client is running.
A passive chalkd could scan its stored data for users running
versions with known vulnerabilities and target them.

**Mitigation**: accept the leak as a diagnostic trade-off. The
version is already visible in other ways (user-agent header on the
WS handshake, key-package format details, etc.).

**Residual risk**: minimal. Users running known-vulnerable versions
should upgrade regardless.

### 8.8 LOW — No documented rate limit on `history_secret_put`

**Threat**: a misbehaving or malicious client could flood chalkd with
many history_secret_put uploads to consume storage. The 8 KB per-
secret ceiling caps each upload but not total volume.

**Mitigation**: chalkd implementation should enforce a per-user
rate limit (recommended: ≤ 100 uploads/hour as a baseline; tunable
via config). The limit should be high enough not to interfere with
legitimate group activity (a user in many active groups with frequent
membership changes is the realistic worst case).

**Status**: rate limit will be specified in doc #4 (server schema)
when written.

### 8.9 LOW — `era_epoch` in clear leaks group churn rate

**Threat**: chalkd sees the `era_epoch` of every history_secret_put.
This reveals how often a conversation's history client rotates,
which correlates with member-add/remove frequency and the ~daily
auto-rotation. An attacker can model group churn rates per user.

**Mitigation**: accept the leak. The server already knows membership
changes (it routes MLS commits) and the daily rotation is universal.
No new information leaked.

**Residual risk**: none beyond what chalkd already observes.

### 8.10 LOW — Master_key in process memory during use

**Threat**: while `backup_master_key` is encrypted at rest in
localStorage (under the device DB key) and on chalkd (wrapped under
the recovery-phrase-derived key), it lives in process memory
unencrypted during use. An attacker with memory-dump capability
(browser DevTools access, malware) can extract it.

**Mitigation**: WebCrypto's `subtle` API can hold keys as
non-extractable handles, providing some protection. CoreCrypto does
not use this API for its own key material (constraint we inherit).
For our own master_key handling, we could use SubtleCrypto for the
AEAD operations and avoid exposing master_key as a raw byte buffer.

**Decision for v1**: use raw byte buffers (consistent with the rest
of chalk's crypto code). Revisit in a future hardening phase if
memory-dump attacks become a realistic concern.

**Residual risk**: a fully-privileged attacker on the user's device
has access to everything anyway. This concern is more about defense
in depth than realistic attack prevention.

### 8.11 Summary

| ID | Severity | Threat | Status |
|----|----------|--------|--------|
| 8.1 | HIGH | Nonce reuse via bad RNG | Mitigated (require CSPRNG, abort fallback) |
| 8.2 | HIGH | prepareForTransport covert channel | Mitigated (return dummy bytes) |
| 8.3 | HIGH | Replay of old ciphertexts | Partial (UPSERT); strong mitigation deferred |
| 8.4 | MEDIUM | Ack forgery by chalkd | Partial (client mirror); strong mitigation deferred |
| 8.5 | MEDIUM | QR-secret observation | Accepted limitation; PIN flow deferred to v2 |
| 8.6 | MEDIUM | Master_key never rotates | Manual playbook documented; automation deferred |
| 8.7 | LOW | corecrypto_version leaks | Accepted |
| 8.8 | LOW | No rate limit documented | To be specified in doc #4 |
| 8.9 | LOW | era_epoch leaks churn | Accepted |
| 8.10 | LOW | master_key in memory | Accepted; revisit if memory-dump becomes a concern |

Items 8.3, 8.4, 8.6 should be revisited if the threat model is ever
upgraded from honest-but-curious to fully-malicious server.

---

## 9. Forward-compatibility hooks

Reserved-now-implementable-later fields in v1:

- **Envelope wrap kinds**: v1 supports only `"recovery_phrase"`. v2
  adds `"passkey_prf"`. Later: hardware key, social recovery.
- **`user_identity_key`**: reserved-null field in the envelope; will
  carry the user's chalk-wide identity public key when the
  Authentication Service (AS, planned for phase 11g) lands.
- **Schema versioning**: every persisted artifact carries a
  `version: 1`. Server rejects unknown future versions with a clear
  error to make migration paths explicit.

---

## 10. Design questions

### 10.1 Resolved

- **Q1 = c**: No plaintext message caching. Plaintext messages are
  only ever ephemeral in client memory.
- **Q2**: Envelope-version retention N=5. Applies to envelope rotations,
  not to HistorySecrets (which are retained indefinitely per §4.3).
- **Q3**: Tier-1/tier-2 size ceilings — superseded. Individual
  HistorySecret ciphertext ≤ 8 KB; envelope ≤ 64 KB.
- **Q4 = a**: Pairing and backup both run over WS frames. No new HTTP
  endpoints introduced.
- **Q5**: Authentication Service (AS) deferred to phase 11g.
- **Q17**: Server-side deduplication of HistorySecrets. Resolved:
  chalkd treats `(user_id, conversation_id, era_epoch)` as a primary
  key with UPSERT semantics. Last-uploaded-wins.

### 10.2 Open

**Q15.** What value should `era_epoch` carry in the AAD?

Recommendation: the MLS conversation epoch at which the history client
was added. This gives semantic meaning to ordering and aligns with
the era boundaries in §3.2. The MLS epoch is readable from CoreCrypto
via `conversationEpoch(convId)`.

**Caveat**: at the time the HistoryObserver fires, CoreCrypto is
inside an internal lock dispatched from the conversation guard. We
cannot reliably call back into CoreCrypto (e.g. `conversationEpoch`)
from inside the observer without risk of deadlock or unspecified
behavior. The actual implementation approach is documented in doc #3
§4.2: maintain a separate per-conversation epoch cache populated via
an `EpochObserver`, and look up the cached epoch from the
HistoryObserver synchronously. This is sandbox-untested for ordering
guarantees between the two observer types and needs integration
testing in chalk's implementation.

**Q16.** Is observer firing order deterministic when multiple history
clients rotate in close succession (e.g. enable + immediate
member-remove)?

Working assumption: yes, in order. The Rust source
(`crypto/src/mls/conversation/conversation_guard/history_sharing.rs`,
`update_history_client`) shows the observer fires after the commit is
sent for each history-client rotation. Two operations in series
should produce two observer fires in series.

**Caveat**: this assumption has not been verified across async-task
boundaries or with concurrent operations from multiple browser tabs
sharing the same CoreCrypto database. Integration testing during
chalk implementation must verify monotonic ordering before this
assumption is relied on for production.

---

## 11. Summary

Phase 11d's architecture:

- **Identity bootstrap**: envelope (under recovery phrase) holds
  `backup_master_key`.
- **History transfer**: per-conversation, per-era HistorySecrets
  encrypted under `backup_master_key` and stored at chalkd.
- **Restore**: download all secrets → decrypt → instantiate
  `CoreCrypto.historyClient` per era.
- **Multi-device participation**: independent of history. New devices
  join groups as regular members via PAKE pairing or self-add.
- **Transparency**: backup status awareness + operation visibility +
  critical events with cross-device synchronized acknowledgment.

End of doc #1. Vienna 2026-05-27.
