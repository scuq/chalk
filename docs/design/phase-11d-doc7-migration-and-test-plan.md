# Phase 11d Design Doc #7 — Migration & Test Plan

**Status:** Draft for review
**Author:** Claude, per scuq's design choices
**Date:** 2026-05-27 (Vienna)
**Scope:** chalk phase 11d — landing sequence (PR-level), database
migration rollout, test plan (unit + integration + end-to-end),
CoreCrypto upgrade discipline, backward compatibility, rollout
staging, verification matrix, and known limitations at v1 ship
**Depends on:** docs #1-#6

This is the operational doc that turns the design (docs #1-#6) into a
shippable implementation. It assumes the design has been reviewed and
accepted; its job is to specify HOW to land it safely.

**This doc replaces what was originally planned as doc #8.** Doc #7
(passphrase flow) was deemed redundant — the recovery-phrase flow is
already specified across docs #1 §5.3, #3 §8, and #5 Flows 1/3/5.

---

## 1. Overview

Phase 11d's implementation spans:

- **chalkd**: 4 migrations + 9 new Go files (6 handler files, 3 store
  files per doc #4 §7)
- **chalk client**: ~12 new TypeScript files (per doc #5 §12.1)
- **Wire protocol**: 34 new frames (32 from doc #2 + 2 added in
  doc #6 §5.7, §12)
- **Existing chalk surfaces touched**: `internal/proto/` (frame
  definitions), `internal/ws/` (handler registration), `internal/store/`
  (existing devices table extended)

Estimated PR count: 7 lands × ~2 PRs each = ~14 PRs to fully ship.
Each land delivers user-visible value (or unblocks the next land).

The landing sequence below is the **suggested critical path**. PRs
within a land are typically parallelizable. PRs across lands have the
dependencies listed.

---

## 2. Landing sequence

The 7 lands from doc #2 §12, expanded with concrete PR scope.

### 2.1 Land 1 — Envelope foundation

**Goal**: silent foundation. Users can store a backup envelope; the
status badge displays it. No history-secret functionality yet.

**PRs**:

| PR | Scope | Files |
|----|-------|-------|
| 1.1 | Migration 0024 `backup_envelopes` table | `migrations/0024_backup_envelopes.sql` |
| 1.2 | Wire frames + Go types for envelope family | `internal/proto/frames_phase11d.go` |
| 1.3 | Store layer for envelopes | `internal/store/backup_envelopes.go` + test |
| 1.4 | Handler `backup_envelope_get` + `backup_envelope_put` | `internal/ws/backup_envelope.go` + test |
| 1.5 | Migration 0026 `critical_events` + store + handler (needed early because Land 4 will use it; preloading reduces churn) | `migrations/0026_critical_events.sql`, `internal/store/critical_events.go`, `internal/ws/critical_events.go` |
| 1.6 | Wire frames for status family + `backup_status_get` handler | `internal/ws/backup_status.go` + cache impl |
| 1.7 | Client TS: envelope setup state machine (doc #5 Flow 1) | `src/client/backup/setup.ts` + test |
| 1.8 | Client TS: status badge UI component | (UI files) |

**Acceptance**:
- A user can run through the first-time setup wizard, generate a
  24-word phrase, confirm it, and see "Backup: On" in the status badge
- The envelope is persisted in `backup_envelopes`
- `backup_envelope_put` with wrong `expected_version` returns
  `envelope_conflict`
- Wraps array > 1024 returns `envelope_invalid`
- Envelope > 64 KB returns `envelope_too_large`

**Dependencies**: none (foundational).

### 2.2 Land 2 — History secret uploads

**Goal**: clients start uploading HistorySecrets to chalkd. No
consumer yet.

**PRs**:

| PR | Scope | Files |
|----|-------|-------|
| 2.1 | Migration 0025 `history_secrets` table | `migrations/0025_history_secrets.sql` |
| 2.2 | Wire frames for history-secrets family | `internal/proto/frames_phase11d.go` (extends) |
| 2.3 | Store layer for history_secrets | `internal/store/history_secrets.go` + test |
| 2.4 | Handler `history_secret_put` (only) | `internal/ws/history_secrets.go` + test |
| 2.5 | Client TS: EpochObserver + epochCache | `src/client/backup/upload.ts` (partial) |
| 2.6 | Client TS: HistoryObserver + secretQueue | `src/client/backup/upload.ts` (extends) |
| 2.7 | Client TS: prepareForTransport returning dummy bytes (doc #1 §8.2) | (in CoreCrypto integration) |
| 2.8 | Client TS: uploadWorker + localStorage persistence | `src/client/backup/upload.ts` (extends) |
| 2.9 | Enable history sharing by default on conversation creation (D10) | (in MLS conv creation paths) |

**Acceptance**:
- Creating a new MLS conversation triggers `enableHistorySharing`
- HistoryObserver fires; observed secret is encrypted and queued
- On `MlsTransport.sendCommitBundle` success, queued secret promotes
  to READY and uploadWorker dispatches it
- `history_secret_put` UPSERT works on duplicate
  `(user_id, conversation_id, era_epoch)`
- Offline capture queues to localStorage; reconnect drains the queue

**Dependencies**: Land 1 (envelope must exist; without it, observer
has no master_key to encrypt under).

### 2.3 Land 3 — History restore

**Goal**: a new device with the recovery phrase can restore history.

**PRs**:

| PR | Scope | Files |
|----|-------|-------|
| 3.1 | Handlers `history_secret_list` + `history_secret_get` | `internal/ws/history_secrets.go` (extends) |
| 3.2 | `backup_progress_event` push framework + rate limit | `internal/ws/backup_status.go` (extends) |
| 3.3 | Client TS: restore state machine (doc #5 Flow 3) | `src/client/backup/restore.ts` + test |
| 3.4 | Client TS: per-era decryption routing table (doc #3 §5.3) | `src/client/backup/routing.ts` |
| 3.5 | Client TS: restore progress UI | (UI files) |
| 3.6 | **Integration test**: end-to-end past-message decryption via history client (the critical untested-in-JS path per doc #1 §4.5, doc #3 §7.4) | sandbox + new integration test suite |

**Acceptance**:
- Alice writes 10 messages in a conversation
- Alice's "fresh device" enters her phrase, runs restore, downloads
  secrets, instantiates history clients
- The fresh device can decrypt all 10 of Alice's pre-existing messages
- Wrong phrase: first 10 secrets fail AEAD → restore aborts with
  WRONG_PHRASE
- Partial corruption: 1 of 50 secrets fails AEAD → restore continues
  with 49; user sees "1 era unavailable" notice
- Restore cancellation mid-flow: history clients already instantiated
  persist (Option A from doc #5 §9.2)

**Dependencies**: Lands 1 + 2.

**This land delivers the first meaningful demo**: "lose your device,
enter your phrase on a new one, get your history back." It's the
v0.1 milestone.

### 2.4 Land 4 — Critical events

**Goal**: critical events flow end-to-end including cross-device sync.

**PRs**:

| PR | Scope | Files |
|----|-------|-------|
| 4.1 | Handlers `critical_event_list` + `critical_event_ack` | `internal/ws/critical_events.go` (extends Land 1.5) |
| 4.2 | Server-side critical-event emission helpers (used by other lands) | `internal/ws/critical_events.go` |
| 4.3 | Server-side `critical_event_dismissed_event` push on ack | `internal/ws/critical_events.go` |
| 4.4 | Server-side pruning job (90d pending / 180d acked, batched per doc #4 §9.8) | `internal/scheduler/critical_events_prune.go` |
| 4.5 | Client TS: local critical-event mirror with IndexedDB persistence | `src/client/events/critical.ts` |
| 4.6 | Client TS: critical-event UI (notification bar, action buttons) | (UI files) |
| 4.7 | Emit `restore_completed` from Land 3's restore flow | (in restore handler) |
| 4.8 | Emit `history_uploads_persistently_failing` from Land 2's uploadWorker after threshold | (in uploadWorker) |

**Acceptance**:
- Trigger any critical event server-side; user sees it on all
  connected devices
- User acks on Device A; UI on Device B dismisses within ~1s
- Restart Device B mid-flow; critical-event mirror restored from
  IndexedDB
- Hostile chalkd simulation (manual test): server emits
  `critical_event_dismissed_event` for an event the user never acked
  on any owned device → client refuses to dismiss locally

**Dependencies**: Land 1.5 (critical_events table); independent of
Land 2/3 for backend, but the client UX is most useful after Lands 2
and 3 (events to display).

### 2.5 Land 5 — Pairing (online handoff)

**Goal**: new device can pair with existing device via QR code and
inherit master_key.

**Prerequisite**: doc #6 must be reviewed and accepted before this
land starts. Doc #6 also adds 2 new frames to doc #2; that update
must land first.

**PRs**:

| PR | Scope | Files |
|----|-------|-------|
| 5.0 | Update doc #2 to include `pairing_complete_event` + `pairing_claimant_confirm_event` (doc #6 §12) | (docs only) |
| 5.1 | Wire frames for all 10 pairing frames | `internal/proto/frames_phase11d.go` (extends) |
| 5.2 | In-memory PairingSession store + reaper (doc #4 §6.1) | `internal/pairing/store.go` + test |
| 5.3 | Pairing handlers — all 8 C→S frames + relay logic | `internal/ws/pairing.go` + test |
| 5.4 | Push-frame dispatch for `pairing_event`, `pairing_complete_event`, `pairing_claimant_confirm_event` | (in WS broadcaster) |
| 5.5 | Server-side `device_added_paired` critical event emission on `COMPLETED` (doc #6 §6.3 note) | (in handlers) |
| 5.6 | Client TS: initiator state machine (doc #5 Flow 4 initiator) | `src/client/pairing/initiator.ts` + test |
| 5.7 | Client TS: claimant state machine (doc #5 Flow 4 claimant) | `src/client/pairing/claimant.ts` + test |
| 5.8 | Client TS: QR-code generation (initiator UI) | (UI files) |
| 5.9 | Client TS: QR-code scanning (claimant UI; uses browser camera or platform native) | (UI files) |
| 5.10 | **Integration test**: full pairing flow with master_key delivery + AEAD verification + claimant_confirm round-trip | sandbox |

**Acceptance**:
- Two browser sessions logged in as same user — Device A and Device B
- Device A displays QR; Device B scans
- After ~5 seconds, both devices show "Paired"
- Device B has master_key cached; can now run Land 3's restore
- Device A's other connected sessions receive `device_added_paired`
  critical event
- Hostile chalkd simulation (manual test): server substitutes
  initiator's ephemeral pubkey for the claimant → claimant detects
  mismatch vs QR → aborts with `pairing_proof_invalid`
- QR code observed by camera shoulder-surf simulation: attacker (with
  separate auth) attempts to pair using observed OOB → critical
  event fires; user can revoke from original device

**Dependencies**: Lands 1, 2, 3 (pairing only makes sense if there's
backup state to inherit). Also doc #6.

### 2.6 Land 6 — Multi-device basics

**Goal**: new device announces itself; existing devices add it to
their MLS groups.

**PRs**:

| PR | Scope | Files |
|----|-------|-------|
| 6.1 | Migration 0027 — `devices` table extensions | `migrations/0027_devices_extensions.sql` |
| 6.2 | Backfill job for pre-11d devices (`origin_kind = 'initial'`) | `internal/scheduler/devices_backfill.go` |
| 6.3 | Wire frames + handlers for `device_announce` + `device_announce_event` push | `internal/ws/devices_phase11d.go` |
| 6.4 | Server-side `device_added_recovery` critical event emission for recovery-origin devices | (in handlers) |
| 6.5 | Client TS: device_announce on successful restore (Land 3) or pairing (Land 5) | (in respective flows) |
| 6.6 | Client TS: self-add state machine (doc #5 Flow 9) with jitter + stale-commit retry | `src/client/devices/self_add.ts` + test |
| 6.7 | Client TS: device_removed_event push frame (doc #4 §7.3 inconsistency: add to doc #2 first) | (doc + impl) |

**Acceptance**:
- Device B successfully restores (Land 3) or pairs (Land 5)
- Device B fires `device_announce`
- Device A receives `device_announce_event`
- Device A waits 0-30s jitter then adds Device B to all its MLS groups
- If Device A and Device C race on the same group, one wins with
  fresh commit; the other detects via stale-commit retry and confirms
  Device B is now a member (no duplicate add)
- Device B can now receive ongoing messages in all groups
- Critical event `device_added_paired` or `device_added_recovery`
  fires depending on origin_kind

**Dependencies**: Lands 1-5.

### 2.7 Land 7 — Device removal & rotation

**Goal**: user can remove devices and rotate recovery phrase.

**PRs**:

| PR | Scope | Files |
|----|-------|-------|
| 7.1 | Wire frames + handlers for `device_list` + `device_remove` + push | `internal/ws/devices_phase11d.go` (extends) |
| 7.2 | Server-side MLS-commit-to-evict logic on `device_remove` | (in handlers) |
| 7.3 | Client TS: device removal state machine (doc #5 Flow 7) | `src/client/devices/remove.ts` + test |
| 7.4 | Client TS: device list UI | (UI files) |
| 7.5 | Client TS: recovery phrase rotation state machine (doc #5 Flow 5) | `src/client/backup/rotation.ts` + test |
| 7.6 | Client TS: "Verify recovery phrase" read-only flow (doc #5 Q26) | `src/client/backup/verify.ts` |
| 7.7 | Server-side `device_removed` + `recovery_phrase_rotated` critical events | (in handlers) |
| 7.8 | Migration 0028 — `origin_kind SET NOT NULL` after grace period | `migrations/0028_devices_origin_kind_not_null.sql` (scheduled for ~30d after Land 6 ships) |

**Acceptance**:
- User in settings sees list of their devices with labels and
  fingerprints
- Removing a device triggers MLS commit; removed device's UI shows
  "this device has been signed out"
- Rotating phrase: new envelope has 2 wraps (current + expiring);
  30 days later the old wrap is automatically pruned client-side on
  next rotation OR via server housekeeping
- "Verify phrase" flow: correct phrase → "Phrase verified ✓",
  incorrect → "Phrase doesn't match" without touching server state
- After Land 6 has been deployed for 30+ days: migration 0028 runs;
  all devices have `origin_kind` populated; column becomes NOT NULL

**Dependencies**: Lands 1-6.

---

## 3. Database migration rollout

### 3.1 Migration ordering

The four phase-11d migrations + one follow-up:

| Order | Migration | When | Reversible? |
|-------|-----------|------|-------------|
| 1 | 0024 backup_envelopes | Land 1 | Yes, before Land 1 data |
| 2 | 0026 critical_events | Land 1 (early) | Yes, before Land 1 data |
| 3 | 0025 history_secrets | Land 2 | Yes, before Land 2 data |
| 4 | 0027 devices extensions | Land 6 | Yes (ALTER DROP COLUMN) |
| 5 | 0028 devices origin_kind NOT NULL | Land 7 + 30d | Yes via ALTER DROP NOT NULL |

Per doc #4 §10.4, all are forward-compatible during deployment: old
chalkd code works against the upgraded schema (new tables empty, new
columns nullable). This means **rolling deployment of chalkd is
safe** at every step.

### 3.2 Migration ordering within a single deployment

Convention: migrations apply in numbered order at chalkd startup
(existing chalk pattern). Phase-11d migrations are no different.

**Important**: 0026 (critical_events) lands BEFORE 0025
(history_secrets) numerically — i.e. 0025 is sequenced AFTER 0026
in deployment order. But Land 1 wants 0026 to ship with envelope
work, while Land 2 wants 0025 to ship later.

Two options:

- **Option A**: ship 0024 and 0026 together in Land 1 (skipping 0025
  numerically). Migration 0025 lands later with Land 2. This is fine
  because PostgreSQL applies in numerical order regardless of when
  they were committed.
- **Option B**: renumber. Land 1: 0024 envelopes + 0025 critical
  events. Land 2: 0026 history secrets. Re-do the table → number
  mapping in doc #4.

**Recommendation**: Option A. The chalk migrations directory is
already a sparse list (we skip numbers when phases overlap, per
chalk's existing convention). Don't renumber.

### 3.3 Rolling deployment behavior

When chalkd instances upgrade one at a time (canary, blue-green,
etc.), some instances see the new schema and some don't. Phase-11d's
new frames will be rejected by old instances with `unknown_frame`
errors. Clients should:
- Detect `unknown_frame` for any phase-11d frame as "this chalkd
  doesn't support phase 11d yet"
- Suppress retries; queue the operation client-side
- Display a "syncing in progress" UI rather than an error

Once all chalkd instances are upgraded, the operations drain
naturally.

For migrations themselves: existing chalk migration tooling applies
each migration once per database. With a shared PostgreSQL, the
first chalkd instance to start with the new code runs the
migration; subsequent instances skip (already applied). All
instances then operate on the upgraded schema.

### 3.4 Migration verification

After each migration applies in production:

```sql
-- Verify the table exists and has expected columns
\d backup_envelopes
\d history_secrets
\d critical_events
\d devices

-- Verify constraints
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid IN ('backup_envelopes'::regclass, 'history_secrets'::regclass, 'critical_events'::regclass)
ORDER BY conname;

-- Verify indexes
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename IN ('backup_envelopes', 'history_secrets', 'critical_events', 'devices');
```

Compare output to expected from doc #4 §§2-5. Any mismatch → halt
deployment, investigate.

---

## 4. Test plan

### 4.1 Three tiers

**Unit tests**: isolated logic, mocked dependencies. Fast (< 1s
each). Run on every PR. Located in standard chalk locations
(`_test.go` siblings, `*.test.ts` siblings).

**Integration tests**: real CoreCrypto + real PostgreSQL + real WS,
but in-process. Run on every PR; takes a few minutes total. Located
in `tests/integration/phase11d/`.

**End-to-end tests**: multi-process (real chalkd + real chalk client)
exercising user-facing scenarios. Run nightly + on release branches.
Located in `tests/e2e/phase11d/`.

### 4.2 Unit test coverage

Per-land unit test targets:

| Land | Component | Test count target |
|------|-----------|-------------------|
| 1 | Envelope schema/serde/wraps validation | ~15 |
| 1 | Setup state machine transitions | ~25 |
| 1 | Status cache invalidation | ~10 |
| 2 | EpochObserver epoch cache | ~8 |
| 2 | HistoryObserver capture path | ~12 |
| 2 | secretQueue state transitions | ~20 |
| 2 | uploadWorker retry logic | ~15 |
| 3 | Restore state machine | ~30 |
| 3 | Per-era decryption routing | ~15 |
| 4 | Critical event mirror | ~25 |
| 4 | Cross-device dismissal validation | ~10 |
| 5 | Pairing initiator state machine | ~20 |
| 5 | Pairing claimant state machine | ~20 |
| 5 | Pairing proof verification | ~10 |
| 6 | Self-add jitter/retry | ~12 |
| 7 | Rotation state machine | ~15 |
| 7 | Verify-phrase flow | ~5 |

Target total: ~270 unit tests.

### 4.3 Integration tests

The critical end-to-end paths that the sandbox approach (per
`/home/claude/sandbox-history/`) enables:

| ID | Scenario | Doc reference |
|----|----------|---------------|
| IT1 | Alice→Alice via pairing restore | doc #5 §12.2 |
| IT2 | Alice→Alice via recovery-phrase restore | doc #5 §12.2 |
| IT3 | Recovery rotation; old phrase works for 30 days; new phrase works forever | doc #5 §12.2 |
| IT4 | Carol joins group; restores; can decrypt post-join only | doc #5 §12.2 |
| IT5 | Mid-restore cancellation; resume succeeds | doc #5 §12.2 |
| IT6 | Network drop mid-upload; reconnect drains queue | doc #5 §12.2 |
| IT7 | End-to-end past-message decryption via history client (NEW JS-side coverage) | doc #1 §4.5 |
| IT8 | EpochObserver fires before HistoryObserver (ordering assumption) | doc #1 Q15 |
| IT9 | Multiple history-client rotations in series produce monotonic-ordered observer fires | doc #1 Q16 |
| IT10 | Commit rejection by DS drops pending uploads (no orphaned ciphertexts) | doc #3 §4.3 |
| IT11 | prepareForTransport returning dummy bytes doesn't break sender or receiver | doc #1 §8.2 |
| IT12 | UPSERT on duplicate `(user_id, conversation_id, era_epoch)` works correctly | doc #4 §3.1 |
| IT13 | Pairing with hostile chalkd substituting pubkeys → claimant aborts | doc #6 §7.4 |
| IT14 | Pairing with observed OOB but separate-auth attacker → critical event fires | doc #6 §7.5 |
| IT15 | Critical event ack on device A dismisses on device B | doc #4 §9.3 |
| IT16 | Hostile chalkd emits dismissed_event for unacked event → client refuses local dismiss | doc #1 §8.4 |
| IT17 | Self-add race: two existing devices try to add same new device to same group; one wins, the other detects via stale-commit | doc #5 §10.2 |
| IT18 | Pre-11d device backfilled to `origin_kind = 'initial'` | doc #4 §5.1 |
| IT19 | CoreCrypto version mismatch on restore: producing_corecrypto_version recorded; restore proceeds best-effort | doc #3 §6.3 |
| IT20 | Tab coordination: two tabs of same user share epochCache via BroadcastChannel | doc #5 §3.9 |

Each test is implemented in the sandbox harness (`/home/claude/sandbox-history/`
pattern, expanded). Target runtime: full suite < 5 minutes.

### 4.4 End-to-end tests

Full chalkd + chalk client flows, run against a staging deployment.
These are slower (~30 minutes total) and exercise UX paths.

| ID | Scenario |
|----|----------|
| E2E1 | Fresh user signs up; completes phase-11d setup; sends message; verifies status badge |
| E2E2 | User on Device A loses access; on Device B (browser, fresh) enters recovery phrase; sees full history within 5 minutes |
| E2E3 | User on Device A pairs Device B via QR code; both devices show updated device list within 30s |
| E2E4 | User rotates recovery phrase; on Device C, verifies new phrase works and old works for 30d |
| E2E5 | User removes Device B from Device A; Device B's UI shows signed-out state within 1 minute |
| E2E6 | Multiple devices race on adding a new device to 20+ MLS groups; all 20+ groups end up with the new device as a member |

E2E tests run nightly. Failures page on-call.

### 4.5 Test data and fixtures

**Sandbox harness**: existing at `/home/claude/sandbox-history/`.
Expand with:
- A multi-conversation harness (currently single-conversation)
- A multi-device harness (currently mostly Alice-only)
- Synthetic chalkd replacement that simulates honest, hostile, or
  offline server behavior

**Postgres test DB**: per-test-suite ephemeral databases (chalk's
existing test convention).

**MLS group fixtures**: pre-built `.mls` state files for groups at
various sizes (2, 10, 100 members) and various ages (10, 100, 1000
messages).

---

## 5. CoreCrypto upgrade discipline

Per doc #3 §6.4, every CoreCrypto version bump in a future chalk
release must follow this checklist:

### 5.1 Pre-upgrade checklist

1. **Read the CoreCrypto changelog** for the version range. Identify
   any history-sharing API changes, observer behavior changes, or
   FFI-shape changes.

2. **Update the sandbox** to the new version:
   ```sh
   cd /home/claude/sandbox-history
   npm install @wireapp/core-crypto@<new_version>
   node test-a-enable.mjs   # must pass
   node test-b-history-client.mjs  # must pass
   node test-c2-roundtrip.mjs  # must pass
   ```
   If any fail, do not proceed.

3. **Run the integration test suite** (§4.3 above) against the new
   CoreCrypto version. All must pass.

4. **Test cross-version compatibility**:
   - Spin up two harness instances: one on old CoreCrypto, one on new
   - Old produces a HistorySecret (Alice's device)
   - New receives it via download + decrypt + historyClient()
   - New decrypts a message from old (must succeed)
   - If this fails, the upgrade is a breaking change for existing
     stored secrets. See §5.2.

### 5.2 Breaking-change response

If a CoreCrypto upgrade breaks consumption of existing stored
HistorySecrets:

1. **Do NOT release the chalk upgrade**.
2. Coordinate with Wire: either back-port the fix to CoreCrypto, or
   accept that existing secrets are now unrecoverable on devices
   running the new version.
3. If unrecoverable: emit a critical event to all affected users
   warning them that history before the upgrade is unavailable on
   devices updated to the new client.
4. Existing devices that DON'T upgrade continue to work; their
   uploaded secrets stay readable by themselves.
5. Document in chalk's release notes prominently.

This is operational discipline, not a magic property. CoreCrypto
upgrades are risky. Treat them like database schema migrations.

### 5.3 producing_corecrypto_version field

Every uploaded HistorySecret carries the CoreCrypto version that
produced it (doc #2 §3.2, doc #3 §6.3). On restore, the new device
logs the version of each secret and warns if it's significantly
ahead of the current client. Operationally:

```sql
-- Identify users with secrets from versions newer than our current
SELECT user_id, MAX(producing_corecrypto_version)
FROM history_secrets
GROUP BY user_id
HAVING MAX(producing_corecrypto_version) > '<current_chalk_corecrypto_version>';
```

This query identifies users who upgraded chalk on one device but not
others. Useful for support ("user X reports missing history" — check
if their other device is running ahead).

---

## 6. Backward compatibility

### 6.1 Pre-11d devices

Devices that registered before phase 11d ships exist in chalk's
`devices` table without the new columns. Migration 0027 adds the
columns as nullable; the backfill job sets `origin_kind = 'initial'`.

Users with ONLY pre-11d devices and no current backup:
- See the setup prompt on their next chalk session (Land 1 UI)
- Can run setup; their existing conversations get history sharing
  enabled (D10) from that moment on
- **CANNOT recover history from BEFORE the setup**. Doc #1 §4.1 makes
  this explicit; the chalk UI must communicate this clearly: "History
  from before <date> will not be available on new devices."

### 6.2 Mid-deployment client/server mismatch

While chalk client and chalkd are rolling out independently:

- Old client + new chalkd: client doesn't send any phase-11d frames;
  works normally. Server tables stay empty for this user.
- New client + old chalkd: client sends phase-11d frames; chalkd
  rejects with `unknown_frame`. Client per §3.3 suppresses retries
  and shows "syncing in progress" UI. Once chalkd upgrades, queued
  operations drain.
- New client + new chalkd at version mismatch (e.g. chalkd has Land 1
  but client expects Land 3): subset works. Setup OK; restore fails.
  Mitigate by feature-flagging client UI based on chalkd version (a
  `chalkd_version` field in the WS handshake; existing chalk pattern).

### 6.3 Pre-existing conversations

Conversations created before phase 11d ships:
- `enableHistorySharing` was never called on them
- No HistorySecrets exist for them on chalkd
- New devices CANNOT decrypt history from these conversations, ever

When chalk client upgrades to support phase 11d, it should
**automatically enable history sharing on all existing MLS
conversations** on its next session. From that moment, history
sharing is on; new devices see history from then on, but not before.

Implementation: on chalk launch (post-upgrade), for each conversation
the client is a member of:

```typescript
const enabled = await cc.isHistorySharingEnabled(convId);
if (!enabled) {
  await withCommitContext(() => cc.enableHistorySharing(convId));
}
```

This is a one-time scan per device. Subsequent launches skip
already-enabled conversations.

### 6.4 Mixed-client conversations

A conversation may have some members on phase-11d-aware clients and
some on old clients. The old clients:
- Will receive the MLS commit that adds the history client (since
  it's a normal MLS member-add)
- Will NOT know to capture the in-band HistorySecret payload (but per
  doc #1 §8.2 / doc #3 §4.6, we return dummy bytes anyway, so there's
  nothing useful to capture)
- Will continue to send/receive messages normally

Result: old clients are unaffected by phase-11d activity. They simply
don't participate in history backup themselves.

When an old client eventually upgrades, their conversations will be
auto-enabled per §6.3 on launch.

---

## 7. Rollout staging

### 7.1 Feature flags

Each land's user-visible features are gated by a server-controlled
flag, evaluated on WS handshake:

```typescript
interface PhaseFlags {
  phase11d_setup_enabled: boolean;       // gates Land 1 UI
  phase11d_restore_enabled: boolean;     // gates Land 3 UI
  phase11d_critical_events: boolean;     // gates Land 4 UI
  phase11d_pairing_enabled: boolean;     // gates Land 5 UI
  phase11d_multidevice_enabled: boolean; // gates Lands 6/7 UI
}
```

Background flows (Land 2 upload pipeline) run unconditionally once
the code is deployed — they're invisible to users until restore is
enabled.

Default values during rollout:
- Initial deploy: all flags false. Code ships; nothing user-visible.
- After integration tests pass in staging: flags true for internal
  users only (Wire/chalk team identifiers).
- Canary rollout: flags true for 1% of users.
- General availability: flags true for all.

### 7.2 Per-land rollout sequence

Suggested cadence (calendar time, not engineering time):

| Land | After previous lands stable for | Rollout window |
|------|--------------------------------|----------------|
| 1 | n/a | 1 week internal, 1 week canary, 2 week GA |
| 2 | Land 1 stable 2 weeks | 1 week internal (no UI yet), straight to GA (no user impact) |
| 3 | Land 2 stable 2 weeks | 1 week internal, 2 weeks canary, 2 week GA |
| 4 | Land 3 stable 1 week | 1 week internal, 1 week canary, 1 week GA |
| 5 | Land 4 stable 1 week + doc #6 reviewed | 2 weeks internal, 2 weeks canary, 2 week GA |
| 6 | Land 5 stable 2 weeks | 1 week internal, 2 weeks canary, 1 week GA |
| 7 | Land 6 stable 4 weeks | 1 week internal, 1 week canary, 1 week GA |

Total calendar time: ~5-6 months from Land 1 start to Land 7 GA.

### 7.3 Observability gates

Before promoting any rollout stage:
- Error rate on phase-11d frames < 0.5% over the last 24 hours
- No new high-severity bug reports in the previous stage
- Sentry/equivalent error-tracking shows no unhandled exceptions in
  phase-11d code paths
- For Lands 2/3: % of users with at least one HistorySecret uploaded
  is increasing as expected
- For Land 5: critical event ack rate ≥ 95% (users are seeing and
  responding to pair notifications)

### 7.4 Rollback strategy

If a problem is detected:
- **Per-flag rollback**: flip the relevant `phase11d_*_enabled` flag
  to false. New users see the feature as unavailable; existing users
  retain access if they're mid-flow (graceful degradation).
- **Per-instance rollback**: revert chalkd to the previous version.
  Per §3.3 this is safe because migrations are forward-compatible.
- **Per-client rollback**: ship a chalk client release that disables
  the feature client-side. Slower (depends on update propagation).

For data corruption issues (e.g. a bug causes incorrect
HistorySecret encryption): see §8 emergency response.

---

## 8. Emergency response

### 8.1 Data-corruption scenarios

If a chalk client bug causes incorrect HistorySecret uploads (e.g.
encrypting under the wrong key, malformed ciphertext, wrong AAD):

1. **Detect**: server-side AEAD-tag validity tests on a sampling
   basis (if enabled), OR user reports.
2. **Halt**: flip `phase11d_setup_enabled = false` to stop new users.
   Existing users continue uploading via Land 2 pipeline.
3. **Identify**: query `history_secrets` for entries from the bad
   client version (via `producing_corecrypto_version` plus chalk
   client version tracking).
4. **Quarantine**: rename the bad entries to a `history_secrets_quarantine`
   table; do NOT serve them on `history_secret_get`.
5. **Fix**: release patched client; users' future uploads are good.
6. **Inform**: emit a critical event explaining that history before
   <date> may be unavailable; offer them the option to delete the
   quarantined entries.

### 8.2 chalkd-side outage

If chalkd is down, clients queue uploads in localStorage (doc #5
§3.7) and drain on reconnect. No data loss as long as the user's
browser doesn't clear localStorage. Document this in chalkd's
deployment playbook: "phase-11d uploads tolerate outages of up to
N hours/days assuming users don't clear browser data."

### 8.3 Mass compromise scenarios

If we detect a chalkd-side compromise event (database leak, key
exfiltration):

- **Recovery phrases were never on chalkd; they're safe.**
- **Envelopes were leaked**: wraps are encrypted under
  recovery-phrase-derived keys. Argon2id makes brute-force expensive
  but not impossible. Users SHOULD rotate (doc #5 Flow 5).
- **HistorySecrets were leaked**: ciphertexts encrypted under
  master_key. master_key wasn't on chalkd. Secrets remain
  confidential UNLESS the envelope was ALSO leaked AND the user's
  recovery phrase has insufficient entropy (BIP-39 24-word phrase
  has 256 bits; this is not the issue).
- **Master_keys never were on chalkd.** No path to plaintext history
  via chalkd compromise alone.

Response: emit a critical event to all users informing them; offer
proactive recovery-phrase rotation. Per doc #1 §8.6, master_key
rotation is a manual operations procedure if ever needed.

---

## 9. Verification matrix

Every assumption flagged as "needs integration testing" across the
design docs, gathered into one checklist:

| ID | Assumption | Source | How verified | Status |
|----|------------|--------|--------------|--------|
| VM1 | EpochObserver fires before HistoryObserver for the same epoch advance | doc #1 Q15, doc #5 §3.4 | IT8 | Pending |
| VM2 | HistoryObserver fires are deterministically ordered across rapid rotations | doc #1 Q16 | IT9 | Pending |
| VM3 | CoreCrypto.historyClient() can decrypt past messages from its era | doc #1 §4.5, doc #3 §7.4 | IT7 | Pending |
| VM4 | prepareForTransport returning dummy bytes doesn't break sender flow | doc #1 §8.2, doc #3 §4.6 | IT11 | Pending |
| VM5 | prepareForTransport returning dummy bytes doesn't break receiver flow | doc #1 §8.2, doc #3 §4.6 | IT11 | Pending |
| VM6 | Within one withCommitContext block, CoreCrypto produces at most one commit | doc #5 §3.5 | IT9 indirectly | Pending |
| VM7 | DS commit rejection correctly propagates to MlsTransport.sendCommitBundle result | doc #5 §3.5 | IT10 | Pending |
| VM8 | UPSERT on (user_id, conversation_id, era_epoch) handles concurrent puts gracefully | doc #4 §3.1 | IT12 | Pending |
| VM9 | Pairing proof verification rejects substituted pubkeys | doc #6 §7.4 | IT13 | Pending |
| VM10 | Stale-commit retry on self-add converges correctly | doc #5 §10.2 | IT17 | Pending |
| VM11 | Critical event mirror persists across reload and restores correctly | doc #4 §9.3, doc #5 §7.5 | IT15 | Pending |
| VM12 | Hostile dismissed_event refused without local mirror evidence | doc #1 §8.4 | IT16 | Pending |
| VM13 | localStorage queue persistence survives crash mid-upload | doc #5 §3.7 | IT6 | Pending |
| VM14 | Tab BroadcastChannel sync keeps epochCache consistent | doc #5 §3.9 | IT20 | Pending |
| VM15 | Pre-11d device backfill correctly sets origin_kind = 'initial' | doc #4 §5.1 | IT18 | Pending |
| VM16 | producing_corecrypto_version is preserved correctly through upload + restore | doc #3 §6.3 | IT19 | Pending |
| VM17 | CSPRNG is available; absence aborts cleanly | doc #1 §8.1 | unit test | Pending |
| VM18 | Argon2id parameters produce ~1s derivation on a typical client | doc #1 §5.1 | benchmark | Pending |

Before each Land's general-availability rollout: confirm all matrix
items relevant to that Land are verified. Track in chalk's PR
tracker as link-back from this doc.

---

## 10. Known limitations at v1 ship

These are user-visible behaviors of phase-11d v1 that must be
documented in chalk's release notes:

1. **History from BEFORE phase-11d setup is unrecoverable.** New
   devices see only post-setup messages. Existing conversations need
   chalk client upgrade to start participating in history sharing.

2. **History sharing is per-conversation.** A user in 50 groups has
   50 independent history-client lineages. Some groups may have
   sharing enabled and others not (if conversation auto-enable hasn't
   run yet).

3. **Restore is one-shot per device.** No incremental "restore last
   30 days" option; restore downloads everything or nothing.

4. **Recovery phrase is 24 words.** Users must write it down on
   paper. No alternative (no passkey, no email recovery) in v1.

5. **QR code pairing only.** No PIN-based pairing. Devices must have
   a screen (initiator) and camera (claimant) to pair online.

6. **5-minute pairing window.** Users must complete pairing within
   5 minutes of QR generation or restart.

7. **No real-time history sync across devices.** A new message on
   Device A is decryptable on Device B only after Device B has been
   added to the group via Self-add (Land 6). For BACKLOG: Device B
   needs the appropriate history client.

8. **Master_key never rotates automatically.** Compromise response
   requires manual ops procedure (doc #1 §8.6).

9. **CoreCrypto upgrades may invalidate stored secrets.** Documented
   in §5 above; operational discipline required.

10. **Storage grows indefinitely.** Per doc #1 §4.3: a user with
    many active conversations accumulates many HistorySecrets. We
    accept this; no auto-pruning.

11. **Sub-optimal restore performance.** 5000 history clients =
    ~4 minutes wall-clock per doc #5 §4.5. Acceptable for v1; may
    optimize via lazy instantiation in v2.

12. **`prepareForTransport` returns dummy bytes**, neutralizing the
    in-band MLS delivery path. This is a security-positive change
    (doc #1 §8.2) but does mean existing CoreCrypto JS test patterns
    that expect to receive HistorySecret-as-app-message won't work in
    chalk's deployment.

13. **`device_removed_event` push frame**: pending doc #2 update (see
    doc #4 §7.3). Until that lands, the device list UI refresh after
    removal relies on the `device_removed` critical event rather
    than a dedicated push.

These limitations are intentional v1 scope. Each has a "future
hardening" or "v2" path noted in the relevant doc.

---

## 11. Open questions

**Q33**: Should phase-11d migrations land all at once (single chalkd
release with all four) or staged across releases?

Recommendation: staged. Lands 1, 2, 3 in separate chalkd releases
allows verifying each in production before the next migration runs.
Each migration is forward-compatible (per §3.1), so this is safe.

**Q34**: What's chalk's existing convention for feature flags? Is
there a flag-eval service, or are flags hardcoded in chalkd config?

Defer — depends on chalk's existing infrastructure. If no flag
infrastructure exists, recommend simple per-user-cohort hardcoded
flags in chalkd config, with cohorts adjustable via deployment.

**Q35**: Do we need a "Phase 11d Privacy Statement" public-facing
document?

Yes, recommended. Users need to understand:
- What's stored on chalkd (encrypted backup material)
- What chalkd can/cannot see (cannot read messages, can see metadata)
- What happens if they lose their recovery phrase (no recovery
  possible)
- What happens if chalkd is compromised (master_key never on chalkd;
  story varies — see §8.3)

Draft separately from this doc; that's a marketing/legal concern as
much as engineering.

**Q36**: What's the support burden estimate for "I lost my recovery
phrase" requests?

Per doc #1 §2.4 (non-goals): no recovery is possible without the
phrase. Support
can only direct users to "set up backup fresh on a new device."
Expect a meaningful volume of these requests in the first few months
after Lands 1-3 ship. Prepare support documentation and macros.

---

## 12. Summary

Doc #7 specifies the operational path from accepted design to
shipped v1:

- **7 lands** (~14 PRs total) covering envelope → upload → restore →
  events → pairing → multi-device → removal
- **4 migrations + 1 follow-up** (0024-0028) applied in numerical
  order during rolling deployment, all forward-compatible
- **Three tiers of tests** (unit, integration, E2E) with ~270 unit
  tests and 20 integration scenarios identified
- **CoreCrypto upgrade discipline** with mandatory cross-version
  compatibility testing
- **Backward compatibility** for pre-11d devices, mid-deployment
  client/server mismatches, and pre-existing conversations
- **Rollout staging** with feature flags and per-land calendar
  estimates (~5-6 months Land 1 to Land 7 GA)
- **Emergency response** playbooks for data corruption, outages,
  and mass-compromise scenarios
- **Verification matrix** of 18 assumptions to confirm before
  general availability of each land
- **13 known v1 limitations** for release notes

After this doc lands and gets review, the design phase is complete.
Implementation can start on Land 1 PRs immediately.

End of doc #7. Vienna 2026-05-28.
