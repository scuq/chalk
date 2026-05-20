# Phase 11d Design Doc #2 — Wire Protocol Spec

**Status:** Draft for review
**Author:** Claude, per scuq's design choices
**Date:** 2026-05-27 (Vienna)
**Scope:** chalk phase 11d — wire format for backup, restore, and pairing
**Depends on:** doc #1 (threat model & crypto primitives), D1-D6 + Q1=c + Q3 + Q4=a

This document defines every new WS frame type and HTTP endpoint introduced
by phase 11d. It is field-by-field exhaustive so doc #4 (server schema) and
doc #5 (client state machines) can be written against a frozen protocol.

The conventions in this doc match chalk's existing patterns
(`internal/proto/`): `Type<Name>` constants with `snake_case` wire names,
ack types as `Type<Name>Ack`, bytes encoded as base64 strings, IDs as UUID
strings. Phase 11d's frame definitions will live in
`internal/proto/frames_phase11d.go` (per the existing per-phase convention).

---

## 1. Overview of new frames

Phase 11d introduces three families of frames:

**A. Backup family** — for uploading and downloading encrypted backup
blobs.

| Type | Direction | Purpose |
|------|-----------|---------|
| `backup_envelope_get`     | C→S | Fetch the user's envelope (the wrapped master_key) |
| `backup_envelope_get_ack` | S→C | Returns the envelope JSON |
| `backup_envelope_put`     | C→S | Replace the user's envelope (e.g. after rotation) |
| `backup_envelope_put_ack` | S→C | Confirmation |
| `backup_tier1_put`        | C→S | Upload tier-1 (identity) backup blob |
| `backup_tier1_put_ack`    | S→C | Confirmation + assigned backup_id |
| `backup_tier1_get`        | C→S | Download tier-1 backup |
| `backup_tier1_get_ack`    | S→C | Returns the tier-1 blob |
| `backup_tier2_put_init`   | C→S | Start a chunked tier-2 upload |
| `backup_tier2_put_chunk`  | C→S | Upload a chunk (multiple frames) |
| `backup_tier2_put_finish` | C→S | Finalize the upload |
| `backup_tier2_put_ack`    | S→C | Confirmation + assigned backup_id |
| `backup_tier2_get_init`   | C→S | Start a chunked tier-2 download |
| `backup_tier2_get_chunk`  | S→C | Push a chunk |
| `backup_tier2_get_finish` | S→C | Final chunk marker |
| `backup_list`             | C→S | List the user's backups (manifest only, no blobs) |
| `backup_list_ack`         | S→C | Returns list of backup descriptors |

**B. Pairing family** — for online device-to-device pairing.

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

**C. Multi-device family** — for the "I'm a new device of an existing
user" announcement and the resulting self-add flow.

| Type | Direction | Purpose |
|------|-----------|---------|
| `device_announce`        | C→S | New device announces itself; server fans out |
| `device_announce_ack`    | S→C | Confirmation |
| `device_announce_event`  | S→C | Push to OTHER devices: "your user has a new device" |
| `device_list`            | C→S | List the user's currently-known devices |
| `device_list_ack`        | S→C | Returns device descriptors |
| `device_remove`          | C→S | Mark a device as removed (for cleanup post-rotation) |
| `device_remove_ack`      | S→C | Confirmation |

Each frame's payload is specified in §2–§4 below.

---

## 2. Backup family — field-by-field

### 2.1 Envelope structure (in-payload shape, referenced by §2.2 and §2.3)

The envelope is a JSON object that holds the wrapped `backup_master_key`
once per credential. It's what the user must obtain (and decrypt at least
one wrap of) to access any backup blob.

