# Phase 11d Design Doc #3 — HistorySecret Serialization & Restore Flow

**Status:** Draft for review
**Author:** Claude, per scuq's design choices
**Date:** 2026-05-27 (Vienna)
**Scope:** chalk phase 11d — encrypted serialization format for
HistorySecrets and the export/import procedures around them
**Depends on:** doc #1 (threat model), doc #2 (wire protocol)

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
- An `EpochObserver` registered on the CoreCrypto session, populating
  a local per-conversation `epochCache: Map<ConversationId, uint64>`.
  Maintained continuously across the session lifetime.

If any pre-condition fails:
- **No master_key**: queue the secret locally (see §4.4) for later
  upload once master_key becomes available. The user has not yet set
  up phase-11d backups; UI should prompt them. Failing entirely to
  upload until setup completes is acceptable because no new device can
  restore anyway without the master_key.
- **CoreCrypto unhealthy**: extremely unlikely (the observer fires
  from inside CoreCrypto); log and emit a
  `history_uploads_persistently_failing` critical event candidate if
  it happens repeatedly.
- **No network**: queue the secret in localStorage for later upload.
  See §4.4.
- **No cached epoch for the conversation**: this should not happen if
  the EpochObserver was registered before the first commit on the
  conversation. If it does (e.g. observer registered late), the
  client may fall back to querying `cc.conversationEpoch()` OUTSIDE
  the observer (i.e. in a `setTimeout(..., 0)` or microtask
  scheduled FROM the observer), accepting the risk that the value
  read at that later time may have already advanced. See §4.5 for
  the failure mode.

### 4.2 Why the epoch comes from a separate observer

CoreCrypto's `HistoryObserver.historyClientCreated()` is invoked from
inside CoreCrypto's conversation-guard lock. Calling back into
CoreCrypto (e.g. `cc.conversationEpoch(conversationId)`) from inside
the observer risks deadlock or unspecified re-entrancy behavior.
CoreCrypto's `EpochObserver` documentation explicitly warns:
"The `epochChanged` callback must return promptly. CoreCrypto holds
internal locks while dispatching it."

We therefore use a two-observer pattern:

1. **`EpochObserver`** runs continuously. On every `epochChanged`
   callback, update a synchronous in-memory cache:
   `epochCache.set(conversationId, newEpoch)`. The callback returns
   promptly without further async work.

2. **`HistoryObserver`** synchronously looks up the cached epoch when
   it fires. No callbacks into CoreCrypto.

The ordering invariant we rely on: when `enableHistorySharing` triggers
a commit, CoreCrypto merges the commit (advancing the epoch) BEFORE
calling the HistoryObserver. The EpochObserver fires on the merge,
populating the cache. Then the HistoryObserver fires, reading the now-
correct cached epoch.

**This ordering is assumed but not formally verified.** CoreCrypto's
source code structure suggests it (both observers are dispatched
from the same session lock), but no documentation explicitly
guarantees the ordering. Integration testing in chalk's
implementation must verify this empirically before relying on it for
production. If the ordering turns out NOT to hold, the fallback is
§4.5: defer epoch-read to a microtask outside the observer.

### 4.3 Step-by-step

