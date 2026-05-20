# Phase 11d Design Doc #2 — Wire Protocol Spec

**Status:** Revision 3 (history-client architecture, sandbox-validated)
**Author:** Claude, per scuq's design choices
**Date:** 2026-05-27 (Vienna)
**Scope:** chalk phase 11d — wire format for envelope, history secrets,
pairing, multi-device, status, and critical events
**Depends on:** doc #1 rev 3 (threat model & architecture)
**Previous revisions:** rev 1 (initial 30 frames), rev 2 (added status
& critical-event families, 39 frames). **This revision** replaces the
backup family with a simpler history-secrets family. Net frame count
drops from 39 to 32.

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

**C. Pairing family** — for online device-to-device pairing
(unchanged from rev 2).

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

**D. Multi-device family** — device announce + remove (unchanged from
rev 2).

| Type | Direction | Purpose |
|------|-----------|---------|
| `device_announce`        | C→S | New device announces itself |
| `device_announce_ack`    | S→C | Confirmation |
| `device_announce_event`  | S→C | Push to OTHER devices |
| `device_list`            | C→S | List the user's devices |
| `device_list_ack`        | S→C | Returns device descriptors |
| `device_remove`          | C→S | Mark a device as removed |
| `device_remove_ack`      | S→C | Confirmation |

**E. Status family** — for transparency UX (D7, unchanged from rev 2).

| Type | Direction | Purpose |
|------|-----------|---------|
| `backup_status_get`        | C→S | Query backup health |
| `backup_status_get_ack`    | S→C | Returns backup health |
| `backup_progress_event`    | S→C | Push progress during long ops |

**F. Critical event family** — high-importance notifications with
cross-device sync (D8/D9, unchanged from rev 2).

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

The envelope structure and put/get semantics are inherited unchanged
from rev 2 §2.1-§2.3. Reproduced here in condensed form for
self-containment.

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

**Server validation** (unchanged from rev 2):
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

1. CBOR-encoded as `{client_id: <bytes>, data: <bytes>}` to produce a
   plaintext of ~800 bytes.
2. AEAD-encrypted under `backup_master_key` with a random 24-byte nonce.
3. AAD = `"chalk.history.v1" || user_id || conversation_id || u64_be(era_epoch)`.

Ciphertext is base64-encoded for JSON transport. Final wire size is
~1.1 KB per secret.

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
    SecretID       string `json:"secret_id"`
    ConversationID string `json:"conversation_id"`
    EraEpoch       uint64 `json:"era_epoch"`
    EnvelopeVersion int   `json:"envelope_version"`
    SourceDeviceID  string `json:"source_device_id"`
    CreatedAt       int64  `json:"created_at"`
    SizeBytes       int    `json:"size_bytes"`
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
    SecretID        string `json:"secret_id"`
    ConversationID  string `json:"conversation_id"`
    EraEpoch        uint64 `json:"era_epoch"`
    EnvelopeVersion int    `json:"envelope_version"`
    SourceDeviceID  string `json:"source_device_id"`
    CreatedAt       int64  `json:"created_at"`

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

**Unchanged from rev 2 §3.** Reproduced descriptions only; for full
field-by-field specs see prior revision.

The pairing flow runs between two devices of the same user, mediated
by chalkd which sees only encrypted blobs.

Key points:
- 5-frame round trip: `pairing_offer` → `pairing_offer_ack` →
  `pairing_claim` → `pairing_claim_ack` + `pairing_event` →
  `pairing_complete` → `pairing_complete_ack`
- Out-of-band secret transmitted via QR code (128-bit) or 6-digit PIN
  (PAKE v2)
- ECDH(X25519) + HKDF derive the session key
- `pairing_session_key` encrypts the `backup_master_key` for transit
- Server in-memory state only; 5-minute TTL

PAKE detail belongs in doc #6.

---

## 5. Multi-device family

**Unchanged from rev 2 §4.** Key points:

- After successful restore (via pairing OR recovery), the new device
  fires `device_announce` with origin_kind = `"paired"` or
  `"recovery"`.
- Server stores the device row and pushes `device_announce_event` to
  other connected devices of the same user.
- Other devices initiate self-add: for each MLS group they're a
  member of, add the new device via `addClientsToConversation`.
- Self-add races resolved by random 0-30s delay (per Q9 in rev 2).
- `device_remove` evicts a device via MLS commits.

---

## 6. Status family

**Unchanged from rev 2 §5.** Implements D7 transparency.

### 6.1 `backup_status_get`

Returns a snapshot:

```go
type BackupStatusGetAckPayload struct {
    EnvelopePresent      bool   `json:"envelope_present"`
    EnvelopeVersion      int    `json:"envelope_version"`
    HistorySecretsCount  int    `json:"history_secrets_count"`  // NEW vs rev 2
    LastSecretUploadAt   *int64 `json:"last_secret_upload_at"`  // NEW vs rev 2
    LastFailedUpload     *BackupFailedAttempt `json:"last_failed_upload"`
    ActiveRestoresCount  int    `json:"active_restores_count"`
    PendingCriticalEvents int   `json:"pending_critical_events"`
}
```

Note the field changes from rev 2: instead of separate tier-1 and
tier-2 last-upload tracking, we now have a single
`HistorySecretsCount` and `LastSecretUploadAt`.