```go
// internal/proto/frames_phase11d.go
type BackupEnvelope struct {
    Version int                  `json:"envelope_version"` // 1
    Wraps   []BackupEnvelopeWrap `json:"wraps"`
}

type BackupEnvelopeWrap struct {
    // Kind identifies which credential decrypts this wrap.
    // Phase 11d v1: only "recovery_phrase" is used.
    // Phase 11d v2 will add "passkey_prf".
    // Future: "paired_device", "emergency_contact", etc.
    Kind string `json:"kind"`

    // WrapID is a stable identifier for this entry. Used by clients
    // to tell "I rotated; this is the new wrap" from "I added a
    // second credential."
    WrapID string `json:"wrap_id"` // UUID

    // ExpiresAt is set when a wrap has been superseded by rotation
    // (per D3). null means "current, no expiration."
    // Server may prune entries past ExpiresAt; clients ignore
    // expired entries on read (return as last resort if no
    // non-expired wraps exist for the user's credential).
    ExpiresAt *int64 `json:"expires_at,omitempty"` // unix ms

    // Ciphertext is AEAD(kw_key, nonce, aad, backup_master_key).
    // Always exactly 48 bytes plaintext (32 key + 16 tag), encrypted.
    Ciphertext string `json:"ciphertext"` // base64

    // Nonce is the AEAD nonce. 24 bytes (XChaCha20-Poly1305).
    Nonce string `json:"nonce"` // base64

    // KdfSalt is the Argon2id salt used for this wrap's credential.
    // For "recovery_phrase" wraps, this matches the salt in
    // recovery_codes.hash (the existing chalk auth table; see §5 of
    // doc #1). For "passkey_prf" wraps in v2, this is the PRF
    // evaluation input.
    KdfSalt string `json:"kdf_salt"` // base64, 16 bytes

    // KdfParams describes the KDF parameters used. Allows future
    // parameter upgrades without breaking old wraps.
    KdfParams *BackupKdfParams `json:"kdf_params,omitempty"`
}

type BackupKdfParams struct {
    // Algorithm is "argon2id" in v1.
    Algorithm string `json:"algorithm"`
    // Memory in KiB.
    Memory uint32 `json:"memory"`
    // Iterations.
    Time uint32 `json:"time"`
    // Parallelism.
    Threads uint32 `json:"threads"`
    // Output key length in bytes.
    KeyLen uint32 `json:"key_len"`
}
```

The envelope is the user's "key escrow" record. There is exactly one
envelope per user. It is small: a single wrap is ~200 bytes; ten wraps is
~2 KB.

### 2.2 `backup_envelope_get`

Fetch the envelope. Required before any other backup operation (to know
how to derive the wrap key for decryption).

```go
type BackupEnvelopeGetPayload struct {
    // No fields. The user_id is implicit (the WS connection's user).
}

type BackupEnvelopeGetAckPayload struct {
    // Envelope is null if the user has no envelope yet (no backup
    // has ever been uploaded).
    Envelope *BackupEnvelope `json:"envelope"`
}
```

Idempotent. Cheap. May be called multiple times per session.

### 2.3 `backup_envelope_put`

Replace the envelope. Used in three cases:

1. **First-ever backup**: client generates `backup_master_key`, wraps it
   under the recovery-phrase-derived key, uploads the envelope.
2. **Rotation**: client adds a new wrap and marks the old wrap with
   `expires_at`.
3. **Adding a credential** (v2 with PRF, or future): client adds a new
   wrap entry; doesn't touch existing wraps.

The server treats this as wholesale replacement to keep the protocol
simple. Client must always upload the full envelope, even when only one
wrap changed.

```go
type BackupEnvelopePutPayload struct {
    Envelope BackupEnvelope `json:"envelope"`

    // ExpectedVersion is the envelope_version the client read when
    // it fetched the envelope. If the server has a newer version
    // (race with another device), it rejects with conflict.
    // Set to 0 for first-ever envelope.
    ExpectedVersion int `json:"expected_version"`
}

type BackupEnvelopePutAckPayload struct {
    // NewVersion is the version that was just written.
    NewVersion int `json:"new_version"`
}
```

**Server validates:**
- `envelope_version` is reasonable (≤ 1024 wraps)
- Each wrap's `kind` is in an allowlist (`"recovery_phrase"` for v1;
  later `"passkey_prf"`, etc.)
- Each wrap's `ciphertext` is exactly 72 bytes (48 plaintext + 16 tag +
  8 length prefix in MLS-style varint encoding; will be 60 bytes if we
  use bare ChaCha20-Poly1305 AEAD without the length prefix — to be
  finalized in doc #3)
- Each wrap's `nonce` is exactly 24 bytes
- Each wrap's `kdf_salt` is exactly 16 bytes
- Total envelope size after JSON encoding ≤ 64 KB

**Server does NOT validate:**
- Whether the user knows the recovery phrase (it has no way to know)
- Whether the new wrap matches the wrap of a previous backup (it
  shouldn't — that's a privacy concern)

Errors returned:

- `envelope_too_large` — > 64 KB
- `envelope_conflict` — `expected_version` doesn't match server state
- `envelope_invalid` — schema violation

### 2.4 `backup_tier1_put` and `backup_tier1_put_ack`

Upload a tier-1 (identity) backup blob. Tier 1 is small (≤ 64 KB per Q3)
and ships in a single frame.

