# Phase 11d Design Doc #2 — Wire Protocol Spec

**Status:** Draft for review
**Author:** Claude, per scuq's design choices
**Date:** 2026-05-27 (Vienna)
**Scope:** chalk phase 11d — wire format for envelope, history secrets,
pairing, multi-device, status, and critical events
**Depends on:** doc #1 (threat model & architecture)

This document defines every new WS frame type introduced by phase 11d.
It is field-by-field exhaustive so doc #4 (server schema) and doc #5
(client state machines) can be written against a frozen protocol.

The conventions match chalk's existing `internal/proto/` patterns:
`Type<Name>` constants with `snake_case` wire names, ack types as
`Type<Name>Ack`, bytes encoded as base64 strings, IDs as UUID strings.
Phase 11d frame definitions live in
`internal/proto/frames_phase11d.go`.

---

## 1. Overview of frame families

Phase 11d adds **32 new wire types** to chalk in five families:

**A. Envelope family** — for uploading and downloading the wrapped
`backup_master_key`.

| Type | Direction | Purpose |
|------|-----------|---------|
| `backup_envelope_get`     | C→S | Fetch the user's envelope |
| `backup_envelope_get_ack` | S→C | Returns the envelope JSON |
| `backup_envelope_put`     | C→S | Replace the user's envelope |
| `backup_envelope_put_ack` | S→C | Confirmation |

**B. History-secrets family** — for storing and retrieving per-era
HistorySecrets.

| Type | Direction | Purpose |
|------|-----------|---------|
| `history_secret_put`     | C→S | Upload one encrypted HistorySecret |
| `history_secret_put_ack` | S→C | Confirmation |
| `history_secret_list`    | C→S | List the user's stored secrets (metadata only) |
| `history_secret_list_ack`| S→C | Returns list of descriptors |
| `history_secret_get`     | C→S | Download a specific secret |
| `history_secret_get_ack` | S→C | Returns the encrypted secret |

**C. Pairing family** — for online device-to-device pairing.

| Type | Direction | Purpose |
|------|-----------|---------|
| `pairing_offer`          | C→S | Existing device offers to pair |
| `pairing_offer_ack`      | S→C | Returns pairing_id and code material |
| `pairing_claim`          | C→S | New device claims a pairing offer |
| `pairing_claim_ack`      | S→C | Acknowledges claim, relays existing-device pubkey |
| `pairing_complete`       | C→S | Old device sends encrypted master_key to new device |
| `pairing_complete_ack`   | S→C | Confirmation |
| `pairing_event`          | S→C | Push to old device: "new device just claimed" |
| `pairing_cancel`         | C→S | Either party cancels the pairing flow |

**D. Multi-device family** — device announce + remove.

| Type | Direction | Purpose |
|------|-----------|---------|
| `device_announce`        | C→S | New device announces itself |
| `device_announce_ack`    | S→C | Confirmation |
| `device_announce_event`  | S→C | Push to OTHER devices |
| `device_list`            | C→S | List the user's devices |
| `device_list_ack`        | S→C | Returns device descriptors |
| `device_remove`          | C→S | Mark a device as removed |
| `device_remove_ack`      | S→C | Confirmation |

**E. Status family** — for transparency UX (D7).

| Type | Direction | Purpose |
|------|-----------|---------|
| `backup_status_get`        | C→S | Query backup health |
| `backup_status_get_ack`    | S→C | Returns backup health |
| `backup_progress_event`    | S→C | Push progress during long ops |

**F. Critical event family** — high-importance notifications with
cross-device sync (D8/D9).

| Type | Direction | Purpose |
|------|-----------|---------|
| `critical_event`         | S→C | Push: high-importance event |
| `critical_event_list`    | C→S | Fetch unacked critical events |
| `critical_event_list_ack`| S→C | Returns list |
| `critical_event_ack`     | C→S | User acknowledged |
| `critical_event_ack_ack` | S→C | Confirmation |
| `critical_event_dismissed_event` | S→C | Push to OTHER devices |

