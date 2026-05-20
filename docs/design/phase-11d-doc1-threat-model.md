# Phase 11d Design Doc #1 — Threat Model & Crypto Primitives

**Status:** Revision 3 (history-client architecture, sandbox-validated)
**Author:** Claude, per scuq's design choices
**Date:** 2026-05-27 (Vienna)
**Scope:** chalk phase 11d — multi-device support + full history transfer
for MLS-encrypted DMs and groups
**Previous revisions:** rev 1 (initial), rev 2 (added D7-D9 transparency).
**This revision** drops the custom IndexedDB-export architecture in favor
of CoreCrypto's built-in history-client mechanism. The shift is informed
by source-code reading of `@wireapp/core-crypto` main branch and
sandbox testing against `@wireapp/core-crypto@9.3.4` in Node +
fake-indexeddb. See §11 for the change log.

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

## 3. Architecture overview (revised)

This is the section that changes most relative to prior revisions.
Phase 11d's architecture now centers on **CoreCrypto's built-in
history-client mechanism** rather than a custom keystore-export
pipeline.

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
   (per D7 from rev 2, restated below).
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

### 3.4 Decisions inherited from rev 1 and rev 2

The following decisions from earlier revisions remain in force:

| ID | Decision | Status |
|----|----------|--------|
| D1 | Envelope encryption: `backup_master_key` wraps the secrets, itself wrapped under per-credential keys (recovery_phrase v1, passkey_prf v2) | unchanged |
| D2 | Cache derived `backup_master_key` in localStorage encrypted under device DB key | unchanged |
| D3 | Recovery-phrase rotation: re-wrap, keep old wrap with `expires_at = now + 30d` | unchanged |
| D4 | History sharing default-on (was: tier-2 default-on) | restated |
| D5 | Event-driven snapshot triggers with debounce | restated as "upload secret immediately on observer fire" |
| D6 | Server keeps N=5 latest backups per user | restated as "per-secret retention; see §5" |
| D7 | Transparency: status + critical-event notifications | unchanged |
| D8 | `backup_status_get` family in wire protocol | unchanged |
| D9 | Critical events require explicit user acknowledgment | unchanged |

### 3.5 New decisions for this revision

| ID | Decision |
|----|----------|
| **D7-new** | History sharing enabled by default on every MLS DM/group at creation time |
| **D8-new** | Each captured HistorySecret encrypted under `backup_master_key` and uploaded immediately to chalkd, keyed by `(user_id, conversation_id, era_epoch)` |
| **D9-new** | Restore = download all secrets for user → decrypt → instantiate one history-client CoreCrypto per era |
| **D10-new** | After history-only restore, the new device pairs (PAKE/QR) or self-adds via `device_announce` to become a regular member for ongoing participation; the two flows are independent |

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

**Mitigation**: per D7-new, we enable history sharing at conversation
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

D7-new (default-on history sharing) plus prompt server upload (D8-new)
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

## 8. Forward-compatibility hooks

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

## 9. Open questions and resolved items

### Resolved in rev 2

- **Q1 = c**: No plaintext message caching. ✅ (Carries over.
  Plaintext messages are only ever ephemeral in client memory.)
- **Q2**: Backup retention N=5. ↻ Reinterpreted in this rev: applies
  to envelope versions, not history secrets (which are retained
  indefinitely per §4.3).
- **Q3**: Tier-1/tier-2 size ceilings. ✗ Obsolete with this rev. New
  ceilings: individual secret ≤ 8 KB, envelope ≤ 64 KB.
- **Q4 = a**: Pairing via WS frames, no new HTTP endpoints. ✅
- **Q5**: AS deferred. ✅

### Newly open in this rev

**Q15.** Should the `era_epoch` in the AAD be the MLS epoch at which
the new history client was added (precise but requires per-conversation
epoch tracking), or simply a monotonic counter per
`(user_id, conversation_id)` issued by chalkd?

Recommendation: MLS epoch number. It's already available from
CoreCrypto's epoch observer (orthogonal to history observer) and
gives semantic meaning to ordering. Locking in: era_epoch = MLS
epoch number at history-client-add time.

**Q16.** What happens when the same conversation has TWO new history
clients added in close succession (race during enable + immediate
member removal)? Each fires the observer once, so we upload two
secrets. Is the observer fired in deterministic order?

The Rust source (`crypto/src/mls/conversation/conversation_guard/history_sharing.rs`,
`update_history_client`) shows the observer is fired after the commit
is sent but before the next operation. So two enables in series → two
observer fires, in order. We can assume monotonic in our design.

**Q17.** Should we deduplicate secrets server-side? In theory each
era's secret is unique, but bug-induced re-uploads could happen.

Recommendation: chalkd treats `(user_id, conversation_id, era_epoch)`
as a primary key with UPSERT semantics. Last-uploaded-wins.

---

## 10. Summary

Phase 11d's architecture, post-revision-3:

- **Identity bootstrap**: envelope (under recovery phrase) holds
  `backup_master_key`. Same as rev 1.
- **History transfer**: per-conversation, per-era HistorySecrets
  encrypted under `backup_master_key` and stored at chalkd. NEW.
- **Restore**: download all secrets → decrypt → instantiate
  CoreCrypto.historyClient per era. NEW.
- **Multi-device participation**: independent of history. New devices
  join groups as regular members via PAKE pairing or self-add. Same
  as rev 1.
- **Transparency**: Level 1 + Level 2 + critical events. Same as
  rev 2.

The whole IndexedDB-export design from rev 1 is gone. Tier-1 and
tier-2 distinctions are gone. The Postcard-parsing limitation is
gone. Net design size: smaller, cleaner, sandbox-validated.

---

## 11. Change log

- **rev 1** (2026-05-26): Initial draft. Custom IndexedDB-export with
  tier-1 (identity) and tier-2 (full keystore dump) blobs. Defined
  threat model, primitives, D1-D6.
- **rev 2** (2026-05-27 early): Added D7-D9 for transparency UX
  (status awareness, operation visibility, critical-event
  notifications with cross-device sync).
- **rev 3** (2026-05-27 late, this revision): Replaced custom keystore
  export with CoreCrypto's built-in history-client mechanism after
  discovery via web search + source-code reading + sandbox testing.
  Threat model intact; architecture drastically simplified. Added
  D7-new through D10-new. Q3 obsoleted. New Q15-Q17.

End of doc #1 revision 3. Vienna 2026-05-27.