```go
type BackupTier1PutPayload struct {
    // SourceDeviceID is the device that produced this backup.
    // Server stores it; new devices use it for smart-restore.
    SourceDeviceID string `json:"source_device_id"` // UUID

    // CreatedAt is the unix-ms timestamp the backup was assembled.
    // Server may correct it within 5 minutes of its own clock; if
    // skew is larger, server rejects (clock issue on client).
    CreatedAt int64 `json:"created_at"`

    // EnvelopeVersion is the version of the envelope this backup
    // was encrypted with. If the server has a newer envelope version
    // (e.g. user just rotated), it still accepts but logs a warning;
    // the backup will be decryptable using grace-period wraps.
    EnvelopeVersion int `json:"envelope_version"`

    // Schema is the on-disk format version inside the encrypted
    // blob. Allows future format upgrades without changing this
    // wire frame. v1 in phase 11d.
    Schema int `json:"schema"`

    // Ciphertext is AEAD(backup_master_key, nonce, aad, tier1_blob).
    Ciphertext string `json:"ciphertext"` // base64

    // Nonce is the AEAD nonce. 24 bytes.
    Nonce string `json:"nonce"` // base64
}

type BackupTier1PutAckPayload struct {
    // BackupID is the server-assigned ID for this backup row.
    BackupID string `json:"backup_id"` // UUID
}
```

**Server validates:**
- `ciphertext` length ≤ 64 KB
- `nonce` is exactly 24 bytes
- `source_device_id` is a known device for the calling user
- `created_at` within ±5 minutes of server clock
- Total user backup count (across all tiers) ≤ N (=5 per D6); if at
  limit, drop the oldest

Errors:

- `backup_too_large` — > 64 KB
- `backup_invalid_device` — `source_device_id` unknown for user
- `backup_clock_skew` — `created_at` too far from server time

### 2.5 `backup_tier1_get` and `backup_tier1_get_ack`

Download tier-1.

```go
type BackupTier1GetPayload struct {
    // BackupID may be empty to request "latest tier 1 for this user."
    BackupID string `json:"backup_id,omitempty"`
}

type BackupTier1GetAckPayload struct {
    BackupID        string `json:"backup_id"`
    SourceDeviceID  string `json:"source_device_id"`
    CreatedAt       int64  `json:"created_at"`
    EnvelopeVersion int    `json:"envelope_version"`
    Schema          int    `json:"schema"`
    Ciphertext      string `json:"ciphertext"`
    Nonce           string `json:"nonce"`
}
```

Errors:

- `backup_not_found` — BackupID doesn't exist or doesn't belong to user

### 2.6 Tier-2 chunked upload: `backup_tier2_put_init/chunk/finish`

Tier 2 is up to 16 MB (per Q3). We chunk it. Chunk size is fixed at 256 KB
to stay well under the WS frame size limits (chalk's `make dev` config
doesn't impose tight limits, but production deployments often cap WS
frames at 1 MB).

```go
type BackupTier2PutInitPayload struct {
    SourceDeviceID  string `json:"source_device_id"`
    CreatedAt       int64  `json:"created_at"`
    EnvelopeVersion int    `json:"envelope_version"`
    Schema          int    `json:"schema"`

    // TotalBytes is the ciphertext length (NOT plaintext). Used by
    // the server to pre-allocate, sanity-check chunk arrival, and
    // reject upfront if too large.
    TotalBytes int `json:"total_bytes"`

    // ChunkSize is the agreed-on chunk size, ≤ 256 KB.
    ChunkSize int `json:"chunk_size"`

    // Nonce for the AEAD covering the FULL ciphertext (not per-chunk).
    // The blob is encrypted as one logical unit; chunking is just
    // transport.
    Nonce string `json:"nonce"`
}

type BackupTier2PutInitAckPayload struct {
    // UploadID is opaque; the client passes it back in each chunk.
    UploadID string `json:"upload_id"`

    // ChunkCount is the expected number of chunks (TotalBytes /
    // ChunkSize, rounded up).
    ChunkCount int `json:"chunk_count"`
}

type BackupTier2PutChunkPayload struct {
    UploadID string `json:"upload_id"`

    // Index is 0-based. Server validates monotonic-ascending.
    Index int `json:"index"`

    // Data is base64'd raw ciphertext bytes. Last chunk may be
    // shorter than ChunkSize.
    Data string `json:"data"`
}

// No ack for individual chunks (would 2x the round trips). Server
// either accepts the chunk silently or sends a backup_tier2_put_abort
// push if anything's wrong.

type BackupTier2PutFinishPayload struct {
    UploadID string `json:"upload_id"`

    // Sha256 is the SHA-256 of the FULL ciphertext, base64'd.
    // Server verifies; if mismatch, rejects.
    Sha256 string `json:"sha256"`
}

type BackupTier2PutAckPayload struct {
    // BackupID is the server-assigned ID for the completed backup.
    BackupID string `json:"backup_id"`
}

// Sent by server only on failure; otherwise client gets a normal
// backup_tier2_put_ack at the end.
type BackupTier2PutAbortPayload struct {
    UploadID string `json:"upload_id"`
    Reason   string `json:"reason"`   // human-readable
    Code     string `json:"code"`     // machine-readable
}
```

**Upload state machine:**