```
ON_HISTORY_CLIENT_CREATED(conversationId, historySecret):

  # ---- 1. Capture the secret synchronously ----
  # copyBytes() and Uint8Array() must happen before any async/await,
  # because CoreCrypto may free the underlying WASM memory after the
  # observer returns.
  clientIdBytes = historySecret.clientId.copyBytes()
  dataBytes     = new Uint8Array(historySecret.data)

  # ---- 2. Look up epoch from synchronous cache ----
  eraEpoch = epochCache.get(conversationId)
  if eraEpoch == undefined:
    # See §4.5 for the deferred fallback path. For now: queue
    # without era_epoch and try to resolve later.
    queueSecretAwaitingEpoch({clientIdBytes, dataBytes, conversationId, ...})
    return

  # ---- 3. Queue for upload AFTER commit ack ----
  # CRITICAL: the commit that introduced this history client may
  # still be rejected by the delivery service. If we upload now and
  # the commit is later rejected, the secret references an era that
  # never happened (chalkd would carry junk).
  #
  # Per D11: enqueue the encrypted secret, then defer upload until
  # MlsTransport.sendCommitBundle returns success for the originating
  # commit.

  # Build CBOR plaintext
  plaintext = cborEncode({
    schema_version: 1,
    client_id: clientIdBytes,
    data: dataBytes,
  })

  # AEAD encrypt
  nonce = randomBytes(24)
  aad = utf8("chalk.history.v1")
      || userIdBytes(16)
      || conversationIdBytes(16)
      || u64_be(eraEpoch)
  ciphertext = xchacha20poly1305_encrypt(backup_master_key, nonce, aad, plaintext)

  # Queue
  pendingUploads.add({
    conversation_id: uuid_from_bytes(conversationId.copyBytes()),
    era_epoch: eraEpoch,
    envelope_version: currentEnvelopeVersion,
    ciphertext: base64(ciphertext),
    nonce: base64(nonce),
    created_at: nowUnixMs(),
    source_device_id: thisDeviceId,
    awaiting_commit_for: currentCommitId,  # tracks which commit must succeed
  })


# The commit-success callback path (called from MlsTransport.sendCommitBundle
# success branch):
ON_COMMIT_ACK(commitId):
  toUpload = pendingUploads.filter(p => p.awaiting_commit_for == commitId)
  for upload of toUpload:
    pendingUploads.remove(upload)
    try:
      ack = await ws.request("history_secret_put", upload)
    except:
      # Network error: re-queue with localStorage backing
      localStorage.set(`chalk.history.upload_queue.${upload.source_device_id}.${uuid()}`,
                       JSON.stringify(upload))


# The commit-rejected callback path:
ON_COMMIT_REJECTED(commitId):
  # Drop pending uploads for this commit. CoreCrypto will retry
  # with a new history client (and a new observer fire).
  pendingUploads = pendingUploads.filter(p => p.awaiting_commit_for != commitId)
```

The discipline here is **upload only after the originating commit is
acknowledged by the delivery service**. This matches D11 and avoids
storing secrets for eras that never materialize.

### 4.4 Offline queueing

If the client captures a HistorySecret while offline OR while the
commit acknowledgment is pending across a session restart, the
encrypted ciphertext is stored in localStorage:

```
key:   "chalk.history.upload_queue.<sourceDeviceId>.<uuid>"
value: JSON({
  conversation_id, era_epoch, envelope_version,
  ciphertext, nonce, created_at, source_device_id,
})
```

When connectivity returns OR the session resumes:
1. Enumerate all `chalk.history.upload_queue.*` keys.
2. For each, send `history_secret_put`.
3. On success, delete the localStorage entry.

A queued upload that crosses session boundaries cannot be linked back
to its originating commit (the commit ack came and went while we
were offline). Two policies are possible:
- **Strict**: drop queued uploads on session restart. Some history
  may be lost.
- **Lenient**: send the queued upload regardless; trust that the
  commit was acked previously (since the secret made it into the
  observer at all, the commit had local merge success — the only
  question is DS acknowledgment).

Recommendation: lenient policy with a flag in the queued entry
(`crossed_session_boundary: true`) so the server can log it and ops
can investigate if it correlates with missing-conversation issues.

If multiple devices queue the same `(user_id, conversation_id, era_epoch)`
secret, the server's UPSERT semantics (Q17 in doc #1) resolve the
duplicate. Last-write-wins; both ciphertexts encrypt the same
plaintext under master_key.

### 4.5 Epoch-lookup fallback