Frame conventions match chalk's existing `internal/proto/` layer:
`Type<Name>` constants with `snake_case` wire names, `<Name>Ack` /
`<Name>AckPayload` for ack types, base64 strings for bytes, UUID
strings for IDs. Phase 11d frames live in
`internal/proto/frames_phase11d.go`.

---

## 2. Envelope family

The envelope holds the user's `backup_master_key` wrapped under one or
more per-credential keys (recovery phrase in v1; passkey PRF in v2+).
Put/get semantics are simple replacement with optimistic concurrency.

### 2.1 Envelope structure

```go
type BackupEnvelope struct {
    Version int                  `json:"envelope_version"` // 1
    Wraps   []BackupEnvelopeWrap `json:"wraps"`
}

type BackupEnvelopeWrap struct {
    Kind       string `json:"kind"`         // "recovery_phrase" in v1
    WrapID     string `json:"wrap_id"`      // UUID
    ExpiresAt  *int64 `json:"expires_at,omitempty"` // unix ms; null = current
    Ciphertext string `json:"ciphertext"`   // base64 AEAD output
    Nonce      string `json:"nonce"`        // base64, 24 bytes
    KdfSalt    string `json:"kdf_salt"`     // base64, 16 bytes
    KdfParams  *BackupKdfParams `json:"kdf_params,omitempty"`
}

type BackupKdfParams struct {
    Algorithm  string `json:"algorithm"`   // "argon2id"
    Memory     uint32 `json:"memory"`      // KiB
    Time       uint32 `json:"time"`
    Threads    uint32 `json:"threads"`
    KeyLen     uint32 `json:"key_len"`
}
```

### 2.2 `backup_envelope_get`

```go
type BackupEnvelopeGetPayload struct {} // user implicit

type BackupEnvelopeGetAckPayload struct {
    Envelope *BackupEnvelope `json:"envelope"` // null if none exists
}
```

### 2.3 `backup_envelope_put`

```go
type BackupEnvelopePutPayload struct {
    Envelope        BackupEnvelope `json:"envelope"`
    ExpectedVersion int            `json:"expected_version"`
}

type BackupEnvelopePutAckPayload struct {
    NewVersion int `json:"new_version"`
}
```

**Server validation**:
- Total envelope size ≤ 64 KB
- ≤ 1024 wraps
- `wrap.kind` in allowlist (`"recovery_phrase"` for v1)
- `ciphertext` length matches AEAD output expectations
- `nonce` exactly 24 bytes
- `kdf_salt` exactly 16 bytes

**Errors**: `envelope_too_large`, `envelope_conflict`, `envelope_invalid`.

---

## 3. History-secrets family

This is the new family that replaces the previous "backup family"
(tier-1/tier-2 blobs, chunked uploads). Each secret is small enough to
fit in a single WS frame.

### 3.1 Encrypted secret structure

Each HistorySecret captured by the HistoryObserver is:

1. CBOR-encoded as `{schema_version: 1, client_id: <bytes>, data: <bytes>}`
   to produce a plaintext of ~812 bytes. See doc #3 §3 for full layout.
2. AEAD-encrypted under `backup_master_key` with a random 24-byte nonce
   using XChaCha20-Poly1305.
3. AAD = `"chalk.history.v1" || user_id (16B) || conversation_id (16B) || u64_be(era_epoch)`.

Ciphertext is base64-encoded for JSON transport. Final wire size is
~1.1 KB per secret.

Doc #3 is canonical for the encrypted-payload format. Any discrepancy
between this doc and doc #3 is a doc bug; defer to doc #3.

### 3.2 `history_secret_put`