```
client                                      server
  │                                            │
  ├──── backup_tier2_put_init ────────────────►│
  │                                            │ (allocate upload slot)
  │◄─── backup_tier2_put_init_ack ─────────────┤
  │                                            │
  ├──── backup_tier2_put_chunk (0) ───────────►│
  ├──── backup_tier2_put_chunk (1) ───────────►│
  ├──── backup_tier2_put_chunk (2) ───────────►│
  │     ...                                    │
  ├──── backup_tier2_put_chunk (N-1) ─────────►│
  │                                            │
  ├──── backup_tier2_put_finish ──────────────►│
  │                                            │ (verify sha256, commit)
  │◄─── backup_tier2_put_ack ──────────────────┤
  │                                            │
```

If client disconnects mid-upload, server reaps the upload slot after a
30-second timeout. Client can re-init and re-upload (no resume semantics
in v1 — re-uploading 16 MB is cheap enough).

**Server validates:**

- `total_bytes` ≤ 16 MB
- `chunk_size` ≤ 256 KB
- Each `index` is exactly `previous + 1`, starting at 0
- Each chunk's `data` length matches `chunk_size` (except last chunk
  which is ≤ chunk_size)
- Final `sha256` matches the concatenation of all chunks
- `source_device_id` belongs to the calling user

Errors (via `backup_tier2_put_abort`):

- `upload_too_large` — total_bytes > 16 MB
- `upload_chunk_size_too_large` — chunk_size > 256 KB
- `upload_chunk_out_of_order` — non-monotonic index
- `upload_chunk_wrong_size` — chunk data length mismatch
- `upload_sha256_mismatch` — final hash doesn't match
- `upload_timeout` — > 30 seconds between chunks

### 2.7 Tier-2 chunked download: `backup_tier2_get_init/chunk/finish`

Symmetric to upload. Direction reversed.

```go
type BackupTier2GetInitPayload struct {
    BackupID string `json:"backup_id,omitempty"` // empty = "latest tier 2"
}

type BackupTier2GetInitAckPayload struct {
    BackupID       string `json:"backup_id"`
    SourceDeviceID string `json:"source_device_id"`
    CreatedAt      int64  `json:"created_at"`
    EnvelopeVersion int   `json:"envelope_version"`
    Schema         int    `json:"schema"`
    TotalBytes     int    `json:"total_bytes"`
    ChunkSize      int    `json:"chunk_size"`
    ChunkCount     int    `json:"chunk_count"`
    Nonce          string `json:"nonce"`

    // DownloadID is opaque; server uses it to track in-flight
    // downloads (and to allow client to cancel via
    // backup_tier2_get_cancel if needed).
    DownloadID string `json:"download_id"`
}

// Server pushes these in order, monotonic indices.
type BackupTier2GetChunkPayload struct {
    DownloadID string `json:"download_id"`
    Index      int    `json:"index"`
    Data       string `json:"data"`
}

// Server pushes after the last chunk.
type BackupTier2GetFinishPayload struct {
    DownloadID string `json:"download_id"`
    Sha256     string `json:"sha256"`
}
```

### 2.8 `backup_list` and `backup_list_ack`

List all of the user's backups (metadata only — to let the smart-restore
flow pick the freshest per group).

```go
type BackupListPayload struct {
    // No fields. User implicit.
}

type BackupListAckPayload struct {
    Backups []BackupDescriptor `json:"backups"`
}

type BackupDescriptor struct {
    BackupID        string `json:"backup_id"`
    Tier            int    `json:"tier"`              // 1 or 2
    SourceDeviceID  string `json:"source_device_id"`
    CreatedAt       int64  `json:"created_at"`
    EnvelopeVersion int    `json:"envelope_version"`
    Schema          int    `json:"schema"`
    SizeBytes       int    `json:"size_bytes"`

    // Manifest is a small JSON object the source device wrote
    // alongside the backup; it summarizes WHICH groups are
    // covered by this backup and at what epoch. Used by smart-
    // restore to pick the freshest backup per group WITHOUT
    // downloading the full ciphertext.
    //
    // CRITICAL: manifest is NOT encrypted; it's metadata only.
    // It contains group_ids (random 16-byte values) and epochs,
    // which the server already knows from the mls_groups table.
    // So no new information leaks.
    Manifest BackupManifest `json:"manifest"`
}

type BackupManifest struct {
    Groups []BackupManifestGroup `json:"groups"`
}

type BackupManifestGroup struct {
    GroupID string `json:"group_id"`   // base64, 16 bytes
    Epoch   uint64 `json:"epoch"`
}
```

The manifest is the key to smart-restore (D6). When a new device wants to
restore, it calls `backup_list`, examines the manifests across all of the
user's backups (up to N=5), picks for each group the backup with the
highest `epoch`, downloads only those, and assembles a synthesized
restore. This is "per-device backup, smart-restore" in concrete protocol
terms.

---

## 3. Pairing family — field-by-field

The pairing flow runs between two devices of the SAME user, mediated by
the server which can only see the encrypted blobs.