If the EpochObserver hasn't populated the epoch cache for a
conversation by the time the HistoryObserver fires (because the
EpochObserver was registered late, or in case the assumed ordering
between the two observers doesn't hold), the secret is queued
without an era_epoch and processed asynchronously:

```
DEFERRED_EPOCH_RESOLUTION:
  for entry in awaitingEpochQueue:
    # Schedule outside the observer execution context
    setTimeout(async () => {
      try:
        eraEpoch = await cc.conversationEpoch(entry.conversationId)
        # Continue with normal encrypt-and-queue path
        ...
      catch (err):
        # Could not resolve the epoch (conversation gone, error, etc.)
        # Log and drop.
        log.warn("could not resolve era_epoch for queued secret", entry, err)
    }, 0)
```

**This path is a degraded mode.** The epoch read at deferred-resolution
time may have already advanced past the era the secret represents,
producing a wrong AAD on encryption. Future devices restoring would
hit AEAD authentication failure on this secret and have to skip it.

Mitigation: register the EpochObserver as the very first step of
chalk's CoreCrypto initialization, BEFORE any conversation activity.
This eliminates the late-registration case. Then the only way to hit
this fallback is if the assumed observer ordering doesn't hold —
which integration testing must verify.

### 4.6 prepareForTransport callback

Separate from but adjacent to the HistoryObserver. CoreCrypto invokes
`MlsTransport.prepareForTransport(secret)` when it's about to encrypt
the secret as an MLS application message bundled into the commit.

**Security note**: chalk's implementation deliberately returns DUMMY
bytes rather than the real HistorySecret data, to neutralize the
in-band delivery path. See doc #1 §8.2 for the threat model. The
in-band path would otherwise let any current group member persistently
decrypt past messages even after being removed from the conversation,
which defeats post-compromise security.

```typescript
async prepareForTransport(secret: HistorySecret): Promise<MlsTransportData> {
  // Return 32 random bytes as the "transportable" representation.
  // CoreCrypto will encrypt these as an MLS application message
  // bundled into the commit. Receiving members can decrypt them but
  // they're meaningless — the real HistorySecret travels exclusively
  // via our out-of-band history_secret_put / history_secret_get flow,
  // encrypted under backup_master_key (which only the user's own
  // devices know).
  //
  // Why we still need to return SOMETHING: CoreCrypto requires the
  // callback to produce bytes; the in-band MLS application message
  // is part of the protocol invariant. Returning empty bytes would
  // likely cause CoreCrypto errors.

  const dummy = new Uint8Array(32);
  crypto.getRandomValues(dummy);
  return new CC.MlsTransportData(dummy);
}
```

The legitimate transfer of the actual HistorySecret happens via the
HistoryObserver path (this device captures the secret, encrypts under
master_key, uploads via `history_secret_put` per §4.3). Only the
user's own devices that hold master_key can decrypt the uploaded
ciphertext.

**Receiver-side behavior**: CoreCrypto's `decrypt_message` will
successfully decrypt the dummy bytes (they're a valid MLS application
message), and the receiving application (also chalk) sees 32 random
bytes. chalk's incoming-message handler must recognize these as
non-content (they don't match chalk's normal message envelope format)
and ignore them. Doc #5 (client state machines) will specify the
"ignore application messages that don't match the chalk envelope"
rule for incoming-message handling.

**Sandbox validation note**: tests A, B, C2 on 2026-05-27 used the
real secret.data bytes from `prepareForTransport`. The dummy-bytes
variant was not directly tested. Chalk's implementation should add
an integration test that verifies:
1. Sender returns dummy bytes
2. Receiver decrypts them without errors
3. Receiver's chalk envelope handler ignores them gracefully
4. The OUT-of-band history_secret_put / get path still works
   end-to-end

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
conversation, chalk must figure out which CoreCrypto instance — a
per-era history-client or the regular session CoreCrypto — can
decrypt each message.

Important observation about MLS membership and eras:
- Adding a member (the new device joining) does NOT trigger a new
  history-sharing era. Only member REMOVALS and the ~daily rotation
  do.
- So after the new device joins, the last existing era's history
  client continues to be the authoritative decryptor for that
  conversation, until the next era boundary.
- The regular session CoreCrypto can only decrypt epochs it was a
  member during. For the new device, that's everything from its
  join-welcome epoch onward — which is a subset of the last era's
  span.

Approach: store the era boundaries per conversation. For each
incoming message, look at its MLS epoch (visible in the message
metadata) and pick a decryptor:

```
decryptorFor(conversationId, messageEpoch):
  # eras = sorted ascending by era_epoch
  eras = getEras(conversationId)

  # Find the era covering this message epoch
  for i, era of eras:
    nextEra = eras[i+1]
    if messageEpoch >= era.era_epoch AND (nextEra == null OR messageEpoch < nextEra.era_epoch):
      # We have a history client for this era. It can decrypt.
      return era.historyClient

  # messageEpoch is before the first era we know about — i.e. before
  # history sharing was enabled. Not decryptable. (Doc #1 §4.1.)
  return null
```

**The regular session CoreCrypto is not in this routing path.** It
COULD also decrypt messages from epochs it was a member during, but
the corresponding history client covers the same span and is the
primary decryptor. This keeps routing logic simple at the cost of
slightly redundant decryption capability.

If we wanted to optimize: messages from the join-welcome epoch onward
could be routed to the regular CoreCrypto (which has them in its
keystore already and decrypts faster than spinning up a history
client). But this is an optimization, not a correctness concern.
Defer to implementation tuning.

The era boundaries are implicit in the list of secrets returned by
`history_secret_list`; the client builds the routing table from
that during restore.

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

Two evolution axes need consideration: **our format** (the encrypted
payload we control) and **CoreCrypto's HistorySecret format** (which
we treat as opaque but is itself versioned by Wire).

