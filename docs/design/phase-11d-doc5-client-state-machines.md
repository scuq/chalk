# Phase 11d Design Doc #5 — Client State Machines

**Status:** Draft for review
**Author:** Claude, per scuq's design choices
**Date:** 2026-05-27 (Vienna)
**Scope:** chalk phase 11d — client-side state machines and
orchestration for backup setup, history-secret pipeline, restore,
pairing, recovery rotation, critical events, and device management
**Depends on:** doc #1 (threat model), doc #2 (wire protocol),
doc #3 (HistorySecret format & export/import), doc #4 (server schema)

This document specifies the client-side orchestration logic that ties
together the wire frames (doc #2), persistence patterns (doc #4), and
cryptographic primitives (doc #3). It is the implementation contract
for chalk's TypeScript client code paths.

State machines here are described as enumerated states + transition
tables + invariants. They're intended to translate directly to
TypeScript discriminated unions and a small dispatcher per flow.
Concrete code goes into landing PRs; this doc fixes the design.

---

## 1. Scope and conventions

### 1.1 Flows covered

Nine state machines, ordered by importance (and the order in which
they should be implemented):

| # | Flow | Trigger | Duration |
|---|------|---------|----------|
| 1 | First-time backup setup | User completes phase-11d setup wizard | seconds |
| 2 | HistorySecret upload pipeline | CoreCrypto fires HistoryObserver | continuous (background) |
| 3 | Recovery-phrase restore | User enters phrase on fresh device | minutes |
| 4 | Pairing-based restore | User scans QR from existing device | seconds-minutes |
| 5 | Recovery-phrase rotation | User chooses to rotate phrase | seconds |
| 6 | Critical event lifecycle | Server pushes critical_event | until acked |
| 7 | Device removal initiation | User removes another device | seconds |
| 8 | Restore cancellation | User aborts mid-restore | instant |
| 9 | Self-add on device_announce_event | Another device joined | seconds-minutes per group |

Flow 1 is the prerequisite for everything else. Flows 2 and 6 run
continuously in the background. Flows 3, 4 are one-shot user-initiated
operations. Flows 5, 7 are administrative. Flows 8, 9 are reactive.

### 1.2 State-machine conventions

Each state machine is described with:
- **States**: enumerated, mutually exclusive
- **Transitions**: triggered by events (user actions, network responses,
  observer callbacks, timeouts)
- **Invariants**: what must be true at each state
- **Side effects**: what each transition does (writes, emits, etc.)
- **Failure modes**: how to leave the flow safely from any state

Transitions are labeled `event → new_state [+ side effects]`.

States are written like `IDLE`, `AWAITING_NETWORK`, `RESTORING`.

### 1.3 Cross-cutting concerns

These apply to all flows:

**Network failure recovery**. Any WS request can fail (disconnect,
timeout, transport error). Default policy: exponential backoff retry
with cap, up to 3 attempts, then transition to a flow-specific
recoverable error state. Persistent failure triggers
`history_uploads_persistently_failing` critical event (per doc #2 §7).

**CoreCrypto unavailability**. WASM init failure, IndexedDB
unavailable, etc. These are catastrophic — chalk's main UI shows a
"client unavailable" screen and most flows are unenterable until
resolved.

**Tab/device concurrency**. The same user may have chalk open in
multiple tabs of the same browser, each with its own CoreCrypto
WASM instance backed by the same IndexedDB. CoreCrypto handles
keystore locking; flow-level orchestration must additionally use
browser-level coordination (e.g. localStorage events or BroadcastChannel)
to avoid duplicate uploads / duplicate restores in the same browser.

**Memory hygiene**. The `backup_master_key` and any decrypted
HistorySecret plaintexts must be zeroed when no longer needed.
TypeScript caveat: `Uint8Array.fill(0)` is the closest we get to
guaranteed zero-out; the GC may have copies. Out of scope to fully
mitigate (per doc #1 §8.10), but worth doing what we can.

**Idempotency**. Every flow MUST be safely re-runnable. If the user
reloads mid-flow, the flow either resumes from persisted state or
starts cleanly with no corruption. State machines below describe the
persistence boundaries.

---

## 2. Flow 1 — First-time backup setup

### 2.1 Trigger and prerequisites

Triggered the first time the user encounters phase-11d functionality
on a device that doesn't yet have a `backup_master_key`. Concretely:
the user opens chalk, has no envelope cached locally, no envelope
on chalkd, and is about to use any MLS conversation.

Prerequisites:
- User is authenticated (existing chalk auth surface)
- CoreCrypto session is initialized
- Network is available

Result on success:
- `backup_master_key` generated and persisted locally (encrypted under
  device DB key)
- Envelope wrapping master_key under recovery-phrase-derived kw_key
  uploaded to chalkd
- User has been shown and confirmed their 24-word recovery phrase

### 2.2 States

```
IDLE
  ↓ (user clicks "Set up backup" OR auto-prompted)
CHECK_EXISTING_ENVELOPE
  ↓ (no existing envelope on chalkd)
GENERATING_KEYS
  ↓
DISPLAYING_PHRASE
  ↓ (user has read phrase)
CONFIRMING_PHRASE
  ↓ (user re-types phrase correctly)
WRAPPING_AND_UPLOADING
  ↓ (envelope put succeeds)
DONE
```

Side-branches:
- From `CHECK_EXISTING_ENVELOPE`: if envelope exists, user already has
  a backup on this account but not this device → transition to
  `RECOVERY_REQUIRED` and prompt user to enter their existing phrase
  (delegates to Flow 3).
- From `CONFIRMING_PHRASE`: user gets it wrong → loop back to
  `DISPLAYING_PHRASE` with a retry hint.
- From `WRAPPING_AND_UPLOADING`: network error → `UPLOAD_RETRYING`,
  exponential backoff, max 3 attempts, then `SETUP_FAILED_RECOVERABLE`.

### 2.3 State details

#### `CHECK_EXISTING_ENVELOPE`

Sends `backup_envelope_get`. Three outcomes:

| Server response | Next state | Reason |
|-----------------|------------|--------|
| `envelope = null` | `GENERATING_KEYS` | Fresh user, normal flow |
| `envelope = {...}` | `RECOVERY_REQUIRED` | Backup exists on account, must enter phrase |
| network error | `CHECK_RETRYING` (3 attempts) → `SETUP_FAILED_RECOVERABLE` | Defer setup until reconnect |

**Invariant**: nothing has been persisted yet. The user has not seen
any sensitive material.

#### `GENERATING_KEYS`

Generates locally:
1. `backup_master_key` = `crypto.getRandomValues(new Uint8Array(32))`
2. 24-word BIP-39 recovery phrase (using chalk's existing
   `internal/auth/recovery.go` equivalent on the client)
3. KDF salt = `crypto.getRandomValues(new Uint8Array(16))`

Held in memory only at this point. Not yet persisted.

**Invariant**: nothing on disk, nothing on server. User can abort and
nothing has changed.

#### `DISPLAYING_PHRASE`

UI displays the 24 words with prominent warnings:
- "Write these down on paper. They are the ONLY way to recover your
  history if you lose your device."
- "Anyone who has these words can read your conversation history."
- No screenshot, no copy-to-clipboard (configurable; default off).

Transitions on user click: "I've written it down" → `CONFIRMING_PHRASE`.
Transitions on user click: "Cancel" → flow ends, all in-memory
material zeroed.

**Invariant**: still nothing on disk or server.

#### `CONFIRMING_PHRASE`

UI asks user to re-type the phrase (or a random subset of 4 words, as
a UX-vs-rigor tradeoff to decide).

Transitions on correct re-entry → `WRAPPING_AND_UPLOADING`.
Transitions on incorrect re-entry → `DISPLAYING_PHRASE` with retry
count. After 3 wrong attempts → flow aborts ("please write the words
down carefully and start over"), all in-memory material zeroed.

#### `WRAPPING_AND_UPLOADING`

Performs:

```
kw_key = Argon2id(
  password = recovery_phrase_normalized,
  salt = generated_salt,
  memory = 256 MB,
  time = 4,
  parallelism = 1,
  output = 32 bytes,
)

# CRITICAL: Argon2id is slow (~1s on a modern laptop). Show a
# progress indicator. Run in a Worker if available to avoid UI jank.

nonce = crypto.getRandomValues(new Uint8Array(24))
wrap_ciphertext = XChaCha20-Poly1305-Encrypt(
  key = kw_key,
  nonce = nonce,
  aad = utf8("chalk.envelope.v1") || user_id_bytes(16) || wrap_id_bytes(16),
  plaintext = backup_master_key,
)

envelope = {
  envelope_version: 1,
  wraps: [{
    kind: "recovery_phrase",
    wrap_id: random_uuid(),
    expires_at: null,  # current wrap
    ciphertext: base64(wrap_ciphertext),
    nonce: base64(nonce),
    kdf_salt: base64(generated_salt),
    kdf_params: { algorithm: "argon2id", memory: 262144, time: 4, threads: 1, key_len: 32 },
  }],
}

# Upload
ack = await ws.request("backup_envelope_put", {
  envelope: envelope,
  expected_version: 0,  # 0 = "must not exist"
})
```

After successful upload:
1. Persist `backup_master_key` to localStorage (encrypted under device
   DB key) under key `chalk.backup.master_key`.
2. Zero `kw_key` (it's not needed again until rotation).
3. Zero `recovery_phrase` (user has it on paper).
4. Transition to `DONE`.

**Invariant after DONE**: server has envelope at version 1; this
device has master_key cached locally; recovery phrase exists only on
paper.

#### Failure modes from WRAPPING_AND_UPLOADING

- **Network error**: 3 retry attempts with backoff. Then
  `SETUP_FAILED_RECOVERABLE`. User can retry later. The recovery
  phrase has NOT been confirmed-saved-by-the-system yet — show a
  big warning: "you have a phrase on paper but it isn't activated;
  please retry setup to activate it."

- **`envelope_conflict` (version 0 already exists)**: someone else
  set up the envelope concurrently. Race condition between two
  devices of the same user (unlikely but possible). Transition to
  `RECOVERY_REQUIRED`: the user must enter the existing phrase
  rather than the one we just generated.

- **`envelope_too_large` / `envelope_invalid`**: implementation bug.
  Log to error tracking, abort with a generic "unexpected error;
  please try again."

### 2.4 Invariants summary

| State | Local storage has master_key | Server has envelope | User has phrase on paper |
|-------|------------------------------|---------------------|--------------------------|
| Before `DISPLAYING_PHRASE` | no | no | no |
| `DISPLAYING_PHRASE` through `WRAPPING_AND_UPLOADING` | no | no | maybe (after user writes it) |
| After `DONE` | yes | yes | yes |
| `SETUP_FAILED_RECOVERABLE` | no | no | maybe (worst case) |

The "User has phrase on paper but server has no envelope" failure
state from `SETUP_FAILED_RECOVERABLE` is the ugly one. UI must
strongly encourage retry. The phrase the user has on paper will NOT
unlock anything until a successful setup completes.

---

## 3. Flow 2 — HistorySecret upload pipeline

This is the continuously-running background flow that captures and
uploads HistorySecrets as CoreCrypto generates them. It is the
production path for D11 (upload after commit ack).

### 3.1 Architecture

Three logical components run continuously after CoreCrypto
initialization:

```
┌─────────────────┐    fires on epoch change   ┌──────────────────┐
│ EpochObserver   │ ──────────────────────────▶│ epochCache       │
└─────────────────┘                            └──────────────────┘
                                                       │ reads
                                                       ▼
┌─────────────────┐    fires on history rotation ┌──────────────────┐
│ HistoryObserver │ ─────────────────────────────▶ secretQueue     │
└─────────────────┘                              └──────────────────┘
                                                       │ pulls
                                                       ▼
┌──────────────────┐  reads commit-ack pairing  ┌──────────────────┐
│ MlsTransport     │ ──────────────────────────▶│ uploadWorker    │
│ sendCommitBundle │                            │ (background)    │
└──────────────────┘                            └──────────────────┘
                                                       │ posts
                                                       ▼
                                                  chalkd via WS
```

Per doc #3 §4.2: the two-observer pattern avoids re-entering
CoreCrypto from inside the HistoryObserver lock.

### 3.2 The epochCache

Synchronous in-memory map:

```typescript
const epochCache = new Map<ConversationIdHex, bigint>();
```

Populated by the EpochObserver:

```typescript
class ChalkEpochObserver implements EpochObserver {
  async epochChanged(conversationId: ConversationId, newEpoch: bigint): Promise<void> {
    epochCache.set(toHex(conversationId.copyBytes()), newEpoch);
    // Return promptly. No further async work.
  }
}
```

Cache survives CoreCrypto session lifetime but NOT browser session.
Empty on fresh launch; populated as conversations are activated (which
happens immediately on chalk startup as it loads conversation list).

### 3.3 The secretQueue

In-memory queue + localStorage backing for offline resilience:

```typescript
interface PendingSecret {
  conversation_id: string;       // UUID
  era_epoch: bigint;             // from epochCache, OR null pending resolution
  envelope_version: number;
  ciphertext: string;            // base64
  nonce: string;                 // base64
  created_at: number;            // ms since epoch
  source_device_id: string;
  producing_corecrypto_version: string;
  awaiting_commit_id: string | null;  // tracks which commit must ack first
  cross_session: boolean;        // true if this entry persisted across reload
}
```

States within the queue:
- `PENDING_EPOCH` — captured before epochCache had the conversation
- `PENDING_COMMIT_ACK` — encrypted, waiting for commit confirmation
- `READY_TO_UPLOAD` — commit acked, ready to send
- `UPLOAD_IN_FLIGHT` — WS request pending
- `UPLOAD_FAILED_RETRY` — failed, in backoff
- `UPLOAD_PERMANENT_FAILURE` — exceeded retries

### 3.4 HistoryObserver implementation

```typescript
class ChalkHistoryObserver implements HistoryObserver {
  async historyClientCreated(
    conversationId: ConversationId,
    historySecret: HistorySecret,
  ): Promise<void> {
    // STEP 1: Copy bytes synchronously (WASM memory may be freed
    //         after this callback returns).
    const clientIdBytes = historySecret.clientId.copyBytes();
    const dataBytes = new Uint8Array(historySecret.data);

    // STEP 2: Look up epoch from synchronous cache.
    const convIdHex = toHex(conversationId.copyBytes());
    const eraEpoch = epochCache.get(convIdHex);

    if (eraEpoch === undefined) {
      // Defer epoch resolution; queue without era_epoch.
      queueAwaitingEpoch({
        conversationId,
        clientIdBytes,
        dataBytes,
        createdAt: Date.now(),
      });
      // Schedule deferred resolution OUTSIDE this observer's execution.
      setTimeout(resolveAwaitingEpochs, 0);
      return;
    }

    // STEP 3: Encrypt and queue.
    const masterKey = getCachedMasterKey();
    if (!masterKey) {
      // Backup setup hasn't completed. Queue for later, after setup.
      queueAwaitingMasterKey({
        conversationId, clientIdBytes, dataBytes, eraEpoch,
        createdAt: Date.now(),
      });
      return;
    }

    const pending = await buildPendingSecret({
      conversationId, clientIdBytes, dataBytes, eraEpoch, masterKey,
      awaitingCommitId: currentCommitContext.commitId,
    });
    secretQueue.add(pending);
    // Persist to localStorage for crash resilience.
    persistQueueEntry(pending);
  }
}
```

### 3.5 The commit-ack pairing

Per D11, we must NOT upload until the originating commit is
acknowledged by the delivery service. This requires correlating
which queued secret belongs to which commit, so we can promote it
to READY when the commit acks (or drop it if rejected).

The correlation primitive is a "commit context" set by the caller of
the CoreCrypto operation that produces the commit. The HistoryObserver
reads this context synchronously when capturing the secret.

Important nuance about ordering: looking at CoreCrypto's Rust source
for `send_new_history_client_commit`, the sequence is:

1. `merge_commit` (local epoch advances)
2. `prepare_for_transport` (returns the dummy bytes per doc #3 §4.6)
3. `notify_new_history_client` (fires our HistoryObserver)
4. `send_commit` (calls our `MlsTransport.sendCommitBundle`, which is
   where the WS request to chalkd actually happens)

So the observer fires BEFORE the WS request goes out. We set
`currentCommitContext.commitId` at the very TOP of our
`sendCommitBundle` wrapper — but that's not soon enough, because
steps 1-3 happen before our wrapper is called.

Correct pattern: set the commit context at the point where chalk
*initiates* the operation that will eventually trigger send_commit.
Concretely, anywhere we call `cc.enableHistorySharing(convId)` or
`cc.removeClientsFromConversation(...)` (anything that produces a
commit), wrap it in a commit-context scope:

```typescript
async function withCommitContext<T>(fn: () => Promise<T>): Promise<T> {
  const commitId = generateCommitId();
  currentCommitContext.commitId = commitId;
  try {
    return await fn();
  } finally {
    // commitId persists in any queued secrets that were captured
    // during the operation. We don't clear it; we just stop using
    // it for new captures.
    currentCommitContext.commitId = null;
  }
}

// Usage at call sites:
await withCommitContext(() => cc.enableHistorySharing(convId));
await withCommitContext(() => cc.removeClientsFromConversation(convId, [...]));
```

This works because JavaScript is single-threaded and the entire
operation runs synchronously between awaits at the boundaries we
control. Even though `enableHistorySharing` internally suspends on
the `send_commit` await, our commit-context is set before that
sequence begins and only torn down after.

The `sendCommitBundle` wrapper that handles the ack:

```typescript
const sendCommitBundle = async (bundle: CommitBundle): Promise<TransportResult> => {
  // currentCommitContext.commitId was set by the caller of
  // enableHistorySharing (etc) before any observer fired.
  const commitId = currentCommitContext.commitId;

  try {
    const result = await innerSendCommitBundle(bundle);  // existing impl

    if (result.success) {
      // Promote any PENDING_COMMIT_ACK entries for this commit to READY.
      for (const entry of secretQueue.filter(e => e.awaiting_commit_id === commitId)) {
        entry.state = 'READY_TO_UPLOAD';
      }
      uploadWorker.wake();
    } else {
      // Commit rejected. Drop the pending entries — CoreCrypto will
      // retry with a new history client.
      secretQueue.removeWhere(e => e.awaiting_commit_id === commitId);
    }
    return result;
  } catch (err) {
    // Transport error (not the same as a DS rejection). Don't drop
    // pending entries; the next retry will go through the same
    // commit_id pairing.
    throw err;
  }
};
```

**Caveat**: this pattern assumes that within a single
`withCommitContext` block, at most ONE commit is produced. CoreCrypto's
`enableHistorySharing` produces exactly one commit; same for member
add/remove. If a future API produces multiple commits per call,
this pattern breaks and needs a richer correlation (e.g. observer
returns a commit_id from CoreCrypto directly, if exposed).

For v1 this is fine. Integration testing must verify the assumption
holds for our pinned 9.3.4.

### 3.6 The uploadWorker

A background async loop:

```typescript
async function uploadWorkerLoop() {
  while (true) {
    const next = secretQueue.takeNextReady();
    if (!next) {
      await wakeOrTimeout(5_000);  // wait for wake() or 5s polling
      continue;
    }

    try {
      const ack = await ws.request("history_secret_put", next.payload);
      // Success
      removePersistentEntry(next);
      metrics.uploadSuccess.inc();
    } catch (err) {
      next.attempts++;
      if (next.attempts < 3) {
        next.state = 'UPLOAD_FAILED_RETRY';
        const backoffMs = 1000 * Math.pow(2, next.attempts);  // 2s, 4s, 8s
        await sleep(backoffMs);
        next.state = 'READY_TO_UPLOAD';
      } else {
        next.state = 'UPLOAD_PERMANENT_FAILURE';
        // After enough permanent failures, trigger the
        // history_uploads_persistently_failing critical event.
        maybeEmitPersistentFailureSignal();
      }
    }
  }
}
```

### 3.7 Cross-session resilience

The queue is persisted to localStorage on every state change:

```
key: "chalk.history.queue.<sourceDeviceId>.<uuid>"
value: JSON(PendingSecret)
```

On chalk launch, the queue is rehydrated:

```typescript
function rehydrateQueue() {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('chalk.history.queue.')) {
      const entry = JSON.parse(localStorage.getItem(key)!);
      entry.cross_session = true;
      secretQueue.add(entry);
    }
  }
}
```

Per doc #3 §4.4, cross-session entries follow the **lenient policy**:
upload even though we can't link them to a commit ack (the commit ack
came and went while we were offline). Log the flag for ops
investigation.

### 3.8 Failure modes

| Failure | Detection | Recovery |
|---------|-----------|----------|
| Master_key unavailable when observer fires | `getCachedMasterKey()` returns null | Queue to `awaitingMasterKey`; process after setup flow completes |
| Epoch cache miss | `epochCache.get()` returns undefined | Defer to setTimeout(0); on retry, query CoreCrypto directly (degraded mode per doc #3 §4.5) |
| Commit rejected by DS | `sendCommitBundle` returns success: false | Drop pending entries; CoreCrypto will retry with new history client |
| Upload fails 3 times | uploadWorker counts attempts | Mark PERMANENT_FAILURE; emit critical event after threshold |
| AEAD encryption itself fails | `xchacha20poly1305_encrypt` throws | This should be impossible; log to error tracking, drop entry, alert dev team |
| localStorage quota exceeded | `setItem` throws | Drop oldest cross_session entries first; emit warning to user |

### 3.9 Tab coordination

Multiple chalk tabs in the same browser share IndexedDB. CoreCrypto
serializes its own operations across tabs (via IndexedDB locks). The
HistoryObserver may fire in any one of the tabs depending on which
holds the lock at the time.

The risk: tab A captures and uploads a secret. Tab B's observer also
fires (it does receive the same notification because the shared CoreCrypto
state advanced). Both tabs queue and try to upload. UPSERT semantics
on the server (doc #4 §3.1) resolve this benignly.

But: tab A and tab B may have different views of `epochCache` if
their EpochObservers fire at different times. To minimize drift, use
`BroadcastChannel('chalk.epoch_sync')` to share epoch updates across
tabs:

```typescript
const bc = new BroadcastChannel('chalk.epoch_sync');
class ChalkEpochObserver {
  async epochChanged(conversationId: ConversationId, newEpoch: bigint) {
    const convIdHex = toHex(conversationId.copyBytes());
    epochCache.set(convIdHex, newEpoch);
    bc.postMessage({ convIdHex, epoch: newEpoch.toString() });
  }
}
bc.onmessage = (e) => {
  epochCache.set(e.data.convIdHex, BigInt(e.data.epoch));
};
```

This is a soft optimization. Even without it, UPSERT semantics on the
server keep things consistent at the cost of redundant uploads.

---

## 4. Flow 3 — Recovery-phrase restore

The most user-facing complex flow. User has a recovery phrase on
paper and a brand new chalk device. They want to read all their old
conversations.

### 4.1 Trigger and prerequisites

Triggered when the user clicks "I have a recovery phrase" on a fresh
device's setup screen.

Prerequisites:
- User is authenticated to chalk (existing auth surface)
- CoreCrypto session is initialized (with the user's existing
  identity)
- Network is available
- User has typed (will type) their 24-word phrase

Result on success:
- `backup_master_key` cached locally
- All HistorySecrets for the user downloaded and decrypted
- One CoreCrypto historyClient instantiated per era, registered
  for decryption routing per doc #3 §5.3
- User can read all past messages from conversations they participated in

### 4.2 States

```
IDLE
  ↓ (user enters phrase)
PHRASE_ENTERED
  ↓
FETCHING_ENVELOPE
  ↓ (envelope received)
DERIVING_KW_KEY               (Argon2id, ~1s)
  ↓
UNWRAPPING_MASTER_KEY
  ↓ (AEAD ok)
MASTER_KEY_AVAILABLE          (also caches to localStorage)
  ↓
LISTING_SECRETS
  ↓ (list received)
DOWNLOADING_SECRETS           (loop: fetch+decrypt each)
  ↓ (all done or partial)
INSTANTIATING_HISTORY_CLIENTS (loop: CoreCrypto.historyClient per secret)
  ↓
RESTORE_COMPLETE              (emit critical event)
```

Side-branches:
- From `FETCHING_ENVELOPE`: envelope is null on server → no backup
  exists, user typed phrase for a fresh account by mistake →
  `RESTORE_NOT_APPLICABLE`, suggest first-time setup instead.
- From `UNWRAPPING_MASTER_KEY`: AEAD fails on the current wrap → try
  any other wraps in the envelope (e.g. a not-yet-expired old wrap).
  If all wraps fail → `WRONG_PHRASE`, re-prompt user.
- From `DOWNLOADING_SECRETS`: individual secret fails → log,
  continue (partial restore).
- From `INSTANTIATING_HISTORY_CLIENTS`: individual client fails →
  log, continue.
- From any state: user cancels → see Flow 8.

### 4.3 State details

#### `PHRASE_ENTERED`

UI captures the 24 words. Validates BIP-39 word list membership.
Normalizes (NFKD, lowercase, trim). Computes BIP-39 checksum; if
invalid, returns to input with error.

**Invariant**: the phrase exists in JS memory but not on disk.

#### `FETCHING_ENVELOPE`

Sends `backup_envelope_get`. Outcomes:

| Server response | Next state |
|-----------------|------------|
| envelope present | `DERIVING_KW_KEY` |
| envelope null | `RESTORE_NOT_APPLICABLE` |
| network error | `FETCH_RETRYING`; 3 attempts; then `RESTORE_FAILED_RECOVERABLE` |

#### `DERIVING_KW_KEY`

For each wrap in the envelope (typically just one, but rotation may
leave a recently-superseded wrap with `expires_at` in the future):

```
kw_key_n = Argon2id(
  password = phrase_normalized,
  salt = wrap_n.kdf_salt,
  memory = wrap_n.kdf_params.memory,
  time = wrap_n.kdf_params.time,
  ...
)
```

Run sequentially, **try the unexpired current wrap first** (the one
with `expires_at = null`), then fall back to any other wraps in order.

This is the slow step. Show a progress indicator: "decrypting your
backup… (this can take a moment)."

#### `UNWRAPPING_MASTER_KEY`

For each candidate `kw_key_n`:

```
try:
  master_key = XChaCha20-Poly1305-Decrypt(
    key = kw_key_n,
    nonce = wrap_n.nonce,
    aad = utf8("chalk.envelope.v1") || user_id_bytes(16) || wrap_n.wrap_id_bytes(16),
    ciphertext = wrap_n.ciphertext,
  )
  # Success!
  break
except AEADAuthError:
  # Wrong phrase for this wrap. Try the next one.
  continue
```

If all wraps fail → `WRONG_PHRASE` → re-prompt user. Allow up to
N=5 attempts then lockout for some interval (UX decision; existing
chalk auth-rate-limit pattern applies).

On success: zero the phrase from memory, cache master_key to
localStorage encrypted under device DB key.

#### `LISTING_SECRETS`

Send `history_secret_list` (no filter — get all secrets for user).

Outcomes:

| Server response | Next state |
|-----------------|------------|
| list with N descriptors | `DOWNLOADING_SECRETS` |
| empty list | `RESTORE_COMPLETE` (with note: no history to restore) |
| network error | `LIST_RETRYING`; 3 attempts; then `RESTORE_FAILED_RECOVERABLE` |

For status reporting, the descriptors include `producing_corecrypto_version`
per doc #2 §3.3. If we see versions newer than our current CoreCrypto,
log a warning but proceed (forward-compat is best-effort per doc #3
§6.3).

#### `DOWNLOADING_SECRETS`

For each descriptor (parallelizable; see batching below):

```typescript
const ack = await ws.request("history_secret_get", { secret_id: descriptor.secret_id });

// Verify identity binding
assert ack.conversation_id === descriptor.conversation_id;
assert ack.era_epoch === descriptor.era_epoch;

// Decrypt
const aad = utf8("chalk.history.v1")
          || userId.bytes()
          || conversationIdBytesFromUuid(ack.conversation_id)
          || u64_be(ack.era_epoch);
try {
  const plaintext = xchacha20poly1305_decrypt(
    masterKey,
    base64decode(ack.nonce),
    aad,
    base64decode(ack.ciphertext),
  );
  const body = cborDecode(plaintext);

  if (body.schema_version > 1) {
    // Future-version secret from a newer chalk client.
    log.warn(`secret ${descriptor.secret_id} has schema_version ${body.schema_version}; skipping`);
    failedSecrets.push({ descriptor, reason: 'unknown_schema' });
    continue;
  }

  decryptedSecrets.push({ descriptor, body });

  emitProgress({
    stage: 'downloading history secrets',
    items: completed,
    totalItems: descriptors.length,
    percent: round(100 * completed / descriptors.length),
  });
} catch (AEADAuthError) {
  // Either the master_key is wrong for this specific secret (unlikely
  // if other secrets decrypted), or the ciphertext was tampered with,
  // or it's corrupt.
  log.warn(`secret ${descriptor.secret_id} failed AEAD verification`);
  failedSecrets.push({ descriptor, reason: 'aead_failure' });
  continue;
}
```

**Batching policy**: download up to 8 secrets in parallel. Above
this, we strain server CPU more than helps user latency. Tune via
config.

**Early exit on widespread failure**: if the first 10 secrets ALL
fail AEAD verification, that's a strong signal of wrong-phrase
(or backup corruption). Halt download, transition to `WRONG_PHRASE`,
zero the master_key cache, re-prompt user.

#### `INSTANTIATING_HISTORY_CLIENTS`

For each decrypted secret:

```typescript
try {
  const plainSecret = {
    clientId: new CC.ClientId(body.client_id),
    data: body.data,
  };
  const historyClient = await CC.CoreCrypto.historyClient(plainSecret);
  registerHistoryClient(descriptor.conversation_id, descriptor.era_epoch, historyClient);
} catch (err) {
  log.warn(`historyClient instantiation failed for ${descriptor.secret_id}`, err);
  failedSecrets.push({ descriptor, reason: 'instantiation_failure' });
}

emitProgress({
  stage: 'instantiating history clients',
  items: completed,
  totalItems: decryptedSecrets.length,
  percent: round(100 * completed / decryptedSecrets.length),
});
```

**NOT parallelizable.** `CoreCrypto.historyClient` writes to
IndexedDB; concurrent calls may serialize via IndexedDB transactions
anyway, but it's cleaner to await sequentially.

#### `RESTORE_COMPLETE`

Final actions:
1. Build the per-conversation per-era routing table from
   `registerHistoryClient` calls (per doc #3 §5.3).
2. Emit a `restore_completed` critical event locally (server should
   also emit one, but we don't strictly need it).
3. Trigger Flow 9 implicitly: the device now has the master_key, so
   the next step is to announce itself via `device_announce` and let
   other devices self-add it to all conversations for ongoing
   participation (independent of history per D13).

Show user a summary: "Restored history for N conversations. K eras
had problems and may show missing messages. Welcome back!"

### 4.4 Failure modes

| State | Failure | Behavior |
|-------|---------|----------|
| `PHRASE_ENTERED` | Invalid BIP-39 | Re-prompt with error |
| `FETCHING_ENVELOPE` | Network | Retry 3x, then `RESTORE_FAILED_RECOVERABLE` |
| `FETCHING_ENVELOPE` | Envelope null | `RESTORE_NOT_APPLICABLE` — explain, offer first-time setup |
| `DERIVING_KW_KEY` | (no failure mode beyond CPU time) | — |
| `UNWRAPPING_MASTER_KEY` | All wraps fail AEAD | `WRONG_PHRASE`, re-prompt (rate-limit at 5 attempts) |
| `LISTING_SECRETS` | Network | Retry 3x, then recoverable |
| `LISTING_SECRETS` | Empty list | `RESTORE_COMPLETE` (no history to restore is valid; new account or no conversations) |
| `DOWNLOADING_SECRETS` | One secret fails | Log, continue. Track count. |
| `DOWNLOADING_SECRETS` | First 10 all fail AEAD | Halt, `WRONG_PHRASE`, zero master_key |
| `INSTANTIATING_HISTORY_CLIENTS` | One fails | Log, continue. Track count. |

### 4.5 Storage projections

From doc #4 §3.2: typical heavy user has 5000 secrets. Restore cost:

- 5000 × `history_secret_get` requests
- 5000 × Argon2id (NO — we derive kw_key ONCE for the envelope)
- 5000 × XChaCha20-Poly1305 decrypt (~negligible)
- 5000 × CBOR decode (~negligible)
- 5000 × `CoreCrypto.historyClient` calls (sequential, each writes
  IndexedDB)

The CoreCrypto.historyClient step is the bottleneck. If each call
takes 50ms (estimate; needs sandbox benchmark), 5000 calls = 250
seconds = 4 minutes. Acceptable for a one-time restore, but UI must
clearly indicate progress.

Optimization: instantiate history clients lazily, only as the user
opens conversations. Store the decrypted secrets in IndexedDB,
instantiate on first access. Defers most cost to user interaction,
but means cold reads are slow.

**Recommendation for v1**: eager instantiation with prominent
progress UI. Lazy instantiation is an optimization for v2.

---

## 5. Flow 4 — Pairing-based restore

User has an existing chalk device and a new chalk device. They scan
a QR code on the new device to receive the master_key via PAKE
channel, then run the secret-download portion of Flow 3.

### 5.1 Trigger and prerequisites

Triggered by the user choosing "Pair with existing device" on the new
device's setup screen, AND the user opening the pairing initiator
flow on an existing device.

Prerequisites:
- Both devices have network connectivity
- Both devices are authenticated to chalk as the same user
- Existing device has the master_key cached (it MUST be active per
  D11/D12; cannot pair from a "device that itself never set up
  backup")
- New device has a fresh CoreCrypto session

### 5.2 States — existing device (initiator)

```
IDLE
  ↓ (user clicks "Pair a new device")
GENERATING_OFFER
  ↓ (computes ephemeral X25519 keypair, 128-bit OOB secret)
DISPLAYING_QR
  ↓ (waiting for new device to claim)
AWAITING_CLAIM      (timeout: 5 min)
  ↓ (pairing_event push received)
COMPLETING          (derive PAKE session key, encrypt master_key)
  ↓ (pairing_complete sent)
DONE_INITIATOR
```

Side-branches:
- From `AWAITING_CLAIM`: timeout → `PAIRING_EXPIRED` → user starts over
- From `AWAITING_CLAIM`: user cancels → send `pairing_cancel`
- From `COMPLETING`: network error → 3 retries → `PAIR_FAILED_RECOVERABLE`

### 5.3 States — new device (claimant)

```
IDLE
  ↓ (user clicks "Pair with existing device")
SCANNING_QR
  ↓ (QR captured, decoded to {pairing_id, server_url, oob_secret, initiator_pubkey})
CLAIMING                (sends pairing_claim with new ephemeral pubkey)
  ↓ (pairing_claim_ack received)
AWAITING_COMPLETE
  ↓ (pairing_complete push received)
DERIVING_SESSION_KEY
  ↓ (decrypts master_key under PAKE session key)
MASTER_KEY_AVAILABLE
  ↓
[delegates to Flow 3's LISTING_SECRETS state]
```

Side-branches:
- From `SCANNING_QR`: QR decode failure → user retries
- From `CLAIMING`: `pairing_already_claimed` → another device beat us → user starts over
- From `CLAIMING`: `pairing_not_found` / `pairing_expired` → user starts over
- From `AWAITING_COMPLETE`: timeout (5 min from pairing_id creation) → fail
- From `DERIVING_SESSION_KEY`: AEAD failure → `pairing_proof_invalid` →
  this is a possible MitM attack; abort, notify user

### 5.4 Cross-device coordination

Pairing involves three actors: initiator device, chalkd, claimant
device. The pairing_id (UUID) is the shared correlation across all
three. Server-side state lives in memory only (per doc #4 §6.1) with
5-min TTL.

The OOB secret carried in the QR is the only thing chalkd does NOT
see. Combined with the X25519 ephemeral keys (which chalkd DOES see
in transit), the OOB secret raises the PAKE session key out of
chalkd's view:

```
session_key = HKDF(
  ikm = ECDH(initiator_eph_priv, claimant_eph_pub),
  salt = oob_secret,
  info = "chalk.pairing.v1" || pairing_id || hash(initiator_eph_pub) || hash(claimant_eph_pub),
  length = 32,
)
```

A passive observer (chalkd) sees both pubkeys, learns nothing about
session_key without the OOB.

### 5.5 The pairing_complete payload

```typescript
interface PairingCompletePayload {
  pairing_id: string;
  encrypted_master_key: string;  // base64
  nonce: string;                 // base64, 24 bytes
}
```

Where `encrypted_master_key = XChaCha20-Poly1305-Encrypt(session_key, nonce, aad, master_key)` with
`aad = utf8("chalk.pairing.complete.v1") || pairing_id_bytes(16)`.

### 5.6 After master_key received

The new device transitions to Flow 3's `MASTER_KEY_AVAILABLE` state
and runs the download-and-instantiate path. There is no envelope
unwrap step — we got the master_key directly, not from the envelope.

(The envelope still exists on chalkd. The new device's existence
doesn't require the new device to re-derive the envelope; that's
done by the EXISTING device on rotation, or by a recovery-phrase
flow on yet-another-device.)

### 5.7 Critical event after successful pair

The server emits a `device_added_paired` critical event after seeing
both `pairing_complete` + the new device's first `device_announce`.
Other devices of the user receive this event for awareness. The new
device acknowledges automatically (it knows it just added itself);
other devices show "Wasn't me" / "OK" options.

### 5.8 Detailed PAKE crypto

**Deferred to doc #6.** This doc describes the state machine; doc #6
will spec the exact crypto operations, including:
- KDF parameters
- Constant-time comparison rules
- The 6-digit PIN variant (v2)
- Defense against pairing-replay attacks

---

## 6. Flow 5 — Recovery-phrase rotation

User wants to change their recovery phrase. Reasons: suspected leak,
periodic hygiene, demonstration to themselves that recovery works.

### 6.1 Trigger and prerequisites

Triggered by user clicking "Rotate recovery phrase" in settings.

Prerequisites:
- Master_key is cached locally OR user can enter the current phrase
- Network is available

Result on success:
- New 24-word phrase generated and confirmed
- New wrap (with new kdf_salt, new kw_key, same master_key as before)
  added to envelope
- Old wrap marked `expires_at = now + 30 days`

### 6.2 States

```
IDLE
  ↓ (user clicks "Rotate phrase")
VERIFYING_CURRENT_USER      (re-auth: existing phrase OR password OR biometric)
  ↓
FETCHING_CURRENT_ENVELOPE
  ↓
GENERATING_NEW_PHRASE
  ↓
DISPLAYING_NEW_PHRASE
  ↓ (user confirms)
CONFIRMING_NEW_PHRASE
  ↓
DERIVING_NEW_KW_KEY         (Argon2id again)
  ↓
WRAPPING_AND_UPLOADING      (envelope with both wraps)
  ↓
DONE
```

### 6.3 State details

#### `VERIFYING_CURRENT_USER`

Two paths:
- **Master_key cached locally**: optional but recommended additional
  factor (password / biometric). Existing chalk auth surface.
- **Master_key not cached** (cleared after some idle period?):
  prompt for current phrase first, derive kw_key, unwrap master_key,
  cache it.

Without this step, an attacker who steals an authenticated session
could rotate the user's phrase silently.

#### `WRAPPING_AND_UPLOADING`

Build new wrap:

```typescript
const newWrap = {
  kind: "recovery_phrase",
  wrap_id: random_uuid(),
  expires_at: null,  // this is the new "current"
  ciphertext: base64(newWrapCiphertext),
  nonce: base64(newNonce),
  kdf_salt: base64(newSalt),
  kdf_params: { algorithm: "argon2id", memory: 262144, time: 4, threads: 1, key_len: 32 },
};

// Mark old current as expiring
const updatedWraps = currentEnvelope.wraps.map(w =>
  w.expires_at === null
    ? { ...w, expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000 }
    : w  // already-expiring wraps stay as-is
);
updatedWraps.push(newWrap);

// Optional: prune wraps with expires_at < now
const liveWraps = updatedWraps.filter(w =>
  w.expires_at === null || w.expires_at > Date.now()
);

const newEnvelope = {
  envelope_version: 1,
  wraps: liveWraps,
};

const ack = await ws.request("backup_envelope_put", {
  envelope: newEnvelope,
  expected_version: currentEnvelope.version,
});
```

The 30-day grace period (D3) means a user who rotates and
immediately tries to restore on another device using the OLD phrase
will still succeed (because the old wrap is still in the envelope).
After 30 days, the old phrase stops working.

#### `DONE`

Emit a `recovery_phrase_rotated` critical event locally; server
should also emit. User sees confirmation. Old phrase paper should
be securely destroyed by user (UI reminder).

### 6.4 Failure modes

| State | Failure | Behavior |
|-------|---------|----------|
| `VERIFYING_CURRENT_USER` | Wrong current phrase | Re-prompt; rate-limit per existing chalk policy |
| `FETCHING_CURRENT_ENVELOPE` | Network | Retry 3x, then recoverable |
| `WRAPPING_AND_UPLOADING` | `envelope_conflict` | Another device rotated concurrently. Re-fetch envelope, prompt user to restart (their new wrap would conflict). |
| `WRAPPING_AND_UPLOADING` | Network mid-flight | Retry; envelope_put is idempotent on the new envelope contents |

**Important**: if rotation fails after the new phrase is shown to the
user, the user has a paper phrase that doesn't unlock anything. Same
ugly state as Flow 1's `SETUP_FAILED_RECOVERABLE`. UI must clearly
communicate this and encourage retry.

---

## 7. Flow 6 — Critical event lifecycle

Continuously running. Handles incoming critical events, displays them
to the user, and tracks acks with cross-device sync.

### 7.1 The local mirror

Per doc #1 §8.4 and doc #4 §9.3, the client maintains a local mirror
of pending critical events. This prevents a hostile chalkd from
silently dismissing events.

```typescript
interface LocalCriticalEvent {
  event_id: string;
  kind: string;
  severity: string;
  title: string;
  body: string;
  context_json: object;
  actions_json: CriticalEventAction[];
  created_at: number;
  acked_locally: boolean;
  acked_at: number | null;
  acked_action_id: string | null;
  source: 'pushed' | 'list_fetch';
}

const localMirror: Map<string, LocalCriticalEvent> = new Map();
// Persisted to IndexedDB on every mutation.
```

### 7.2 States — per-event

Each event is in one of:

```
PENDING_DISPLAY        // received, not yet shown to user
DISPLAYED              // visible in UI
USER_ACTING            // user has clicked an action; ack in flight
ACKED_LOCAL            // local ack succeeded; awaiting server confirmation
ACKED_REMOTE           // server confirmed our ack (rare race; usually ack-ack arrives first)
DISMISSED              // ack confirmed; event removed from list
```

### 7.3 Receiving an event

```typescript
// On WS push: critical_event
function onCriticalEventPush(event: CriticalEventPushPayload) {
  if (localMirror.has(event.event_id)) {
    // Duplicate push; ignore.
    return;
  }
  localMirror.set(event.event_id, {
    ...event,
    acked_locally: false,
    acked_at: null,
    acked_action_id: null,
    source: 'pushed',
  });
  persistMirror();
  ui.showCriticalEvent(event);  // transition to DISPLAYED
  metrics.criticalEventReceived.inc({ kind: event.kind });
}

// On connect: fetch full pending list to recover from missed pushes
async function onConnectFetchPending() {
  const ack = await ws.request("critical_event_list", {});
  for (const event of ack.events) {
    if (!localMirror.has(event.event_id)) {
      localMirror.set(event.event_id, {
        ...event,
        acked_locally: false,
        acked_at: null,
        acked_action_id: null,
        source: 'list_fetch',
      });
    }
  }
  persistMirror();
}
```

### 7.4 Acking an event

```typescript
async function userAcks(eventId: string, actionId: string) {
  const event = localMirror.get(eventId);
  if (!event) throw new Error("unknown event");
  if (event.acked_locally) return;  // idempotent

  // Mark local first
  event.acked_locally = true;
  event.acked_at = Date.now();
  event.acked_action_id = actionId;
  persistMirror();

  ui.hideCriticalEvent(eventId);

  // Send ack
  try {
    await ws.request("critical_event_ack", { event_id: eventId, action_id: actionId });
    event.state = 'ACKED_REMOTE';
  } catch (err) {
    if (err.code === 'critical_event_already_acked') {
      // Race: another device acked. Same outcome.
      event.state = 'ACKED_REMOTE';
    } else if (err.code === 'critical_event_not_found') {
      // Event was pruned. Same outcome.
      event.state = 'ACKED_REMOTE';
    } else {
      // Network error. Keep state as ACKED_LOCAL; retry on reconnect.
      enqueueRetry(event);
    }
  }
}
```

### 7.5 Cross-device dismissal

When the server pushes `critical_event_dismissed_event` (another
device of the same user acked), we receive it and update locally:

```typescript
function onDismissedEventPush(payload: CriticalEventDismissedEventPayload) {
  const event = localMirror.get(payload.event_id);
  if (!event) return;  // we never saw it; fine

  // Defense per doc #1 §8.4: trust the dismiss only if WE have a
  // record of OUR ack OR if the dismissing device is one of our own.
  if (event.acked_locally) {
    // We acked too, or this is confirmation. Fine.
    event.state = 'ACKED_REMOTE';
  } else if (payload.acked_by_device_id === ourDeviceId) {
    // Impossible — we'd have set acked_locally. Treat as suspicious.
    log.error("server reports our device acked, but we have no record", payload);
    return;
  } else if (isOurDevice(payload.acked_by_device_id)) {
    // Another of our devices acked. Trust.
    event.acked_locally = true;
    event.acked_at = Date.now();
    event.acked_action_id = payload.acked_action_id;
    event.state = 'ACKED_REMOTE';
    ui.hideCriticalEvent(payload.event_id);
  } else {
    // The "ack" claims to come from a device that ISN'T ours.
    // This is impossible in the legitimate protocol. Reject.
    log.error("dismissal claim from non-owned device", payload);
    // Do NOT hide the event. User will see it on this device until
    // we (or one of our verified devices) ack it.
    return;
  }
  persistMirror();
}
```

The `isOurDevice(deviceId)` check requires the client to know the
list of its own devices (from `device_list` calls or
`device_announce_event` pushes).

### 7.6 Persistent failure event

The `history_uploads_persistently_failing` critical event is generated
server-side (per doc #4 §4) when upload failures cross a threshold.
The client's response: typically display, offer "retry now" /
"investigate" / "ack" actions. No special handling beyond the generic
flow.

### 7.7 Restore-complete event

Emitted server-side after the user's first successful Flow 3 or
Flow 4 completion. Should be auto-acknowledged on the device that
just completed restore (it knows the operation succeeded). On OTHER
devices, just informational.

```typescript
function onCriticalEventPush(event) {
  // ... existing handling ...

  if (event.kind === 'restore_completed' && event.acked_by_device_id === ourDeviceId) {
    // Self-emitted on our own action. Auto-ack.
    autoAck(event.event_id, 'auto-ok');
  }
}
```

---

## 8. Flow 7 — Device removal initiation

User in settings clicks "Remove this device" on another of their
devices.

### 8.1 States

```
IDLE
  ↓ (user selects device, confirms)
REMOVING
  ↓ (send device_remove)
EVICTING_FROM_GROUPS         (server-side: MLS commits to evict target device)
  ↓ (device_remove_ack received)
DONE
```

### 8.2 State details

The handler-side flow is mostly server-driven (per doc #4). Client's
role is just to initiate.

After ack, the client updates local device list display. The
removed device's other-side (the device being removed) gets a
critical event `device_removed` and is shown a "this device has
been signed out" UI; their CoreCrypto session continues until the
MLS commits propagating the removal arrive, at which point all their
group memberships become unusable.

**Important UX consideration**: the removed device will lose access
to its keystore from the user's perspective, but the device DB
contents (master_key, IndexedDB, etc.) remain on the local disk.
The removed device, if recovered/used by an attacker, still has the
master_key and could read the user's currently-stored HistorySecrets
on chalkd. The user MUST rotate their recovery phrase (Flow 5) and
the master_key (manual playbook per doc #1 §8.6) if they suspect the
removed device was compromised.

Document this in the removal confirmation dialog clearly.

### 8.3 device_remove_self protection

User CANNOT remove their currently-connected device via this flow.
The server returns `device_remove_self` per doc #2 §8. Client should
gray out the "remove" button for the current device entirely; the
server check is defense in depth.

To remove the currently-connected device: user signs out from this
device (existing chalk auth surface), then another device can remove
it.

---

## 9. Flow 8 — Restore cancellation

User clicks "Cancel" during a long-running Flow 3 or Flow 4 restore.

### 9.1 Cancel-safety per state

| Restore state | Safe to cancel? | Cleanup needed |
|---------------|-----------------|----------------|
| `PHRASE_ENTERED` | yes | Zero phrase from memory |
| `FETCHING_ENVELOPE` | yes | Abort WS request (or let it complete and discard ack) |
| `DERIVING_KW_KEY` | yes | If running in Worker, terminate worker. Zero phrase. |
| `UNWRAPPING_MASTER_KEY` | yes | Zero kw_key, master_key candidate |
| `MASTER_KEY_AVAILABLE` | partial — see below | Master_key cached; not yet harmful |
| `LISTING_SECRETS` | yes | Discard list |
| `DOWNLOADING_SECRETS` | yes | Stop loop. Already-decrypted secrets in memory: discard. Already-instantiated history clients: see below. |
| `INSTANTIATING_HISTORY_CLIENTS` | yes | Stop loop. |

### 9.2 The partial-restore state

If the user cancels after some history clients have been instantiated,
those history clients live in IndexedDB. They're functional decryptors
for the eras they cover.

Options for cleanup:
- **Option A: leave them.** User has partial decryption capability for
  some conversations. If they resume restore later, the remaining
  history clients will be added. Total successful = sum of both
  attempts.
- **Option B: clean up.** Iterate the partial-restore history client
  IDs and call CoreCrypto's remove-client API (if it exists) to
  delete them from IndexedDB. Restore from scratch on resume.

**Recommendation**: Option A. It's harmless (the user wanted history
anyway, just temporarily aborted), avoids destruction risk, and
makes resume cheaper. State machine: cancellation returns to
`IDLE`; next restore attempt either resumes from where we left off
(if the user kept the master_key cached) or restarts (if they
cleared it).

### 9.3 What about the master_key?

If the user cancels at `MASTER_KEY_AVAILABLE` or later, the
master_key was successfully derived and cached. Two choices:
- **Keep it cached.** Next attempt skips Argon2id.
- **Zero it.** Next attempt re-prompts for phrase.

For UX: prompt the user. "Keep your backup unlocked for future
sessions on this device?" → if yes, keep cached. If no, clear.

This is also the choice we present after Flow 1 first-time setup.

---

## 10. Flow 9 — Self-add on device_announce_event

When another device of the same user announces itself (Flow 2 or
Flow 3 on that new device emits `device_announce`), the server pushes
`device_announce_event` to all OTHER devices of the user. Each of
those devices needs to add the new device to all the MLS groups it's
in.

### 10.1 States — per existing device

```
IDLE
  ↓ (device_announce_event push received)
JITTERING                    (random 0-30s delay to avoid commit races)
  ↓
ITERATING_GROUPS
  ↓ (for each group I'm in)
ADDING_TO_GROUP              (for one group at a time)
  ↓
DONE
```

### 10.2 The race problem

Multiple existing devices each receive the same
`device_announce_event` and would each try to add the new device to
the same set of MLS groups. CoreCrypto's commit-acceptance is
serialized at the delivery service: only one device's add-commit per
group will succeed; others get a "stale commit" error and must retry
with the latest group state.

The jitter (random 0-30 seconds per device) reduces the likelihood
of all devices commit-racing simultaneously, but doesn't eliminate
it. Each device must handle the race correctly:

```typescript
async function addDeviceToGroup(newDeviceClientId: string, conversationId: string) {
  let attempts = 0;
  while (attempts < 5) {
    try {
      await cc.addClientsToConversation(conversationId, [newDeviceClientId]);
      return; // success
    } catch (err) {
      if (err.code === 'stale_commit') {
        // Some other device beat us. Refresh state and check if the
        // new device is already a member (likely yes from their commit).
        const members = await cc.getMembers(conversationId);
        if (members.includes(newDeviceClientId)) {
          return; // someone else added it; we're done
        }
        // Otherwise, refresh and retry.
        attempts++;
        await sleep(1000 * Math.pow(2, attempts));  // 2s, 4s, ...
      } else {
        throw err;
      }
    }
  }
  log.warn(`could not add device ${newDeviceClientId} to ${conversationId} after retries`);
}
```

### 10.3 Iteration order

Iterate conversations alphabetically (deterministic) so multiple
devices race in the same order. Combined with jitter, this means the
"winner" for each group is approximately uniformly distributed across
the existing devices, balancing the workload.

### 10.4 Failure isolation

If add-to-group fails for one group, log and continue to the next.
The new device will be a member of some groups but not others; the
user will see those conversations missing until the failure is
resolved (typically by retrying on next reconnect).

### 10.5 What about history?

Flow 9 only adds the new device for ONGOING participation. History
restoration is independent (Flow 3 or 4 on the new device, using
HistorySecrets uploaded by various existing devices over time).

The new device, after self-add by existing devices, can decrypt
messages from the moment it received its MLS welcome onward. For
messages from BEFORE the welcome, it needs Flow 3/4's history-client
instantiation.

Per D13: these flows are independent and run concurrently.

---

## 11. Cross-flow coordination

### 11.1 State machine concurrency

Multiple flows can be active simultaneously:

| Concurrent flows | Interaction |
|------------------|-------------|
| Flow 2 (upload) + Flow 3 (restore) | Same device, but Flow 3 typically runs at startup before Flow 2 starts emitting. Mostly disjoint. |
| Flow 2 (upload) + Flow 6 (critical events) | Independent; both can run. |
| Flow 3 (restore) + Flow 9 (self-add) | The new device runs Flow 3 to get history; OTHER devices run Flow 9 to add it. Independent. |
| Flow 5 (rotation) + Flow 2 (upload) | After rotation, future uploads use the same master_key with the new envelope_version. Tracked via the `envelope_version` field in HistorySecretPutPayload. |
| Flow 1 (setup) + anything else | Anything that requires master_key blocks on Flow 1 finishing. |

### 11.2 Persisting state across reload

Persistence requirements per flow:

| Flow | Persisted? | Where |
|------|------------|-------|
| 1 (setup) | NO until `DONE` | — |
| 2 (upload pipeline) | YES queue + state | localStorage + in-memory |
| 3 (restore) | NO during, partial after | IndexedDB (history clients), localStorage (master_key) |
| 4 (pairing) | NO during, same as 3 after | Same as 3 |
| 5 (rotation) | NO until `DONE` | — |
| 6 (critical events) | YES (the mirror) | IndexedDB |
| 7 (device remove) | NO | — |
| 8 (cancel) | N/A | — |
| 9 (self-add) | NO | — |

For flows that don't persist mid-state, reload during the flow means
restarting from the beginning. Acceptable for setup-like flows (user
will re-engage); not acceptable for upload (which is why Flow 2 IS
persisted).

### 11.3 Browser-tab coordination

Per §3.9, use BroadcastChannel for epoch cache sync. Other shared
state:

- **Master_key cache**: shared via localStorage; all tabs read the
  same value. localStorage `storage` event notifies other tabs of
  updates.
- **Critical event mirror**: shared via IndexedDB; IDB locking
  prevents conflicts.
- **Pairing in progress**: SHOULD only happen in one tab at a time.
  Use `BroadcastChannel('chalk.pairing.active')` to coordinate.
- **Restore in progress**: SHOULD only happen in one tab. Same
  pattern.

If a flow needing exclusive access detects another tab has it,
display "this operation is in progress in another tab" UI rather
than start a duplicate.

---

## 12. Implementation outline

### 12.1 Suggested package structure

```
src/client/
  backup/
    setup.ts          // Flow 1
    upload.ts         // Flow 2: HistoryObserver, EpochObserver,
                      //         queue, uploadWorker
    restore.ts        // Flow 3
    rotation.ts       // Flow 5
  pairing/
    initiator.ts      // Flow 4 sender side
    claimant.ts       // Flow 4 receiver side
  events/
    critical.ts       // Flow 6
  devices/
    remove.ts         // Flow 7
    self_add.ts       // Flow 9
  state/
    machine.ts        // generic state-machine helpers
    types.ts          // shared types
```

Each flow file exports a state-machine driver and a small public API:

```typescript
// Example: setup.ts
export type SetupState =
  | { kind: 'IDLE' }
  | { kind: 'CHECK_EXISTING_ENVELOPE' }
  | { kind: 'GENERATING_KEYS' }
  | ...
  | { kind: 'DONE' };

export interface SetupController {
  state: SetupState;
  start(): Promise<void>;
  confirmPhrase(words: string[]): Promise<void>;
  cancel(): void;
  on(event: 'state', listener: (state: SetupState) => void): void;
}
```

### 12.2 Testing approach

Each flow gets:
- **Unit tests** for state transitions (mock the network and
  CoreCrypto).
- **Integration tests** in the sandbox (per doc #3 §7.4) covering
  end-to-end happy paths.
- **Failure-injection tests**: simulate network errors, AEAD
  failures, race conditions.

Critical scenarios for integration tests:
- Alice creates conv → sends messages → Bob (new device) restores
  via pairing → reads Alice's messages.
- Alice creates conv → sends messages → Alice rotates phrase →
  Alice (new device) restores via NEW phrase → reads own messages.
- Alice creates conv → sends messages → Alice rotates phrase →
  Alice (new device) restores via OLD phrase within 30 days →
  reads own messages.
- Alice creates conv → sends messages → Carol joins group →
  Carol (new device) restores → can decrypt messages from after
  her join but not before.
- Mid-restore cancellation, then resume.
- Network drop mid-upload, then reconnect.

---

## 13. Open questions

**Q25 (new)**: Should we display a "backup is on" / "backup is off"
status badge in the chalk UI always?

Yes. Per D7 transparency. The badge subscribes to `backup_status_get`
data updated on receipt of relevant events.

**Q26 (new)**: How does the user "test" their recovery phrase without
actually rotating it?

Recommendation: a dedicated "Verify recovery phrase" flow in
settings:
1. User types phrase
2. Client fetches envelope
3. Client derives kw_key and tries to unwrap master_key
4. Compare unwrapped master_key with locally-cached master_key
5. Show "Phrase verified ✓" or "Phrase doesn't match"

This is read-only — no server state changes. Pure local crypto.
Encourages users to verify they wrote the phrase down correctly soon
after setup, while it's still fresh.

**Q27 (new)**: What if the user has multiple chalk accounts open in
the same browser (different users in different tabs)?

The current design assumes one chalk-user-per-tab. Multiple tabs of
the same user share state via localStorage / IndexedDB / BroadcastChannel.
Different users in different tabs: each has its own auth context,
its own master_key cache (keyed by user_id), its own IndexedDB
namespace (CoreCrypto isolates by user_id).

The localStorage key naming convention should be:
`chalk.backup.master_key.<user_id>` to allow multi-user coexistence.
Same for queue keys and mirror keys.

**Q28 (new)**: How long does the master_key stay cached in
localStorage?

Default: forever (until explicit logout or device removal). For
shared computers, the user should rely on chalk's existing logout
flow which wipes per-user state.

Optional future: auto-expire master_key cache after N days of
inactivity, requiring phrase re-entry. Tradeoff: security vs UX
friction. Defer to a future hardening phase.

---

## 14. Summary

Doc #5 specifies 9 client state machines covering the user-visible
chalk phase-11d flows:

1. **First-time setup** — generate master_key + envelope; the
   prerequisite for everything.
2. **Upload pipeline** — continuous background; EpochObserver +
   HistoryObserver + commit-ack pairing + offline-resilient queue.
3. **Recovery-phrase restore** — the multi-minute user-facing flow.
4. **Pairing-based restore** — short online handoff + delegation to
   Flow 3's download portion.
5. **Phrase rotation** — preserve master_key, change wrap.
6. **Critical event lifecycle** — local mirror with cross-device sync
   discipline.
7. **Device removal** — initiator-side.
8. **Restore cancellation** — safe abort from any restore state.
9. **Self-add** — existing devices add a newly-announced device to
   their groups.

Each is described with explicit states, transitions, side effects,
and failure modes. The design emphasizes:

- **Idempotency** — every flow safely re-runnable
- **Partial-success tolerance** — restore continues despite individual
  failures
- **Local mirroring** — defense against server-side dismissal of
  critical events
- **Persistence boundaries** — what survives reload, what doesn't
- **Tab coordination** — BroadcastChannel + localStorage events
  prevent duplicate work

Open questions Q25-Q28 are minor UX/policy decisions. Doc #6 (PAKE
detail) is required to fully spec Flow 4; otherwise this doc is
implementable.

End of doc #5. Vienna 2026-05-27.