**Overall flow:**

```
   OLD DEVICE (has full state)        SERVER          NEW DEVICE (blank)
        │                                │                   │
        │ (user taps "pair new device")  │                   │
        │                                │                   │
        ├──── pairing_offer ────────────►│                   │
        │                                │                   │
        │◄─── pairing_offer_ack ─────────┤                   │
        │     (returns pairing_id and    │                   │
        │      code material)            │                   │
        │                                │                   │
        │ (user reads code OR scans QR)  │                   │
        │ (code goes via out-of-band)    │                   │
        │                                │                   │
        │                                │◄── pairing_claim ─┤
        │                                │   (new device     │
        │                                │    submits code)  │
        │◄── pairing_event ──────────────┤                   │
        │   ("someone claimed your       │                   │
        │    offer with the code")       │                   │
        │                                │                   │
        │ (compute shared key from       ├── pairing_claim ─►│
        │  PAKE; encrypt master_key)     │   _ack            │
        │                                │                   │
        ├──── pairing_complete ─────────►│                   │
        │     (encrypted master_key)     │                   │
        │                                ├── (relay) ───────►│
        │                                │                   │
        │◄─── pairing_complete_ack ──────┤                   │
        │                                │                   │
```

### 3.1 `pairing_offer` and `pairing_offer_ack`

Old device offers to pair.

```go
type PairingOfferPayload struct {
    // OfferKind: "qr" or "pin"
    Kind string `json:"kind"`

    // EphemeralPublicKey is the X25519 public key the OLD device
    // is using for this pairing session. NEW device will combine
    // with its own ephemeral key (sent in pairing_claim) to derive
    // a shared secret via ECDH + HKDF.
    EphemeralPublicKey string `json:"ephemeral_public_key"` // base64, 32 bytes

    // For Kind="qr": OldDevice generates the 128-bit secret here,
    // includes it in the QR code. Field is empty in the WS payload
    // (the secret never travels over the WS).
    //
    // For Kind="pin": OldDevice generates a 6-digit code; field is
    // empty (server doesn't know the code).
    //
    // We deliberately do NOT transmit the secret/code via the WS
    // channel. It travels out-of-band (QR scan or user typing).
}

type PairingOfferAckPayload struct {
    // PairingID is the server-assigned identifier for this pairing
    // session. Old device shows it (or embeds it in the QR) so
    // the new device can find this specific offer.
    PairingID string `json:"pairing_id"`

    // ExpiresAt is unix-ms. After this time, the offer is reaped
    // server-side. Recommended: 5 minutes.
    ExpiresAt int64 `json:"expires_at"`
}
```