### 6.2 `backup_progress_event`

Used during restore to give the user feedback on long-running
operations:

```go
type BackupProgressEventPayload struct {
    OperationID string `json:"operation_id"`
    Kind        string `json:"kind"`
    Stage       string `json:"stage"`        // "downloading secrets", "decrypting", "instantiating history clients", "joining groups"
    Percent     int    `json:"percent"`      // 0-100, -1 = indeterminate
    Items       int    `json:"items"`        // current item index
    TotalItems  int    `json:"total_items"`  // total items
    Terminal    bool   `json:"terminal"`
    Failed      bool   `json:"failed,omitempty"`
    FailureReason string `json:"failure_reason,omitempty"`
}
```

Kind values are: `"restore"`. The original rev 2 also defined
`"tier2_upload"` and `"tier2_download"`, both obsolete now. Restore
progress is the primary use case.

---

## 7. Critical event family

**Unchanged from rev 2 §6.** Implements D8/D9.

Six event kinds:

| Kind | When emitted | User action |
|------|--------------|-------------|
| `device_added_paired`         | New device via pairing | "OK" / "Wasn't me" |
| `device_added_recovery`       | New device via recovery phrase | "OK" / "Wasn't me — rotate" |
| `device_removed`              | Device removed | "OK" |
| `recovery_phrase_rotated`     | Recovery rotation completed | "OK" |
| `history_uploads_persistently_failing` | Secret uploads failing >1hr (was: `backup_persistently_failing` in rev 2) | "Investigate" |
| `restore_completed`           | Restore finished | "Welcome back" |

Cross-device sync mechanism: an ack on any device dismisses on all
others via `critical_event_dismissed_event`.

Retention: pending 90 days TTL, acked 180 days for audit.

---

## 8. Error codes

Updated for the new history-secrets family. Codes carried over from
rev 2 unless marked.

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

Removed compared to rev 2: `backup_too_large`, `backup_invalid_device`,
`backup_clock_skew`, `backup_not_found`, `upload_too_large`,
`upload_chunk_out_of_order`, `upload_chunk_wrong_size`,
`upload_sha256_mismatch`, `upload_timeout`. All were for the chunked
tier-2 flow that no longer exists.

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

Removed compared to rev 2: tier-1/tier-2 ceilings, chunk size limit,
upload timeout. The new per-secret ceiling (8 KB) is more permissive
than necessary (typical is 1.1 KB).

---

## 10. No HTTP endpoints

Per Q4=a (locked in rev 1), all phase-11d traffic flows over the
existing WS connection. No new HTTP endpoints introduced.

---

## 11. Frame count summary

Phase 11d adds **32 new wire types** to chalk:

- 4 envelope family
- 6 history-secrets family (was: 16 backup family in rev 2)
- 8 pairing family
- 7 multi-device family (counting `device_announce_event` push)
- 3 status family
- 6 critical event family (counting `_dismissed_event` push)

For comparison: rev 1 had 30 frames, rev 2 had 39. Rev 3 has 32 —
back near rev 1's count but with the rev 2 transparency additions
intact.

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
  to pair)
- **Land 6**: `device_announce` + self-add flow + emits
  `device_added_paired` / `device_added_recovery` critical events
- **Land 7**: `device_list` + `device_remove` + emits `device_removed`
  critical event

This ordering also gives a sensible v0.1 demo at the end of Land 3
(silent backup + restore working end-to-end), with multi-device
features layered on top.

---

## 13. Open questions

**Q15 (from doc #1)**: era_epoch = MLS epoch number at history-client
add. Resolved. The HistorySecretPutPayload field `era_epoch` carries
this directly.

**Q16 (from doc #1)**: observer fires are in order. Resolved by
inspection of CoreCrypto source. Protocol assumes ordering; chalk's
client code uploads in observer-callback order.

**Q17 (from doc #1)**: server upserts on
`(user_id, conversation_id, era_epoch)`. Resolved. See §3.2.

**Q18 (new)**: Should `history_secret_list_ack` include a pagination
cursor for users with very many secrets (say, > 10,000)?

Initial recommendation: no pagination in v1. 10,000 descriptors at
~200 bytes each = 2 MB ack payload, which fits in WS comfortably.
If pagination becomes necessary, add a `cursor` field in v2 without
breaking v1 clients.

**Q19 (new)**: Should the encrypted HistorySecret's CBOR include a
schema version byte so we can evolve the inner format?

Recommendation: yes. The CBOR plaintext is
`{schema_version: 1, client_id: <bytes>, data: <bytes>}` rather than
just the two fields. This is a tiny overhead (~5 bytes) and saves us
from format-evolution pain later. See doc #3 §3 for full layout.

---

## 14. Summary

Doc #2 rev 3 defines **32 wire frames** across six families. The shape
is much simpler than rev 2:

- Envelope unchanged.
- Backup blobs replaced with a single per-secret put/list/get family.
  No chunking, no tier-1/tier-2 split, no chunked-state machine.
- Pairing, multi-device, status, critical events all unchanged.

Open questions Q18-Q19 are smaller than prior revisions'. Doc #3
(rev 3) defines what goes INSIDE the encrypted HistorySecret payload
that this protocol ferries.

End of doc #2 revision 3. Vienna 2026-05-27.