```go
type HistorySecretPutPayload struct {
    ConversationID string `json:"conversation_id"`  // UUID, same as chalk channel
    EraEpoch       uint64 `json:"era_epoch"`        // MLS epoch at history-client add
    EnvelopeVersion int   `json:"envelope_version"` // for forward-compat verification

    Ciphertext  string `json:"ciphertext"`  // base64
    Nonce       string `json:"nonce"`       // base64, 24 bytes

    // CreatedAt is the unix-ms timestamp the secret was captured.
    // Server may reject if >5min from server clock.
    CreatedAt int64 `json:"created_at"`

    // SourceDeviceID is the device that captured this secret (i.e.
    // the device whose HistoryObserver fired). Informational.
    SourceDeviceID string `json:"source_device_id"`

    // ProducingCoreCryptoVersion records which version of
    // @wireapp/core-crypto produced this secret's inner data. Used
    // at restore time to diagnose future-version incompatibilities
    // (see doc #3 §6.3 for the forward-compat strategy).
    // Format: semver string, e.g. "9.3.4". Required.
    ProducingCoreCryptoVersion string `json:"producing_corecrypto_version"`
}

type HistorySecretPutAckPayload struct {
    SecretID string `json:"secret_id"` // server-assigned UUID
}
```

**Server validation**:
- `ciphertext` length ≤ 8 KB (typical: ~1.1 KB; ceiling is generous)
- `nonce` exactly 24 bytes
- `conversation_id` is a known conversation the user is a member of
- `era_epoch` ≥ 0
- `created_at` within ±5 min of server clock

If a secret already exists for the same
`(user_id, conversation_id, era_epoch)` triplet, **UPSERT semantics
apply** (per Q17 in doc #1): the new value overwrites the old. This
handles bug-induced re-uploads gracefully.

**Errors**: `secret_too_large`, `secret_invalid`, `secret_clock_skew`,
`secret_invalid_conversation`.

### 3.3 `history_secret_list`

Used by a restoring device to enumerate all available secrets without
downloading their ciphertexts.

```go
type HistorySecretListPayload struct {
    // Optional: filter to a specific conversation. If empty, list all.
    ConversationID string `json:"conversation_id,omitempty"`
}

type HistorySecretListAckPayload struct {
    Secrets []HistorySecretDescriptor `json:"secrets"`
}

type HistorySecretDescriptor struct {
    SecretID                  string `json:"secret_id"`
    ConversationID            string `json:"conversation_id"`
    EraEpoch                  uint64 `json:"era_epoch"`
    EnvelopeVersion           int    `json:"envelope_version"`
    SourceDeviceID            string `json:"source_device_id"`
    CreatedAt                 int64  `json:"created_at"`
    SizeBytes                 int    `json:"size_bytes"`
    ProducingCoreCryptoVersion string `json:"producing_corecrypto_version"`
}
```

Descriptors are sorted by `(conversation_id, era_epoch)` ascending so
clients can apply secrets in deterministic order during restore.

### 3.4 `history_secret_get`

```go
type HistorySecretGetPayload struct {
    SecretID string `json:"secret_id"`
}

type HistorySecretGetAckPayload struct {
    SecretID                  string `json:"secret_id"`
    ConversationID            string `json:"conversation_id"`
    EraEpoch                  uint64 `json:"era_epoch"`
    EnvelopeVersion           int    `json:"envelope_version"`
    SourceDeviceID            string `json:"source_device_id"`
    CreatedAt                 int64  `json:"created_at"`
    ProducingCoreCryptoVersion string `json:"producing_corecrypto_version"`

    Ciphertext string `json:"ciphertext"`
    Nonce      string `json:"nonce"`
}
```

**Errors**: `secret_not_found`.

### 3.5 Why no chunked transport

Each HistorySecret is ~1.1 KB on the wire. WS frame size limits in
production deployments are typically ≥ 1 MB. We are three orders of
magnitude below that. Single-frame transport is sufficient.

The previous design's chunked tier-2 upload (256 KB chunks of up to
16 MB total) is obsolete. The simplification removes:
- `backup_tier2_put_init/chunk/finish` and download counterparts
- Upload-state tracking on the server
- The `backup_progress_event` need for upload progress (still useful
  for restore progress; see §6)