**QR encoding (informational, full spec in doc #6):**

The QR code, scanned by the new device, contains a URL like:
```
chalk://pair?id=<pairing_id>&epk=<old_eph_pubkey>&sec=<128-bit-random>&v=1
```

The `sec` is the 128-bit shared secret — generated by the old device,
embedded only in the QR (which never touches the network). The new device
reads it, never transmits it raw, but uses it as input to HKDF along with
the ECDH output.

**PIN encoding:**

For Kind="pin", the QR field is not used; instead the user reads a
6-digit code off the old device's screen and types it on the new device.
The 6-digit code is the PIN material in a SPAKE2+ exchange (or fallback
HKDF for a weaker construction; doc #6 will decide).

### 3.2 `pairing_claim` and `pairing_claim_ack`

New device claims an existing offer.

```go
type PairingClaimPayload struct {
    PairingID string `json:"pairing_id"`

    // EphemeralPublicKey from the NEW device.
    EphemeralPublicKey string `json:"ephemeral_public_key"` // base64, 32 bytes

    // ProofOfSecret is, for QR pairing, an HKDF-derived value that
    // proves the new device has the QR's 128-bit secret. Format:
    //   ProofOfSecret = HKDF-SHA256(
    //     ikm  = ECDH(new_eph_priv, old_eph_pub) || sec,
    //     info = "chalk.pair.v1.proof",
    //     len  = 32,
    //   )
    // The OLD device, knowing both ephemeral keys and the original
    // sec, recomputes this and compares.
    //
    // For PIN pairing, this field is a SPAKE2+ message instead;
    // exact shape in doc #6.
    ProofOfSecret string `json:"proof_of_secret"` // base64, 32 bytes
}

type PairingClaimAckPayload struct {
    // OldDeviceEphemeralPublicKey is relayed by the server from
    // the pairing_offer. NEW device needs it to compute ECDH on
    // its side too (it already has the QR-embedded one, but
    // server returns it again for sanity).
    OldDeviceEphemeralPublicKey string `json:"old_device_ephemeral_public_key"`
}
```

**Server validates:**
- `pairing_id` exists and hasn't expired
- Calling user matches the user who opened the offer
- This is the first claim on this pairing_id (concurrent claims are
  rejected; the offer accepts exactly one)

### 3.3 `pairing_event` (server push to OLD device)

When a new device claims an offer, the server pushes this to the OLD
device so it can verify the proof and proceed.

```go
type PairingEventPayload struct {
    PairingID string `json:"pairing_id"`

    // NewDeviceEphemeralPublicKey from the new device's
    // pairing_claim. Old device needs this to compute ECDH.
    NewDeviceEphemeralPublicKey string `json:"new_device_ephemeral_public_key"`

    // ProofOfSecret from the new device. Old device verifies.
    // If mismatch, old device sends pairing_cancel with reason
    // "proof_invalid" (could be wrong PIN, or attacker).
    ProofOfSecret string `json:"proof_of_secret"`

    // ClaimedAt is the server's timestamp of when the claim arrived.
    ClaimedAt int64 `json:"claimed_at"`
}
```

Old device, on receiving this:

1. Recompute `expected_proof` using its own ephemeral private + new
   device's ephemeral public + the QR/PIN secret.
2. Constant-time compare with `proof_of_secret`. If mismatch → send
   `pairing_cancel` with reason `proof_invalid`. (UI: show "pairing
   failed; try again.")
3. If match, derive a session key:
   ```
   pair_session_key = HKDF-SHA256(
     ikm  = ECDH(old_eph_priv, new_eph_pub) || sec,
     info = "chalk.pair.v1.session",
     len  = 32,
   )
   ```
4. Encrypt the `backup_master_key` (from local cache, per D2) under
   `pair_session_key` using XChaCha20-Poly1305.
5. Send `pairing_complete`.

### 3.4 `pairing_complete` and `pairing_complete_ack`

Old device sends the encrypted master_key to the new device via the
server.

```go
type PairingCompletePayload struct {
    PairingID string `json:"pairing_id"`

    // EncryptedMasterKey is AEAD(pair_session_key, nonce, aad,
    // backup_master_key). 32 bytes plaintext.
    EncryptedMasterKey string `json:"encrypted_master_key"` // base64
    Nonce              string `json:"nonce"`                // base64, 24 bytes

    // PairingMessage is a small JSON payload the old device
    // includes alongside the master key. Contains:
    //   - latest envelope_version
    //   - hint for where to find the latest backups
    //   - timestamp of pairing
    // Also encrypted under pair_session_key.
    PairingMessage string `json:"pairing_message"` // base64, encrypted
}

type PairingCompleteAckPayload struct {
    // Empty. Server has relayed to new device.
}
```

**Server immediately relays as a push to the new device** (which is
waiting on its `pairing_claim_ack`). New device decrypts with its own
`pair_session_key`, obtains the `backup_master_key`, then proceeds to
download backups via `backup_list` + `backup_tier1_get` +
`backup_tier2_get_init`.

After the relay, the server reaps the pairing_id from its in-memory
table. No persistence of pairing state.

### 3.5 `pairing_cancel`

Either party can cancel.

```go
type PairingCancelPayload struct {
    PairingID string `json:"pairing_id"`
    Reason    string `json:"reason"`         // machine-readable
    Detail    string `json:"detail,omitempty"` // human-readable
}
```

Reasons:

- `user_cancelled` — user tapped cancel
- `proof_invalid` — wrong PIN/secret
- `timeout` — too slow
- `protocol_error` — unexpected frame, version mismatch

Server forwards the cancel to the other party (if connected), reaps the
pairing_id.

---

## 4. Multi-device family — field-by-field

These frames handle the post-pairing "new device announces itself to the
user's other devices, which then add it to all groups via MLS commits"
flow.

### 4.1 `device_announce` and `device_announce_ack`

After successful pairing-and-restore (OR successful recovery-words
restore), the new device announces itself.

```go
type DeviceAnnouncePayload struct {
    // NewDeviceID is the calling device's ID (new device).
    NewDeviceID string `json:"new_device_id"`

    // ClientID is the MLS client ID this device will use. By chalk
    // convention this is `${user_id}:${device_id}`.
    ClientID string `json:"client_id"`

    // OriginKind: "paired" (came via pairing flow) or "recovery"
    // (came via 24-word recovery flow). Lets other devices decide
    // how cautious to be (a recovery-based add deserves a UI
    // notification; a paired add might be silent since the user
    // just orchestrated it).
    OriginKind string `json:"origin_kind"`

    // Fingerprint is a SHA-256 of the new device's MLS signature
    // PUBLIC key, base64'd. Used by other devices to display
    // "the new device's fingerprint is X" in a notification UI,
    // so the user can verify they actually pair'd the device they
    // think they pair'd.
    Fingerprint string `json:"fingerprint"`
}

type DeviceAnnounceAckPayload struct {
    // FanoutCount is how many other devices received the event.
    FanoutCount int `json:"fanout_count"`
}
```

**Server stores** the new device row (devices table; new in phase 11d if
not already present) and pushes `device_announce_event` to all other
sessions for the same user.

### 4.2 `device_announce_event` (server push to OTHER devices)

```go
type DeviceAnnounceEventPayload struct {
    NewDeviceID string `json:"new_device_id"`
    ClientID    string `json:"client_id"`
    OriginKind  string `json:"origin_kind"`
    Fingerprint string `json:"fingerprint"`
    AnnouncedAt int64  `json:"announced_at"`
}
```

Receiving devices SHOULD:

1. Show a UI notification (toast or banner) "your account has a new
   device: <fingerprint>"
2. Begin the self-add flow: for each group this device is a member of,
   run `addClientsToConversation(group_id, [new_device_kp])` to bring
   the new device into the group at the current epoch.
3. The new device's KeyPackages must already be published (it does this
   immediately after restoring its keystore). Receiving devices fetch
   them via existing `fetch_key_packages`.

**Self-add is best-effort**: if a group isn't currently in the receiving
device's keystore (e.g. the receiving device itself is stale), it just
skips. The next device to come online and have the group covers it.

### 4.3 `device_list` and `device_list_ack`

List the user's known devices. For the "devices" settings panel.

```go
type DeviceListPayload struct {
    // No fields.
}

type DeviceListAckPayload struct {
    Devices []DeviceDescriptor `json:"devices"`
}

type DeviceDescriptor struct {
    DeviceID    string `json:"device_id"`
    ClientID    string `json:"client_id"`
    Fingerprint string `json:"fingerprint"`
    AddedAt     int64  `json:"added_at"`
    LastSeenAt  int64  `json:"last_seen_at"`
    IsSelf      bool   `json:"is_self"` // true for the calling device
    Label       string `json:"label,omitempty"` // user-set, see device_label
}
```

### 4.4 `device_remove` and `device_remove_ack`

Remove a device from the user's account (e.g. lost phone, after the user
gets a new one).

```go
type DeviceRemovePayload struct {
    DeviceID string `json:"device_id"`
}

type DeviceRemoveAckPayload struct {
    // RemovedFromGroups is the number of groups this device was
    // removed from via MLS commits. Best-effort.
    RemovedFromGroups int `json:"removed_from_groups"`
}
```

**Server actions:**
1. Mark the device row as removed in the `devices` table.
2. Mark any pending KeyPackages for the device as unusable.
3. Push `device_removed_event` to OTHER devices of the user (not
   speccing this push frame in detail here; doc #5 will).
4. Other devices, on receiving the event, run
   `removeClientsFromConversation` to actually evict the device from
   each group cryptographically.

**Caveat**: removing a device from MLS groups only takes effect for
future epochs. Messages encrypted under the epoch BEFORE removal remain
decryptable by the removed device if its keystore wasn't wiped. This is
inherent to MLS post-compromise security.

---

## 5. Error codes (new in phase 11d)

All errors follow chalk's existing convention: `frame_type=error`,
payload `{code: string, message: string, ref: string}`.

New codes:

| Code | Frame context | Meaning |
|------|---------------|---------|
| `envelope_too_large` | backup_envelope_put | > 64 KB |
| `envelope_conflict` | backup_envelope_put | expected_version mismatch |
| `envelope_invalid` | backup_envelope_put | schema violation |
| `backup_too_large` | backup_tier1_put, tier2_put_init | exceeds tier ceiling |
| `backup_invalid_device` | backup_*_put | source_device_id unknown |
| `backup_clock_skew` | backup_*_put | created_at outside ±5 min |
| `backup_not_found` | backup_*_get | backup_id unknown |
| `upload_too_large` | backup_tier2_put_init | total_bytes > 16 MB |
| `upload_chunk_out_of_order` | backup_tier2_put_chunk | non-monotonic |
| `upload_chunk_wrong_size` | backup_tier2_put_chunk | size mismatch |
| `upload_sha256_mismatch` | backup_tier2_put_finish | hash mismatch |
| `upload_timeout` | (push only) | > 30 s between chunks |
| `pairing_not_found` | pairing_claim, _complete | pairing_id unknown/expired |
| `pairing_already_claimed` | pairing_claim | another device claimed first |
| `pairing_proof_invalid` | (push only) | proof mismatch, from old device |
| `pairing_expired` | (any pairing) | offer past expires_at |
| `device_not_found` | device_remove | device_id unknown |
| `device_remove_self` | device_remove | can't remove the calling device |

---

## 6. Server-side resource limits

These are sanity limits to prevent abuse. Recommended starting values:

- Envelope size ≤ 64 KB.
- Envelope wraps count ≤ 1024.
- Tier 1 ciphertext ≤ 64 KB.
- Tier 2 ciphertext ≤ 16 MB.
- Tier 2 chunk size ≤ 256 KB.
- Tier 2 upload timeout: 30 s between chunks.
- Backups per user (all tiers): N=5 (D6). When at limit, server drops
  oldest at next put.
- Pairing offers per user: ≤ 3 concurrent. Server rejects new offers
  beyond this.
- Pairing offer TTL: 5 minutes.
- Pairing session in-memory state lifetime: 5 minutes.
- Devices per user: ≤ 32. Hitting this requires removing a device.
- KeyPackages per device per ciphersuite: ≤ 100. (Already enforced in
  phase 11a; mentioned for completeness.)

These limits are tweakable; expose them as chalkd config flags.

---

## 7. No HTTP endpoints in phase 11d

Per Q4=a, pairing and backup both use WS frames. No new HTTP endpoints
are introduced.

**Rationale**: chalk's existing HTTP endpoints are only for auth flows
(passkey ceremony, recovery login) and prefs. Adding HTTP endpoints for
backup/pairing would split the protocol surface unnecessarily. WS gives
us push for pairing_event and device_announce_event for free; HTTP would
require polling or a separate notification channel.

**Future consideration**: very large backups (rare in v1, possible in
later phases) might benefit from HTTP for resumable uploads. Punt to a
later phase if/when this becomes necessary.

---

## 8. Frame count summary

Phase 11d adds **30 new wire types** to chalk:

- 16 backup family
- 8 pairing family
- 6 multi-device family

(Plus the `*_abort`, `*_event`, error variants.)

For comparison, phase 11b-1 added 5 frames (key package family) and 4
(MLS DM family). Phase 11d is roughly 3× the protocol surface of 11b.

The frames are largely independent — backup family doesn't reference
pairing family, etc. — so they can be implemented in independent landings:

- **Land 1**: envelope + tier-1 backup put/get (smallest useful slice;
  enables the silent background snapshot without any restore path)
- **Land 2**: tier-2 chunked upload/download
- **Land 3**: backup_list with manifest
- **Land 4**: pairing family (depends on Lands 1-3 to have something to
  pair)
- **Land 5**: device_announce + device_announce_event + self-add flow
- **Land 6**: device_list + device_remove

This ordering is suggested for doc #8 (migration & test plan).

---

## 9. Open questions for resolution before doc #3

**Q6.** Exact ciphertext framing for AEAD outputs.

XChaCha20-Poly1305 outputs ciphertext + 16-byte authentication tag.
Should we concatenate `(ciphertext || tag)` and base64 the result, or
keep them separate fields? Existing chalk MLS code concatenates. Lean
toward consistency.

**Q7.** Manifest tampering risk.

The `BackupDescriptor.Manifest` is NOT encrypted (so the server can
prune backups, smart-restore can read it without decrypting). The
server could lie about a manifest — claim "this old backup covers
recent epochs" when it doesn't.

Mitigation: include the manifest as AAD in the backup blob's AEAD. The
client, after downloading and decrypting, verifies the manifest matches
what the server reported. If mismatch → server is lying → don't trust.

Decision: yes, do this. Affects doc #3 (serialization format).

**Q8.** Should `device_announce_event` include the new device's MLS
KeyPackage directly, or just trigger a `fetch_key_packages` from
receiving devices?

Including it inline saves a round trip. Fetching separately is more
uniform with the existing flow. Doc #5 (client state machines) will
decide.

**Q9.** Self-add commit fanout: do all receiving devices race to
self-add the new device, or do they coordinate?

In a 1-user-3-device household, when device-4 joins, devices 1, 2, 3
all receive `device_announce_event`. If all three try to
`addClientsToConversation(group_id, [device_4_kp])` simultaneously, MLS
will reject all but one (only one wins the epoch race). The losers'
operations roll back gracefully, but it's wasted work and bandwidth.

Two approaches:
- Random staggered delay (each device waits a random 0-30s before
  attempting)
- Server-coordinated: server picks one designated "self-adder" per
  group, others wait

Lean toward random delay for simplicity; coordinated approach can be a
later optimization.

**Q10.** Old-pairing-offer cleanup.

If old device opens a pairing offer, then crashes (closes WS) before
the new device claims, the offer sits in server memory for 5 minutes.
Acceptable. But: when old device reconnects, should we surface "you
have an unclaimed pairing offer" so the user knows to cancel or
complete it? Tiny UX consideration. Punt to doc #5.

---

## 10. Summary

Doc #2 is concrete: 30 frame types, exact JSON shapes, exact resource
limits, exact error codes. Once approved, doc #3 (keystore serialization)
defines what goes INSIDE the encrypted blobs that this wire protocol
ferries.

Open questions Q6-Q10 are smaller than Q1-Q5 from doc #1 were. Most can
be resolved with one-liner decisions. Q7 in particular is important
(manifest tampering) and worth confirming the proposed mitigation.

End of doc #2. Vienna 2026-05-27.