### 6.1 Our format

- `schema_version` at the top of the CBOR plaintext (currently 1).
  Future format changes bump this. Old clients on receiving a higher
  version reject with a clear "client out of date" error.
- The AAD prefix is `"chalk.history.v1"`. Future incompatible AAD
  changes use `"chalk.history.v2"` etc. Old ciphertexts continue
  decrypting under the v1 verifier so a mixed-version deployment can
  read both.
- The envelope (doc #2 §2) already has its own version field for
  envelope-format evolution, orthogonal to per-secret format.

### 6.2 New wrap kinds

The envelope `wrap.kind` field starts with `"recovery_phrase"` in v1.
Future kinds (passkey_prf, hardware key, social recovery) are added
without breaking v1. Each new kind needs a corresponding KDF +
client-side derivation; the envelope structure is forward-compatible
by design.

### 6.3 CoreCrypto HistorySecret format evolution

This is the harder forward-compat question. Our wire/storage format
treats `data` as opaque bytes — we never parse the inner MessagePack
format. As long as CoreCrypto's `historyClient(secret)` continues to
accept the bytes we hand it, we're fine.

The risk surface:

1. **CoreCrypto upgrades break old `data` blobs.** A chalk user has
   secrets stored under CoreCrypto vN. Chalk later upgrades to vN+1.
   The user's secrets in chalkd were encoded by vN; vN+1's
   `historyClient` may not accept them.

2. **CoreCrypto removes or renames the API.** `enableHistorySharing`
   or `historyClient` could disappear. There's nothing in our format
   that protects against this; we'd need to maintain our own
   compatibility shim or stay pinned to the old CoreCrypto.

3. **CoreCrypto changes the `clientId` format.** Currently the
   convention is `"history-client-<uuid>"` (51 bytes). If CoreCrypto
   changes this, our 51-byte expectation in size estimates is wrong
   but our format (which records the actual bytes verbatim) survives.

4. **`HistorySecret` gains new fields.** A future CoreCrypto might
   add fields beyond `{clientId, data}`. Our CBOR plaintext has a
   `schema_version` that can be bumped to carry additional fields.
   Old secrets stored at v1 still work with `historyClient` because
   the new fields would be optional from CoreCrypto's perspective.

Mitigations we adopt:

- **Pin CoreCrypto version per chalk release.** chalk's package.json
  pins `@wireapp/core-crypto` exactly. Upgrades are deliberate,
  release-gated changes, with migration testing.

- **Validate on upload + restore.** When uploading a HistorySecret,
  record the CoreCrypto version that produced it in the
  HistorySecretPutPayload — a new field
  `producing_corecrypto_version: string`. On restore, the new
  device's `historyClient()` call is best-effort; if it fails with a
  version-mismatch error, log the producing version and the
  consuming version for diagnosis.

- **Treat restored history as eventually-consistent.** If a CoreCrypto
  upgrade renders some old secrets unparseable, the user loses
  history for those eras on new devices. Existing devices that
  already restored work fine. The user-visible impact is "history
  before <date> is unavailable on this new device," surfaced via the
  restore_completed critical event's body.

- **In the worst case (API removed)**: chalk maintains its own fork
  of CoreCrypto pinned to the last-known-good version. Heavy but
  always available as an escape hatch.

Sandbox testing on 2026-05-27 used 9.3.4 in main; the main-branch
source we read (~CoreCrypto 10.x) has compatible types but a
restructured FFI layer. The on-the-wire `data` bytes appear to be
MessagePack-serialized in both — no observed format break between
those two reference points. Future CoreCrypto versions may break this.

### 6.4 Format-evolution checklist for chalk releases

When upgrading CoreCrypto in a future chalk release:
1. Verify the upgraded CoreCrypto's `historyClient()` accepts secrets
   produced by the old version (via an integration test).
2. If acceptance breaks, the upgrade is a breaking change. Either:
   - Migrate: have existing devices re-export their conversations'
     current history (no help for OLD eras, but new uploads work).
   - Skip the upgrade for now.
3. Update the `producing_corecrypto_version` validation rules in
   chalkd.
4. Surface the situation to users (critical event, in-app banner) so
   they know their old history may be lost on new devices.

This is operational discipline, not a magic format property.

---

## 7. Limitations

### 7.1 History before enable is unrecoverable

Same as doc #1 §4.1. If a conversation existed before history sharing
was enabled, no history client can decrypt the pre-enable messages.
Phase 11d's D10 (default-on at conversation creation) minimizes
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