- Upload timeout / chunk validation logic

Net: roughly 10 frames eliminated.

### 3.6 Era selection on restore

When a device restores history, it calls `history_secret_list`,
receives all descriptors, then downloads them all via
`history_secret_get`. Each is decrypted and fed to
`CoreCrypto.historyClient(secret)`, producing one history-client
instance per era.

Storage and bandwidth: a user in 50 conversations averaging 20 eras
each has 1000 secrets × 1.1 KB ≈ 1.1 MB total restore download.
That fits in a single round of `history_secret_list` plus 1000 frame
exchanges. The exchanges can be parallelized (no ordering constraint
in download); a ~10 connection batch completes in seconds.

The exchanges CAN be ordered chronologically per-conversation if the
client wants to surface history progressively — show oldest messages
first as their era's client comes online. That's a client choice, not
a protocol constraint.

---

## 4. Pairing family

The pairing flow runs between two devices of the same user, mediated
by chalkd which sees only encrypted blobs. **The detailed PAKE
mechanics, QR-code format, and field-by-field frame payloads are
specified in doc #6 (PAKE pairing flow), which has not yet been
written.** This section provides the protocol surface only.

Key points:
- 5-frame round trip: `pairing_offer` → `pairing_offer_ack` →
  `pairing_claim` → `pairing_claim_ack` + `pairing_event` →
  `pairing_complete` → `pairing_complete_ack`
- Out-of-band secret transmitted via QR code (128-bit) or 6-digit PIN
  (PAKE v2)
- ECDH(X25519) + HKDF derive the session key
- `pairing_session_key` encrypts the `backup_master_key` for transit
- Server in-memory state only; 5-minute TTL

Until doc #6 lands, implementers should treat the pairing family as
unspecified and not yet implementable. Other families (envelope,
history-secrets, multi-device, status, critical event) are
fully-specified in this doc and can be implemented independently.

---

## 5. Multi-device family

**Key points** (full field-by-field specs deferred to doc #5,
client state machines):

- After successful restore (via pairing OR recovery), the new device
  fires `device_announce` with origin_kind = `"paired"` or
  `"recovery"`.
- Server stores the device row and pushes `device_announce_event` to
  other connected devices of the same user.
- Other devices initiate self-add: for each MLS group they're a
  member of, add the new device via `addClientsToConversation`.
- Self-add races resolved by random 0-30s delay per device (deferring
  the actual commit) to reduce concurrent-commit collisions.
- `device_remove` evicts a device via MLS commits.

---

## 6. Status family

Implements D7 transparency. The status family is read-only on the
server side (no side effects from get queries) and produces push
events during long-running operations like restore.

### 6.1 `backup_status_get`

Returns a snapshot:

```go
type BackupStatusGetAckPayload struct {
    EnvelopePresent      bool   `json:"envelope_present"`
    EnvelopeVersion      int    `json:"envelope_version"`
    HistorySecretsCount  int    `json:"history_secrets_count"`
    LastSecretUploadAt   *int64 `json:"last_secret_upload_at"`
    LastFailedUpload     *BackupFailedAttempt `json:"last_failed_upload"`
    ActiveRestoresCount  int    `json:"active_restores_count"`
    PendingCriticalEvents int   `json:"pending_critical_events"`
}
```

The server should cache this per-user response briefly (recommended:
30s) and invalidate on relevant write events (envelope put,
history_secret put, critical-event ack). Without caching this becomes
a hot path; with caching the typical user sees a single cache hit per
tab focus.

### 6.2 `backup_progress_event`

Used during restore to give the user feedback on long-running
operations:

```go
type BackupProgressEventPayload struct {
    OperationID string `json:"operation_id"`
    Kind        string `json:"kind"`        // "restore" in v1
    Stage       string `json:"stage"`       // human-readable stage label
    Percent     int    `json:"percent"`     // 0-100, -1 = indeterminate
    Items       int    `json:"items"`       // current item index
    TotalItems  int    `json:"total_items"` // total items
    Terminal    bool   `json:"terminal"`
    Failed      bool   `json:"failed,omitempty"`
    FailureReason string `json:"failure_reason,omitempty"`
}
```

Stage examples for `Kind="restore"`:
- "fetching envelope"
- "decrypting master key"
- "listing history secrets"
- "downloading secret N/M"
- "instantiating history client N/M"
- "restore complete"

`Kind="restore"` is the only kind in v1. Future kinds may include
`"envelope_rotation"` (when the user rotates their recovery phrase
and the envelope re-wrap takes meaningful time).

---

## 7. Critical event family

Implements D8/D9: high-importance, user-facing notifications that
require explicit acknowledgment. Cross-device synchronized — an ack
on any of the user's devices dismisses on all others. The server is
the sole emitter of critical events; clients only receive and ack.

Six event kinds:

| Kind | When emitted | User action |
|------|--------------|-------------|
| `device_added_paired`         | New device via pairing | "OK" / "Wasn't me" |
| `device_added_recovery`       | New device via recovery phrase | "OK" / "Wasn't me — rotate" |
| `device_removed`              | Device removed | "OK" |
| `recovery_phrase_rotated`     | Recovery rotation completed | "OK" |
| `history_uploads_persistently_failing` | Secret uploads failing >1hr | "Investigate" |
| `restore_completed`           | Restore finished | "Welcome back" |

Cross-device sync mechanism: an ack on any device dismisses on all
others via `critical_event_dismissed_event`.

Retention: pending 90 days TTL, acked 180 days for audit.

---

## 8. Error codes

All errors follow chalk's existing convention: `frame_type=error`,
payload `{code: string, message: string, ref: string}`.

New codes introduced by phase 11d:

| Code | Frame context | Meaning |
|------|---------------|---------|
| `envelope_too_large` | backup_envelope_put | > 64 KB |
| `envelope_conflict` | backup_envelope_put | expected_version mismatch |
| `envelope_invalid` | backup_envelope_put | schema violation |
| `secret_too_large` | history_secret_put | > 8 KB |
| `secret_invalid` | history_secret_put | schema violation |
| `secret_clock_skew` | history_secret_put | created_at outside ±5 min |
| `secret_invalid_conversation` | history_secret_put | conversation unknown |
| `secret_not_found` | history_secret_get | secret_id unknown |
| `pairing_not_found` | pairing_* | pairing_id unknown/expired |
| `pairing_already_claimed` | pairing_claim | another claim won the race |
| `pairing_proof_invalid` | (push only) | proof mismatch |
| `pairing_expired` | pairing_* | past expires_at |
| `device_not_found` | device_remove | device_id unknown |
| `device_remove_self` | device_remove | can't remove the calling device |
| `critical_event_not_found` | critical_event_ack | event_id unknown |
| `critical_event_already_acked` | critical_event_ack | race lost |
| `critical_event_action_invalid` | critical_event_ack | action_id not allowed |

---

## 9. Server-side resource limits

