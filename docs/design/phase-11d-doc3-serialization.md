# Phase 11d Design Doc #3 — HistorySecret Serialization & Restore Flow

**Status:** Revision 3 (complete rewrite from previous revisions)
**Author:** Claude, per scuq's design choices
**Date:** 2026-05-27 (Vienna)
**Scope:** chalk phase 11d — encrypted serialization format for
HistorySecrets and the export/import procedures around them
**Depends on:** doc #1 rev 3 (threat model), doc #2 rev 3 (wire protocol)

**Previous revisions** (now obsolete in their entirety):
- rev 1 (2026-05-27 morning): defined a custom IndexedDB-export
  approach with tier-1 (identity bootstrap) and tier-2 (full keystore
  dump) blobs, store-by-store classification, chunked transport.
- rev 2 (2026-05-27 afternoon): refined the rev 1 design with
  chronological-order replay during restore (no per-row filtering)
  for format-independence from CoreCrypto's IndexedDB internals.

**This revision** discards both prior approaches in favor of
CoreCrypto's built-in history-client mechanism, sandbox-validated
in 9.3.4 + Node + fake-indexeddb on 2026-05-27. The new design is
substantially simpler.

---

## 1. What this document covers

The wire protocol (doc #2) defines HOW history secrets travel between
chalk clients and chalkd. This document defines:

- **WHAT** goes inside the encrypted HistorySecret payload that the
  wire protocol carries
- **WHEN** a client captures and uploads a HistorySecret (the export
  procedure)
- **HOW** a new device restores history from the stored secrets (the
  import procedure)
- The MlsTransport.prepareForTransport callback implementation
- The HistoryObserver implementation
- Known limitations and forward-compat hooks

What this document does NOT cover:
- The wire protocol itself (doc #2)
- Server-side schema and storage (doc #4, planned next)
- Client-side state machines for the broader flows (doc #5, planned)
- PAKE pairing detail (doc #6, planned)

---

## 2. Format choice: CBOR for encrypted payload

The encrypted HistorySecret payload uses **CBOR** (RFC 8949) for the
plaintext structure before AEAD encryption.

Rationale:
- The payload is dominated by binary fields (`client_id` ~51 bytes,
  `data` ~750 bytes of MessagePack from CoreCrypto). CBOR has
  first-class byte-string support, no base64 expansion.
- JSON would inflate the data field ~33% via mandatory base64
  encoding.
- TypeScript: `cbor-x` library, mature.
- Go: `github.com/fxamacker/cbor/v2`, mature.

Total CBOR overhead vs raw concatenation is ~10 bytes for our small
payloads. We accept it for self-description.

---

## 3. Encrypted payload layout

Each HistorySecret-as-stored is the AEAD output of:

```
plaintext = CBOR({
  schema_version: 1,
  client_id: <bytes ~51>,
  data: <bytes ~750>,
})

aad = "chalk.history.v1" || user_id_bytes(16) || conversation_id_bytes(16) || u64_be(era_epoch)

ciphertext = XChaCha20-Poly1305-Encrypt(
  key   = backup_master_key,
  nonce = <24 random bytes>,
  aad   = aad,
  plaintext = plaintext,
)
```

The wire frame (`history_secret_put`, doc #2 §3.2) carries
`ciphertext` and `nonce` as base64 strings, plus the `conversation_id`
and `era_epoch` in clear (so the server can index without decrypting).

The AAD binding ensures:
- A hostile chalkd cannot serve secret A as if it were secret B
  within the same user (different `era_epoch` in AAD).
- A hostile chalkd cannot serve user X's secret to user Y (different
  `user_id`).
- A hostile chalkd cannot swap a secret between conversations
  (different `conversation_id`).

Any tampering causes AEAD authentication failure on the new device
during restore.

### 3.1 Field details

| Field | Type | Notes |
|-------|------|-------|
| `schema_version` | uint | 1 in v1; allows future format evolution |
| `client_id` | bytes | Verbatim copy of `HistorySecret.clientId.copyBytes()`. ~51 bytes, UTF-8 of `"history-client-<uuid>"` |
| `data` | bytes | Verbatim copy of `HistorySecret.data`. ~750 bytes of MessagePack-serialized CoreCrypto state |

These two byte arrays are what `CoreCrypto.historyClient()` needs to
reconstruct a history-client CoreCrypto instance (sandbox-validated
test C2; see sandbox README).

### 3.2 Wire size estimate

| Component | Bytes |
|-----------|-------|
| CBOR overhead (header + 3 field tags) | ~10 |
| `schema_version` | 1 |
| `client_id` | ~51 |
| `data` | ~750 |
| **Plaintext total** | **~812** |
| AEAD nonce + tag | 24 + 16 = 40 |
| **Ciphertext total** | **~852** |
| Base64 inflation in JSON | × 1.33 |
| **JSON wire size** | **~1135 bytes** |

Comfortably under the 8 KB per-secret ceiling (doc #2 §3.2). The
ceiling exists only to defend against bug-induced bloat.

---

## 4. Export procedure (client → chalkd)

This is what a client does whenever its `HistoryObserver` fires.

### 4.1 Pre-conditions

The client must have:
- A `backup_master_key` available (cached per D2 or freshly derived
  from the recovery phrase)
- A live, healthy CoreCrypto session
- Network connectivity to chalkd

If any pre-condition fails:
- **No master_key**: log warning, drop the secret on the floor. The
  user has not yet set up phase-11d backups. The era's history will
  be unrecoverable for new devices for this era, but future eras
  will be uploaded once setup completes. UI should prompt the user
  to complete backup setup.
- **CoreCrypto issue**: extremely unlikely (the observer fires from
  inside CoreCrypto); log and emit a `history_uploads_persistently_failing`
  critical event candidate if it happens repeatedly.
- **No network**: queue the secret in localStorage for later upload.
  See §4.4.

### 4.2 Step-by-step

```
ON_HISTORY_CLIENT_CREATED(conversationId, historySecret):

  # ---- 1. Capture the secret ----
  clientIdBytes = historySecret.clientId.copyBytes()
  dataBytes     = new Uint8Array(historySecret.data)

  # CRITICAL: copyBytes() and Uint8Array() must happen before any
  # other async/await, because CoreCrypto may free the underlying
  # WASM memory after the observer returns.

  # ---- 2. Determine the era ----
  # The era_epoch is the MLS epoch at which this history client was
  # added to the conversation. Read it from CoreCrypto.
  eraEpoch = await cc.conversationEpoch(conversationId)
  # Note: this returns the CURRENT epoch, which is the epoch AT WHICH
  # the history client was just added (because enableHistorySharing
  # merged the commit before firing the observer).

  # ---- 3. Build CBOR plaintext ----
  plaintext = cborEncode({
    schema_version: 1,
    client_id: clientIdBytes,
    data: dataBytes,
  })

  # ---- 4. AEAD encrypt ----
  nonce = randomBytes(24)
  aad = utf8("chalk.history.v1")
      || userId.bytes()
      || conversationId.copyBytes()
      || u64_be(eraEpoch)
  ciphertext = xchacha20poly1305_encrypt(backup_master_key, nonce, aad, plaintext)

  # ---- 5. Upload via WS ----
  ack = await ws.request("history_secret_put", {
    conversation_id: uuid_from_bytes(conversationId.copyBytes()),
    era_epoch: eraEpoch,
    envelope_version: currentEnvelopeVersion,
    ciphertext: base64(ciphertext),
    nonce: base64(nonce),
    created_at: nowUnixMs(),
    source_device_id: thisDeviceId,
  })

  # ---- 6. Local cleanup ----
  # Note: we do NOT keep a local copy of the secret. The chalkd-stored
  # copy is the canonical record. If this device's IndexedDB is wiped,
  # we'll re-download from chalkd when restoring.
```

### 4.3 prepareForTransport callback

Separate from but adjacent to the HistoryObserver. CoreCrypto invokes
`MlsTransport.prepareForTransport(secret)` when it's about to encrypt
the secret as an MLS application message bundled into the commit.

```typescript
async prepareForTransport(secret: HistorySecret): Promise<MlsTransportData> {
  // The default Wire implementation packages the secret as JSON or
  // MessagePack for transit. For chalk, since we ALSO independently
  // upload the secret via history_secret_put on the observer side,
  // we don't strictly need the MLS-application-message path to do
  // anything useful. But CoreCrypto requires this callback to
  // produce *some* bytes, since they will be encrypted and sent.
  //
  // We return the raw HistorySecret.data bytes. They'll be encrypted
  // as MLS application message inside the commit and delivered to
  // existing group members. Existing members can ignore them
  // (they already have access to the keystore-internal version of
  // the same material; the in-band copy is redundant for them).

  return new CC.MlsTransportData(secret.data);
}
```

**Why we don't need the in-band path**: the `historyClient` mechanism
in CoreCrypto's design assumes the secret might be delivered to a new
device via the encrypted-app-message-in-commit pathway. In Wire's
architecture, a newly-added device's CoreCrypto could parse incoming
application messages and identify the history secret. In chalk, we
use a simpler architecture: the secret is uploaded server-side via
the dedicated `history_secret_put` family, and the new device fetches
from there. The in-band copy is functionally a no-op for us but must
still be present for CoreCrypto's protocol invariants.

### 4.4 Offline queueing

If the client captures a HistorySecret while offline, it must queue
it for later upload. We store the encrypted ciphertext in localStorage
under a queue key:

```
key: "chalk.history.upload_queue.<sourceDeviceId>.<uuid>"
value: JSON({
  conversation_id, era_epoch, envelope_version,
  ciphertext, nonce, created_at, source_device_id,
})
```

When connectivity returns:
1. Enumerate all `chalk.history.upload_queue.*` keys.
2. For each, send `history_secret_put`.
3. On success, delete the localStorage entry.

If multiple devices queue the same `(user_id, conversation_id, era_epoch)`
secret (e.g. both Alice's devices were online when she enabled history
sharing on a new conversation), the server's UPSERT semantics (per Q17
in doc #1) resolve the duplicate gracefully. Last-write-wins; both
ciphertexts encrypt the same plaintext under master_key.

---

## 5. Import procedure (chalkd → new device)

This is what a fresh device does after the user completes pairing or
recovery-phrase login.

### 5.1 Pre-conditions

The new device must have:
- A `backup_master_key` (received via pairing's `pairing_complete`,
  OR derived from the user-typed recovery phrase)
- A fresh CoreCrypto session for the user's regular MLS identity
  (instantiated normally via `deferredInit` + `mlsInit`)
- Network connectivity to chalkd

### 5.2 Step-by-step

```
IMPORT():

  # ---- 1. Enumerate available secrets ----
  ack = await ws.request("history_secret_list", {})
  # Optionally filter by conversation_id for incremental restore.

  if ack.secrets.empty():
    # No history secrets available. New device starts fresh; can't
    # read history for any conversation. Future participation works.
    log.info("no history secrets to restore")
    return ImportResult.NO_HISTORY

  # ---- 2. Group by conversation, sort by era ----
  byConv = groupBy(ack.secrets, s => s.conversation_id)
  for convId, secrets of byConv:
    secrets.sortBy(s => s.era_epoch)
    # Ascending era_epoch order ensures we apply eras chronologically
    # if the consumer-side flow cares (it doesn't strictly need to,
    # since each era is independent — but ordering helps with progress
    # UI and any future "show oldest messages first" feature).

  emitProgress({stage: "downloading history secrets", percent: 0, ...})

  # ---- 3. Download each ciphertext ----
  total = ack.secrets.length
  for i, descriptor of ack.secrets:
    getAck = await ws.request("history_secret_get", {secret_id: descriptor.secret_id})

    # ---- 4. Decrypt ----
    aad = utf8("chalk.history.v1")
        || userId.bytes()
        || conversationIdBytesFromUuid(descriptor.conversation_id)
        || u64_be(descriptor.era_epoch)
    try:
      plaintext = xchacha20poly1305_decrypt(
        backup_master_key,
        base64decode(getAck.nonce),
        aad,
        base64decode(getAck.ciphertext),
      )
    except AEADAuthError:
      # Server lied, OR backup is corrupt, OR wrong master_key
      # (wrong recovery phrase). Log and skip this secret.
      log.warn(`secret ${descriptor.secret_id} failed AEAD verification`)
      continue

    body = cborDecode(plaintext)
    assert body.schema_version == 1

    # ---- 5. Build the plain-object HistorySecret ----
    plainSecret = {
      clientId: new CC.ClientId(body.client_id),
      data: body.data,
    }

    # ---- 6. Instantiate the history client ----
    historyClient = await CC.CoreCrypto.historyClient(plainSecret)

    # ---- 7. Register the history client for decryption ----
    # We need to remember (conversation_id, era_epoch, historyClient)
    # so when the user views old messages in that conversation, we
    # know which history client to try for decryption.
    registerHistoryClient(descriptor.conversation_id, descriptor.era_epoch, historyClient)

    emitProgress({
      stage: `instantiating history clients (${i+1}/${total})`,
      percent: round((i+1) * 100 / total),
      items: i+1,
      totalItems: total,
    })

  # ---- 8. Done ----
  emitProgress({stage: "restore complete", percent: 100, terminal: true})
  return ImportResult.SUCCESS
```

### 5.3 Per-era decryption routing

A conversation may have many history eras. When the user opens an old
conversation, chalk must figure out which historyClient (or the
regular CoreCrypto, for messages from after the device joined) can
decrypt each message.

Approach: store the era boundaries per conversation. For each message,
look at its MLS epoch (visible in the message metadata) and pick:

```
clientFor(conversationId, messageEpoch):
  # Sort eras by era_epoch ascending. Each era covers
  # [era_epoch, next_era_epoch) — i.e. half-open interval.
  eras = getEras(conversationId)  # sorted ascending by era_epoch
  for i, era of eras:
    nextEra = eras[i+1]
    if messageEpoch >= era.era_epoch AND (nextEra == null OR messageEpoch < nextEra.era_epoch):
      return era.historyClient

  # If we get here, the message is from after the last era — i.e.
  # from after we (the current device) joined. Use the regular CC.
  return regularCoreCrypto
```

This is a client-side concern, not a wire protocol concern. The era
boundaries are implicit in the list of secrets returned by
`history_secret_list`.

### 5.4 Restore failure modes

| Failure | Recovery |
|---------|----------|
| AEAD authentication fails on all secrets | Wrong master_key (wrong recovery phrase or all wraps expired). Re-prompt for phrase. |
| AEAD fails on some secrets, succeeds on others | Mix of corrupt secrets and good ones. Log corrupt ones, proceed with good ones. The user will be missing decryption for some eras. |
| CBOR decode fails | Schema mismatch or corrupt plaintext. Should not happen; investigate. Treat as corrupt secret. |
| `body.schema_version` unknown (future version on old client) | Refuse to import; surface "your client is out of date" error to the user. |
| `CoreCrypto.historyClient()` throws | Could be invalid HistorySecret data, CoreCrypto version mismatch. Log secret_id for investigation; skip. |
| `history_secret_list` returns descriptors that fail to fetch via `history_secret_get` | Server inconsistency. Skip; report. |
| IndexedDB write errors during historyClient instantiation | Storage issue. Halt restore; report to user. |

The robustness goal is: as many partial successes as possible. A user
with 100 conversations should not have restore fail completely because
3 secrets are corrupt — they should get history for 97 conversations
and an indication that 3 had problems.

---

## 6. Forward compatibility

### 6.1 Reserved fields

- `schema_version` at the top of the CBOR plaintext (currently 1).
  Future format changes bump this. Old clients reject unknown values
  with a clear error.
- The AAD prefix is `"chalk.history.v1"`. Future incompatible AAD
  changes use `"chalk.history.v2"` etc. Old ciphertexts continue
  decrypting under the v1 verifier.
- The envelope (doc #2 §2) already has its own version field for
  envelope-format evolution, orthogonal to per-secret format.

### 6.2 New wrap kinds

The envelope `wrap.kind` field starts with `"recovery_phrase"` in v1.
Future kinds (passkey_prf, hardware key, social recovery) are added
without breaking v1. Each new kind needs a corresponding KDF +
client-side derivation; the envelope structure is forward-compatible
by design.

### 6.3 Eventual native CoreCrypto API

If a future CoreCrypto release exports `HistorySecret` as a proper
WASM class (i.e. constructible from JS), chalk can switch to using
the class directly. The wire format is unaffected — we always
serialize the same two byte arrays.

The current approach (plain-object `{clientId, data}` consumed via
`historySecretIntoFfi`) is sandbox-validated for 9.3.4 and survives
the FFI evolution shown in the main-branch source (where the FFI
takes plain `{client_id, data}` Rust struct fields too).

---

## 7. Limitations

### 7.1 History before enable is unrecoverable

Same as doc #1 §4.1. If a conversation existed before history sharing
was enabled, no history client can decrypt the pre-enable messages.
Phase 11d's D7-new (default-on at conversation creation) minimizes
this in new conversations. For existing chalk conversations created
before phase 11d ships, pre-upgrade history is lost to new devices —
unavoidable.

### 7.2 Cumulative storage cost

Same as doc #1 §4.3. A user with many active conversations
accumulates many history secrets. We accept the storage cost as a
fundamental trade-off for restore correctness. No pruning.

### 7.3 History client material = full era decryption power

Same as doc #1 §4.4. Each captured HistorySecret, in plaintext, can
decrypt every message of its era. We protect it under master_key in
storage. In memory (during restore), it's transient.

### 7.4 Untested-in-JS end-to-end

Same as doc #1 §4.5. Wire's JS test suite covers
`enableHistorySharing` (sender) but not `historyClient()` (receiver).
Chalk implementation will likely be the first JS consumer of the
full end-to-end flow. Sandbox tests A, B, C2 (Vienna 2026-05-27)
validate the API surface but not end-to-end past-message decryption.

Chalk implementation should add an integration test that exercises:
- Alice creates conv with history sharing
- Alice sends N messages
- Alice's "new device" (separate IndexedDB) restores via the
  observer-captured + uploaded secret
- New device decrypts the N messages via the history client

This test should run as part of phase 11d's CI before merge.

---

## 8. Backup_master_key lifecycle (recap from doc #1)

Restated here for self-containment. The master_key is the lynchpin of
the encrypted-storage model.

```
First-ever enable (phase 11d setup, one time per user):
  1. Client generates 32 random bytes → master_key
  2. Client derives kw_key = Argon2id(recovery_phrase || "chalk.backup.v1", salt, ...)
  3. Client AEAD-encrypts master_key under kw_key → wrap_ciphertext
  4. Client builds envelope = {version: 1, wraps: [{kind: "recovery_phrase", ...}]}
  5. Client uploads envelope via backup_envelope_put
  6. Client caches master_key in localStorage under device DB key
  7. Future history_secret_put calls use the cached master_key

Returning user on existing device:
  1. master_key found in localStorage cache (decrypted via device DB key)
  2. Use directly for history_secret_put

New device (post-restore-flow):
  1. Pairing: master_key arrives via pairing_complete (decrypted from PAKE session key)
  2. Recovery: user types phrase, kw_key derived, envelope downloaded,
     master_key unwrapped
  3. Cache in localStorage; use for all subsequent history_secret_get
     during restore

Rotation (user changes recovery phrase):
  1. User types old phrase → unwrap master_key
  2. User types new phrase → derive new kw_key
  3. Wrap master_key under new kw_key → new_wrap
  4. Mark old wrap with expires_at = now + 30 days
  5. Upload new envelope (now with 2 wraps)
  6. After 30 days, old wrap is server-pruned
```

The `master_key` itself never rotates in v1. If we ever need to
rotate it (e.g. compromise scenario), we'd re-encrypt every
HistorySecret under a new master_key — expensive but possible.
Reserved for a future hardening phase.

---

## 9. Open questions

**Q11 (carried over)**: Postcard parsing for signature keypair
extraction. ✅ Obsolete; we never extract anything from the keystore
in the new design.

**Q12 (carried over)**: Tier-2 deduplication. ✅ Obsolete; no tier-2.

**Q13 (carried over)**: Manifest privacy. ✅ Obsolete; no manifest.

**Q14 (carried over)**: Signing manifests. ✅ Obsolete; no manifest.

**Q18-Q19** (new in doc #2 rev 3): see doc #2 §13.

**Q20 (new)**: What if a user's recovery phrase is rotated DURING
restore (e.g. some secrets were encrypted under the old wrap, others
under the new)?

Resolution: the master_key doesn't change on rotation (only the wrap
does). All secrets remain decryptable with the single master_key the
restoring device unwrapped from the envelope. No special handling
needed.

**Q21 (new)**: Should we support cancelling a restore mid-flight?

Recommendation: yes. The restore is a long-running operation; user
might want to cancel if they realize they typed the wrong recovery
phrase. Cancellation is a client-side concern: stop sending
`history_secret_get` requests, dismiss the progress UI. No server
state to clean up. Doc #5 (client state machines) will spec.

---

## 10. Summary

Doc #3 rev 3 is **substantially smaller** than its predecessors
because the IndexedDB-export complexity is gone. We define:

- A simple CBOR-then-AEAD encrypted payload (~850 bytes) carrying
  CoreCrypto's HistorySecret bytes
- An export procedure that triggers on the HistoryObserver callback,
  encrypts, uploads via one wire frame
- An import procedure that downloads all secrets, decrypts, and
  instantiates one history-client CoreCrypto per era
- Format-evolution hooks (schema_version, AAD prefix versioning)

Sandbox tests (2026-05-27, see `/home/claude/sandbox-history/`)
validated the API surface in 9.3.4 + Node + fake-indexeddb. End-to-end
past-message decryption remains untested at the JS level; chalk
implementation should add this as an integration test.

Open questions Q18-Q21 are minor.

End of doc #3 revision 3. Vienna 2026-05-27.