| Limit | Value |
|-------|-------|
| Envelope size | ≤ 64 KB |
| Envelope wraps count | ≤ 1024 |
| HistorySecret ciphertext size | ≤ 8 KB |
| HistorySecrets per user | unlimited (storage cost accepted per doc #1 §4.3) |
| Pairing offers per user (concurrent) | ≤ 3 |
| Pairing offer TTL | 5 min |
| Pairing in-memory state lifetime | 5 min |
| Devices per user | ≤ 32 |
| KeyPackages per device per ciphersuite | ≤ 100 (already enforced phase 11a) |
| `backup_status_get` response cache | 30 s per user |
| `backup_progress_event` rate limit | ≤ 4 events/sec per operation |
| Pending critical events per user | ≤ 100 |
| Critical event pending TTL | 90 days |
| Critical event acked retention | 180 days |

The HistorySecret ceiling of 8 KB is comfortably above typical (~1.1
KB) and exists primarily as a defensive bound against bug-induced
bloat.

---

## 10. No HTTP endpoints

Per Q4 (locked in doc #1), all phase-11d traffic flows over the
existing WS connection. No new HTTP endpoints introduced.

---

## 11. Frame count summary

Phase 11d adds **32 new wire types** to chalk:

- 4 envelope family
- 6 history-secrets family
- 8 pairing family
- 7 multi-device family (counting `device_announce_event` push)
- 3 status family
- 6 critical event family (counting `_dismissed_event` push)

---

## 12. Suggested landing order

The frames are largely independent. Suggested order for landing in
chalk:

- **Land 1**: envelope put/get + `backup_status_get` (silent foundation;
  enables the status badge from day one)
- **Land 2**: `history_secret_put` + emit-on-observer-fire (start
  uploading secrets; no consumer yet)
- **Land 3**: `history_secret_list` + `history_secret_get` +
  `backup_progress_event` (enables the restore flow)
- **Land 4**: critical event family (standalone; depends on Land 1)
- **Land 5**: pairing family (depends on Land 1-3 to have something
  to pair; also depends on doc #6 being written)
- **Land 6**: `device_announce` + self-add flow + emits
  `device_added_paired` / `device_added_recovery` critical events
- **Land 7**: `device_list` + `device_remove` + emits `device_removed`
  critical event

This ordering also gives a sensible v0.1 demo at the end of Land 3
(silent backup + restore working end-to-end), with multi-device
features layered on top.

---

## 13. Open questions

**Q15** (from doc #1): era_epoch = MLS conversation epoch at the
moment the history client was added. Resolved at the protocol level —
the `HistorySecretPutPayload.era_epoch` field carries this value.
Implementation caveat about how the client OBTAINS the value (cannot
call back into CoreCrypto from inside the HistoryObserver) is
documented in doc #3 §4.2. Pending integration testing in chalk.

**Q16** (from doc #1): observer fire ordering is assumed monotonic.
Protocol-level: chalk's client code uploads in observer-callback
order. The actual monotonicity guarantee from CoreCrypto needs
integration verification before being relied on in production.

**Q17** (from doc #1): server upserts on
`(user_id, conversation_id, era_epoch)`. Resolved. See §3.2.

**Q18** (new): Should `history_secret_list_ack` include a pagination
cursor for users with very many secrets (say, > 10,000)?

Initial recommendation: no pagination in v1. 10,000 descriptors at
~200 bytes each = 2 MB ack payload, which fits in WS comfortably.
If pagination becomes necessary, add a `cursor` field in v2 without
breaking v1 clients.

**Q19** (new): Should the encrypted HistorySecret's CBOR include a
schema version byte so we can evolve the inner format?

Recommendation: yes. The CBOR plaintext is
`{schema_version: 1, client_id: <bytes>, data: <bytes>}` rather than
just the two fields. Doc #3 §3 specifies this as the canonical
format.

---

## 14. Summary

Doc #2 defines **32 wire frames** across six families:

- Envelope (4): manage the wrapped `backup_master_key`
- History secrets (6): put / list / get per-era HistorySecrets
- Pairing (8): online device-to-device handoff; details in doc #6
- Multi-device (7): announce, list, remove devices
- Status (3): backup-health snapshots + restore progress
- Critical events (6): high-importance notifications with
  cross-device acknowledgment sync

Doc #3 defines what goes INSIDE the encrypted HistorySecret payload
that the history-secrets family ferries.

End of doc #2. Vienna 2026-05-27.
