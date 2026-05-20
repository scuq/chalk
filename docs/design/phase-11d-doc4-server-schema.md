# Phase 11d Design Doc #4 — Server Schema & Endpoints

**Status:** Draft for review
**Author:** Claude, per scuq's design choices
**Date:** 2026-05-27 (Vienna)
**Scope:** chalk phase 11d — chalkd's database schema, indexes,
retention policies, and handler layout for the 32 wire frames defined
in doc #2
**Depends on:** doc #1 (threat model, security considerations), doc #2
(wire protocol), doc #3 (HistorySecret format)

This document defines the server-side persistence and request-handling
surface for phase 11d. It is the bridge between the wire protocol
(doc #2, abstract frames) and the actual chalkd Go code that handles
those frames (handler layout described in §6, full implementation
deferred to landing PRs).

The schema additions are designed to slot into chalk's existing
migration sequence. Latest committed migration is `0021_key_packages.sql`
(phase 11a). Phases 11b-2 and 11b-3 added 0022 (`mls_groups`) and
0023 (`channels.is_mls`). Phase 11d migrations start at **0024**.

---

## 1. Schema overview

Phase 11d adds **four new tables** to chalk's PostgreSQL schema:

| Table | Purpose | Lifecycle |
|-------|---------|-----------|
| `backup_envelopes` | One envelope per user wrapping `backup_master_key` | UPSERT per user; optimistic concurrency via version |
| `history_secrets` | Per-user, per-conversation, per-era encrypted HistorySecrets | UPSERT on (user_id, conversation_id, era_epoch); retained indefinitely |
| `critical_events` | Pending and recently-acked critical events per user | INSERT on emission; UPDATE on ack; TTL-pruned |
| `devices` (if not present) | Per-user device registry | Created via `device_announce`; mark-removed via `device_remove` |

It also adds **two new columns** to existing tables:

| Table | New columns | Why |
|-------|-------------|-----|
| `devices` | `fingerprint`, `origin_kind`, `removed_at`, `label` | Track device provenance and lifecycle |
| `users` | none | (For now. The envelope is keyed by user but in its own table.) |

And keeps **no in-database state** for:

- **Pairing sessions** — in-memory only, 5-minute TTL (per doc #2 §4)
- **Backup status cache** — in-memory only, 30s TTL (per doc #2 §6.1)
- **Active progress operations** — transient WS-session-bound state

These transient items are documented in §5.

---

## 2. Migration 0024 — `backup_envelopes`

```sql
-- Phase 11d: per-user backup master-key envelope.
--
-- Each user has zero or one envelope. The envelope holds the user's
-- backup_master_key wrapped under one or more per-credential keys
-- (recovery_phrase in v1, passkey_prf in v2+). The wraps_json column
-- is a JSON array of wrap objects; the server doesn't introspect
-- individual wraps beyond size validation.
--
-- Lifecycle:
--   * INSERT on first envelope setup (one per user)
--   * UPDATE on rotation, add-wrap, remove-expired-wrap
--   * DELETE is rare: only happens if the user deletes their account
--
-- Concurrency: clients pass expected_version on PUT. Server rejects
-- if the stored version is higher. Last-writer-wins is intentional
-- when versions match.

CREATE TABLE IF NOT EXISTS backup_envelopes (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    wraps_json JSONB NOT NULL,
    -- size_bytes is a denormalized count used for status queries
    -- without parsing JSON. Updated on every write.
    size_bytes INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sanity check: wraps_json must be an array. We don't validate
-- individual wrap objects in SQL (that's handler-level).
ALTER TABLE backup_envelopes
    ADD CONSTRAINT backup_envelopes_wraps_is_array
    CHECK (jsonb_typeof(wraps_json) = 'array');

-- Hard size cap matching doc #2 §9 (≤ 64 KB).
ALTER TABLE backup_envelopes
    ADD CONSTRAINT backup_envelopes_size_cap
    CHECK (size_bytes <= 65536);

-- Trigger to keep updated_at fresh.
CREATE OR REPLACE FUNCTION update_backup_envelope_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER backup_envelopes_updated_at
    BEFORE UPDATE ON backup_envelopes
    FOR EACH ROW EXECUTE FUNCTION update_backup_envelope_timestamp();
```

### 2.1 Query patterns

- **GET** (handler for `backup_envelope_get`):
  ```sql
  SELECT version, wraps_json, updated_at
  FROM backup_envelopes
  WHERE user_id = $1;
  ```

- **PUT with optimistic concurrency** (handler for
  `backup_envelope_put`):
  ```sql
  INSERT INTO backup_envelopes (user_id, version, wraps_json, size_bytes)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (user_id) DO UPDATE
    SET version = EXCLUDED.version,
        wraps_json = EXCLUDED.wraps_json,
        size_bytes = EXCLUDED.size_bytes
    WHERE backup_envelopes.version = $5;  -- expected_version
  ```
  If the WHERE clause doesn't match (concurrent update), return
  `envelope_conflict` error.

- **DELETE** (account deletion):
  Cascaded via `ON DELETE CASCADE` on `users(id)`.

---

## 3. Migration 0025 — `history_secrets`

```sql
-- Phase 11d: per-user, per-conversation, per-era encrypted
-- HistorySecrets.
--
-- Each row holds one HistorySecret as encrypted by the originating
-- device under the user's backup_master_key. The server treats the
-- ciphertext as opaque.
--
-- Primary key: (user_id, conversation_id, era_epoch). UPSERT
-- semantics (per Q17 in doc #1): a second put for the same triplet
-- overwrites. Last-write-wins.
--
-- Retention: indefinite. Per doc #1 §4.3, history secrets accumulate
-- over the user's account lifetime. Pruning silently breaks
-- old-history restoration for new devices, so we accept the storage
-- cost.

CREATE TABLE IF NOT EXISTS history_secrets (
    -- Composite PK
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL,
    era_epoch BIGINT NOT NULL,

    -- Server-assigned UUID for individual addressing via
    -- history_secret_get. Different from the composite PK because
    -- the descriptor exposes it to clients without exposing the
    -- composite (clients only need to know the secret_id).
    secret_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,

    -- Metadata
    envelope_version INTEGER NOT NULL,
    source_device_id UUID NOT NULL REFERENCES devices(id),
    producing_corecrypto_version TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    size_bytes INTEGER NOT NULL,

    -- The encrypted payload itself
    ciphertext BYTEA NOT NULL,
    nonce BYTEA NOT NULL,

    PRIMARY KEY (user_id, conversation_id, era_epoch)
);

-- Sanity: nonce is exactly 24 bytes (XChaCha20-Poly1305).
ALTER TABLE history_secrets
    ADD CONSTRAINT history_secrets_nonce_length
    CHECK (octet_length(nonce) = 24);

-- Sanity: ciphertext within wire ceiling (doc #2 §9, ≤ 8 KB).
ALTER TABLE history_secrets
    ADD CONSTRAINT history_secrets_ciphertext_cap
    CHECK (octet_length(ciphertext) <= 8192);

-- Sanity: era_epoch non-negative.
ALTER TABLE history_secrets
    ADD CONSTRAINT history_secrets_era_epoch_nonneg
    CHECK (era_epoch >= 0);

-- Fast lookup for history_secret_get
-- (PK already indexes the composite; we need secret_id lookup too)
CREATE UNIQUE INDEX IF NOT EXISTS history_secrets_secret_id
    ON history_secrets (secret_id);

-- Fast lookup for history_secret_list (per-user enumeration,
-- ordered by conversation + era for deterministic restore).
-- The PK index satisfies this already; explicit name for clarity:
-- queries like "WHERE user_id = $1 ORDER BY conversation_id, era_epoch"
-- use the PK index.

-- Fast lookup for history_secret_list filtered by conversation
-- (the optional filter in HistorySecretListPayload).
CREATE INDEX IF NOT EXISTS history_secrets_by_conv
    ON history_secrets (user_id, conversation_id, era_epoch);
-- Note: this is technically redundant with the PK in (user_id,
-- conversation_id, era_epoch) order. PostgreSQL CAN use the PK for
-- prefix scans, so the explicit index above can be dropped if
-- pg_stat_user_indexes confirms it's not used. Kept for now to be
-- explicit about query intent.

-- Trigger for updated_at
CREATE TRIGGER history_secrets_updated_at
    BEFORE UPDATE ON history_secrets
    FOR EACH ROW EXECUTE FUNCTION update_backup_envelope_timestamp();
    -- Reusing the function defined in migration 0024.
```

### 3.1 Query patterns

- **PUT with UPSERT** (handler for `history_secret_put`):
  ```sql
  INSERT INTO history_secrets (
      user_id, conversation_id, era_epoch,
      envelope_version, source_device_id, producing_corecrypto_version,
      size_bytes, ciphertext, nonce
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  ON CONFLICT (user_id, conversation_id, era_epoch) DO UPDATE
    SET envelope_version = EXCLUDED.envelope_version,
        source_device_id = EXCLUDED.source_device_id,
        producing_corecrypto_version = EXCLUDED.producing_corecrypto_version,
        size_bytes = EXCLUDED.size_bytes,
        ciphertext = EXCLUDED.ciphertext,
        nonce = EXCLUDED.nonce,
        updated_at = NOW()
  RETURNING secret_id;
  ```

- **LIST** (handler for `history_secret_list`):
  ```sql
  -- All secrets for the user, ordered by (conversation_id, era_epoch)
  SELECT secret_id, conversation_id, era_epoch,
         envelope_version, source_device_id, created_at,
         size_bytes, producing_corecrypto_version
  FROM history_secrets
  WHERE user_id = $1
  ORDER BY conversation_id, era_epoch ASC;

  -- Or filtered by conversation
  SELECT ...
  WHERE user_id = $1 AND conversation_id = $2
  ORDER BY era_epoch ASC;
  ```

- **GET** (handler for `history_secret_get`):
  ```sql
  SELECT user_id, conversation_id, era_epoch,
         envelope_version, source_device_id, created_at,
         producing_corecrypto_version,
         ciphertext, nonce
  FROM history_secrets
  WHERE secret_id = $1 AND user_id = $2;  -- caller-binding check
  ```
  The `AND user_id = $2` clause is critical: prevents one user from
  fetching another user's secret by guessing a UUID. (UUIDs are
  unguessable in practice, but defense in depth.)

### 3.2 Storage projections

From doc #1 §4.3: a 10-member group active for a year with weekly
membership changes and daily rotation has ~400 eras. Each secret is
~1.1 KB. So ~450 KB per group.

For chalkd storage planning:
- Active user with 50 groups, average 100 eras each = 5,000 secrets =
  ~5.5 MB per user.
- 10,000 such users = ~55 GB total. PostgreSQL handles this without
  trouble; the larger row count is more of a concern for index
  size, but the PK index on (user_id, conversation_id, era_epoch) is
  bounded by N_rows × ~40 bytes/entry = ~200 MB. Manageable.

### 3.3 Backup of history_secrets (operations note)

This table is critical user data. chalk's standard PostgreSQL backup
strategy must include it. A user's history is unrecoverable if
history_secrets data is lost. Document this in operations runbooks.

---

## 4. Migration 0026 — `critical_events`

```sql
-- Phase 11d: per-user critical events requiring user acknowledgment.
--
-- Critical events are server-generated, high-importance notifications
-- (device added, recovery rotated, restore completed, etc.) that
-- must be explicitly acked by the user on some device. Cross-device
-- sync: once acked anywhere, dismissed everywhere.
--
-- Lifecycle:
--   * INSERT on emission (server-side action triggers it)
--   * UPDATE on ack (sets acked_at, acked_by_device_id, action_id)
--   * Auto-purge: pending events past 90d; acked events past 180d.
--     Both via a scheduled cleanup job (not in DB, in handler code).

CREATE TABLE IF NOT EXISTS critical_events (
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,

    -- Context is a kind-specific JSON object. Server-readable
    -- (e.g. to surface device_id in operational dashboards).
    context_json JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Action options offered to the user (action_id + label + kind +
    -- followup, per doc #2's CriticalEventAction shape).
    actions_json JSONB NOT NULL DEFAULT '[]'::jsonb,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Acknowledgment state (NULL = pending)
    acked_at TIMESTAMPTZ,
    acked_by_device_id UUID REFERENCES devices(id),
    acked_action_id TEXT
);

-- Sanity: kind in allowlist
ALTER TABLE critical_events
    ADD CONSTRAINT critical_events_kind_allowed
    CHECK (kind IN (
        'device_added_paired',
        'device_added_recovery',
        'device_removed',
        'recovery_phrase_rotated',
        'history_uploads_persistently_failing',
        'restore_completed'
    ));

-- Sanity: severity in allowlist
ALTER TABLE critical_events
    ADD CONSTRAINT critical_events_severity_allowed
    CHECK (severity IN ('info', 'warning', 'alert', 'critical'));

-- Sanity: if acked, all three ack fields are present
ALTER TABLE critical_events
    ADD CONSTRAINT critical_events_ack_complete
    CHECK (
        (acked_at IS NULL AND acked_by_device_id IS NULL AND acked_action_id IS NULL)
        OR
        (acked_at IS NOT NULL AND acked_by_device_id IS NOT NULL AND acked_action_id IS NOT NULL)
    );

-- Fast lookup: pending events for user (the critical_event_list query)
CREATE INDEX IF NOT EXISTS critical_events_pending
    ON critical_events (user_id, created_at DESC)
    WHERE acked_at IS NULL;

-- Fast count: pending event count for status badge
-- Same partial index covers this.

-- Fast lookup for retention pruning
CREATE INDEX IF NOT EXISTS critical_events_for_pruning_pending
    ON critical_events (created_at)
    WHERE acked_at IS NULL;

CREATE INDEX IF NOT EXISTS critical_events_for_pruning_acked
    ON critical_events (acked_at)
    WHERE acked_at IS NOT NULL;
```

### 4.1 Query patterns

- **EMIT** (server-side, triggered by various flows):
  ```sql
  INSERT INTO critical_events (user_id, kind, severity, title, body, context_json, actions_json)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  RETURNING event_id, created_at;
  ```

- **LIST pending** (`critical_event_list`):
  ```sql
  SELECT event_id, kind, severity, title, body, context_json, actions_json, created_at
  FROM critical_events
  WHERE user_id = $1 AND acked_at IS NULL
  ORDER BY created_at ASC;
  ```

- **ACK** (`critical_event_ack`):
  ```sql
  UPDATE critical_events
  SET acked_at = NOW(),
      acked_by_device_id = $1,
      acked_action_id = $2
  WHERE event_id = $3
    AND user_id = $4         -- caller-binding
    AND acked_at IS NULL     -- not already acked
  RETURNING event_id, acked_at;
  ```
  If 0 rows updated and event exists, return
  `critical_event_already_acked`. If event doesn't exist, return
  `critical_event_not_found`. If action_id isn't in the event's
  allowed actions, return `critical_event_action_invalid` (validate
  before the SQL).

### 4.2 Pruning job

A scheduled task (run hourly, e.g. via chalkd's existing scheduler):

```sql
-- Prune pending events older than 90 days
DELETE FROM critical_events
WHERE acked_at IS NULL AND created_at < NOW() - INTERVAL '90 days';

-- Prune acked events older than 180 days
DELETE FROM critical_events
WHERE acked_at IS NOT NULL AND acked_at < NOW() - INTERVAL '180 days';
```

Both queries are covered by the partial indexes defined above. They
should be fast even on tables with millions of rows.

---

## 5. Migration 0027 — `devices` extensions

The `devices` table exists in chalk as of phase 02-ish (predating
phase 11d). Phase 11d adds new columns and enforces some new
invariants:

```sql
-- Phase 11d: extend devices table for multi-device support.
--
-- Adds:
--   * fingerprint: SHA-256 of MLS signature public key. Used in
--     critical events and in the devices UI.
--   * origin_kind: how the device was added ("paired" via online
--     handoff or "recovery" via 24-word phrase). Affects critical
--     event severity.
--   * removed_at: when the device was marked removed. NULL = active.
--     Removed devices stay in the table for audit; their KP rows
--     get marked unusable via the existing key_packages.used_at field.
--   * label: optional user-supplied human-readable name.
--
-- The first phase-11d device (per user) is whichever device first
-- runs the phase-11d announce flow.

ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS fingerprint BYTEA,
    ADD COLUMN IF NOT EXISTS origin_kind TEXT,
    ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS label TEXT;

-- origin_kind allowlist
ALTER TABLE devices
    ADD CONSTRAINT devices_origin_kind_allowed
    CHECK (origin_kind IS NULL OR origin_kind IN ('paired', 'recovery', 'initial'));
    -- 'initial' for the user's first-ever device (before pairing
    -- existed); allows backfill of pre-11d devices.

-- fingerprint is 32 bytes (SHA-256)
ALTER TABLE devices
    ADD CONSTRAINT devices_fingerprint_length
    CHECK (fingerprint IS NULL OR octet_length(fingerprint) = 32);

-- Fast lookup: active devices for a user
CREATE INDEX IF NOT EXISTS devices_active_by_user
    ON devices (user_id)
    WHERE removed_at IS NULL;

-- Fast count: device count per user (for the 32-device limit)
-- Same partial index covers this.
```

### 5.1 Backfilling existing devices

Devices created before phase 11d have NULL `fingerprint`,
`origin_kind`, and `label`. On the first phase-11d announce flow per
user, the chalkd code should backfill their existing devices' rows
with:
- `origin_kind = 'initial'`
- `fingerprint = NULL` (we never captured it pre-11d; surfaces as
  "unknown fingerprint" in the UI)
- `label = NULL`

No data loss; just incomplete records for pre-11d devices.

---

## 6. In-memory state (not in database)

### 6.1 Pairing sessions

Pairing involves several in-flight WS exchanges with limited
lifetime. Storing this in PostgreSQL would be overkill (writes per
keystroke during ECDH exchange, 5-minute TTL).

Recommended in-memory structure:

```go
// In internal/pairing/ (new package for phase 11d)
type PairingSession struct {
    PairingID         string    // UUID
    UserID            string    // UUID
    OldDeviceID       string    // UUID
    NewDeviceID       string    // nullable until claim
    OldEphemeralPubKey []byte
    NewEphemeralPubKey []byte   // populated on claim
    Kind              string    // "qr" or "pin"
    CreatedAt         time.Time
    ExpiresAt         time.Time
    Status            PairingStatus // offered, claimed, completed, cancelled
}

type PairingSessionStore struct {
    mu       sync.RWMutex
    sessions map[string]*PairingSession
}
```

The store runs a background reaper that purges expired sessions
every 30 seconds. Sessions are never persisted; a chalkd restart
invalidates all in-flight pairings (users would have to restart
the pairing flow). Acceptable given the 5-minute TTL.

### 6.2 Backup status cache

`backup_status_get` runs frequently (tab focus, periodic polling).
Computing the full status from scratch each call hits 3-4 tables.
Cache the response per user, 30s TTL:

```go
type BackupStatusCache struct {
    mu      sync.RWMutex
    entries map[string]*BackupStatusCacheEntry // keyed by user_id
}

type BackupStatusCacheEntry struct {
    Payload   *BackupStatusGetAckPayload
    CachedAt  time.Time
    ExpiresAt time.Time
}
```

Invalidation triggers (clear the per-user entry):
- `backup_envelope_put` for user
- `history_secret_put` for user
- `critical_event_ack` for user
- New critical event emitted for user
- Device added or removed for user

These invalidations must happen IN the same handler that does the
DB write. Stale cache + new event = users see "0 pending" while a
real event exists.

### 6.3 Progress operation state

`backup_progress_event` pushes are tied to a specific WS connection's
in-flight restore operation. State:

```go
type RestoreOperation struct {
    OperationID    string
    DeviceID       string
    UserID         string
    StartedAt      time.Time
    Stage          string
    Percent        int
    SecretsTotal   int
    SecretsDone    int
    FailedSecrets  int
    Cancelled      bool
}
```

Stored per-WS-connection. On disconnect, the operation is abandoned
(no cleanup needed). On reconnect, the client restarts the restore
from scratch — there's no resumability in v1.

---

## 7. Handler layout

Handlers live in `internal/ws/` following the existing per-domain
file pattern. Phase 11d adds:

| File | Frames handled |
|------|----------------|
| `internal/ws/backup_envelope.go` | `backup_envelope_get`, `backup_envelope_put` |
| `internal/ws/history_secrets.go` | `history_secret_put`, `history_secret_list`, `history_secret_get` |
| `internal/ws/backup_status.go` | `backup_status_get`, emit `backup_progress_event` |
| `internal/ws/critical_events.go` | `critical_event_list`, `critical_event_ack`, emit `critical_event`, `critical_event_dismissed_event` |
| `internal/ws/pairing.go` | All 8 pairing frames (depends on doc #6) |
| `internal/ws/devices_phase11d.go` | `device_announce`, `device_list`, `device_remove`, emit `device_announce_event` |

The store layer adds files in `internal/store/`:

| File | Tables |
|------|--------|
| `internal/store/backup_envelopes.go` | `backup_envelopes` |
| `internal/store/history_secrets.go` | `history_secrets` |
| `internal/store/critical_events.go` | `critical_events` |
| `internal/store/devices.go` | (extends existing) |

### 7.1 Handler responsibilities

Each handler:
1. Validates the frame payload (size, format, allowlists).
2. Calls the appropriate store method (parameterized SQL).
3. Returns the ack frame OR an error frame with the right code.
4. On state-changing operations, invalidates the user's status cache.
5. On state-changing operations relevant to other devices, emits the
   appropriate push event via the WS broadcaster.

Example skeleton (Go-style pseudocode):

```go
// internal/ws/backup_envelope.go

func (h *Handler) HandleBackupEnvelopePut(ctx context.Context, conn *Conn, payload []byte) (Frame, error) {
    var req proto.BackupEnvelopePutPayload
    if err := json.Unmarshal(payload, &req); err != nil {
        return proto.NewErrorFrame("envelope_invalid", err.Error()), nil
    }

    // Validate
    if len(req.Envelope.Wraps) > 1024 {
        return proto.NewErrorFrame("envelope_invalid", "too many wraps"), nil
    }
    sizeBytes := approximateSize(req.Envelope)
    if sizeBytes > 65536 {
        return proto.NewErrorFrame("envelope_too_large", "exceeds 64 KB"), nil
    }

    // Per-wrap field validation (nonce length, kdf params, etc.)
    if err := validateEnvelopeWraps(req.Envelope.Wraps); err != nil {
        return proto.NewErrorFrame("envelope_invalid", err.Error()), nil
    }

    // Store
    newVersion, err := h.store.BackupEnvelopes.UpsertWithConcurrency(
        ctx, conn.UserID, req.Envelope, req.ExpectedVersion,
    )
    if err == store.ErrEnvelopeConflict {
        return proto.NewErrorFrame("envelope_conflict", "expected_version mismatch"), nil
    }
    if err != nil {
        return Frame{}, err  // propagates as internal error
    }

    // Invalidate cache
    h.statusCache.Invalidate(conn.UserID)

    return proto.NewAckFrame("backup_envelope_put_ack", &proto.BackupEnvelopePutAckPayload{
        NewVersion: newVersion,
    }), nil
}
```

This is the standard pattern; concrete code goes into landing PRs.

### 7.2 Authorization

All phase-11d handlers require an authenticated WS connection (the
existing `Conn` carries `UserID` and `DeviceID` from the auth
handshake done in phase 02 / phase 11a). No new auth surface.

Per-frame authorization rules:
- All backup_envelope and history_secret frames: user must own the
  envelope / secret (user_id check in WHERE clauses).
- All pairing frames: user must be the same on both sides of the
  pairing.
- `device_remove`: user cannot remove their currently-connected
  device (`device_remove_self` error).
- `critical_event_ack`: user must own the event.

### 7.3 Server-emitted push events

Some flows trigger server-side push events (not just acks to client
requests). These are dispatched via chalk's existing broadcaster:

| Trigger | Push emitted | Target |
|---------|--------------|--------|
| `device_announce` succeeds | `device_announce_event` | All other connected sessions of the same user |
| `device_remove` succeeds | `device_removed_event` (see note) | All other sessions of same user |
| Critical event created | `critical_event` | All connected sessions of the user |
| Critical event acked | `critical_event_dismissed_event` | All OTHER sessions of the user |
| Restore operation step | `backup_progress_event` | The restoring session only |

**Note on `device_removed_event`**: doc #2 rev 3 §1 family D currently
lists `device_remove` and `device_remove_ack` but no corresponding
push notification frame. Removing a device should notify the other
devices for UI consistency (e.g. so the device list updates without
a manual refresh). Two options:
1. Add `device_removed_event` to doc #2's family D as a 4th frame
   (preferred — symmetric with `device_announce_event`).
2. Rely on the `device_removed` critical event family (kind in
   doc #2 §7) to convey the same information. This works but couples
   the UI list refresh to critical-event consumption, which is wrong
   semantically (removal isn't always critical, e.g. when the user
   themselves removed it from this device).

**Recommendation**: option 1. Add `device_removed_event` to doc #2 in
the next revision pass. Until then, treat this row as provisional;
implementers should follow doc #2's authoritative frame list.

These are best-effort — disconnected sessions miss the push and pick
up state via `critical_event_list` or `backup_status_get` on next
connect.

---

## 8. Server-side rate limits

Documented commitments from doc #2 §9 plus implementation-level
specifics:

| Operation | Rate limit | Enforcement |
|-----------|-----------|-------------|
| `history_secret_put` | ≤ 100/hour per user | Token bucket per user_id |
| `history_secret_get` | ≤ 1000/hour per user | Same |
| `history_secret_list` | ≤ 20/minute per user | Aggressive limit; tab focus shouldn't hammer it |
| `backup_envelope_put` | ≤ 10/hour per user | Rotations are rare |
| `backup_envelope_get` | ≤ 60/minute per user | Cached anyway |
| `backup_status_get` | ≤ 60/minute per user | Cached on server |
| `critical_event_ack` | ≤ 30/minute per user | Bounded by event count |
| `critical_event_list` | ≤ 60/minute per user | Polled on connect |
| `pairing_offer` | ≤ 10/hour per user | Few legitimate use cases |
| `pairing_claim` | ≤ 5/hour per user | Per attempt |
| `device_announce` | ≤ 10/hour per user | New device joining is rare |
| `device_remove` | ≤ 10/hour per user | Device cleanup is rare |

Rate-limit violations return a generic `rate_limited` error code
with `retry_after_ms` in the payload. Implementation: token bucket
in Redis (or chalkd's existing per-user limiter if it exists).

**Note**: `rate_limited` is intended as a chalk-wide error code, not
phase-11d-specific (it should already exist or be added at the
chalkd error-code registry level). doc #2 §8's error code table
lists only phase-11d-specific codes and does not enumerate
chalk-wide codes like `rate_limited`, `unauthenticated`, or
`internal_error`. If `rate_limited` does not already exist in
chalk's error vocabulary, it should be added as part of phase 11d's
foundational landing PR (Land 1 in doc #2 §12).

---

## 9. Security considerations (server-side)

Implementing the design from doc #1 §8 properly on the server side:

### 9.1 Defense against nonce-reuse (doc #1 §8.1)

chalkd MAY enforce nonce-uniqueness across all history_secrets
records for a user as a defense-in-depth check:

```sql
-- Optional: add a unique index on (user_id, nonce). Storage cost
-- is high (32 bytes per row index), so this is opt-in. If a put
-- has a colliding nonce, return secret_invalid with a specific
-- nonce_collision sub-code.
CREATE UNIQUE INDEX IF NOT EXISTS history_secrets_nonce_unique
    ON history_secrets (user_id, nonce);
```

Recommendation: enable for v1 unless storage cost is a concern.

### 9.2 Replay defense (doc #1 §8.3)

UPSERT semantics ensure last-write-wins. Implementations should NOT
add a "rollback to older version" admin endpoint or any code path
that replaces a stored secret with an older one for the same triplet.

### 9.3 Ack-forgery resistance (doc #1 §8.4)

chalkd's broadcaster pushing `critical_event_dismissed_event` is
trusted. Clients MUST maintain a local mirror of pending events and
treat a dismissed_event push as authoritative ONLY if the client has
a corresponding record of having sent (or received from another of
its own devices) the matching ack.

This is a CLIENT-side enforcement; chalkd cooperates by not
fabricating dismissed_events. The doc #5 client state machines will
spec the client-side enforcement.

### 9.4 No silent data loss

chalkd MUST NOT auto-prune history_secrets, regardless of age, count,
or storage pressure. If hard limits become necessary, they must be
exposed to users via critical events ("your account exceeded the
storage quota; older eras have been deleted") with explicit opt-in.

The 90/180-day pruning policy applies ONLY to critical_events, never
to history_secrets or backup_envelopes.

### 9.5 Input-validation hardening

Several columns are client-influenced and need explicit length /
shape limits beyond what the database CHECK constraints enforce.
These should be enforced at the handler layer BEFORE the SQL insert,
and ideally also as additional CHECK constraints for defense in depth.

| Field | Risk | Recommended limit |
|-------|------|-------------------|
| `history_secrets.producing_corecrypto_version` | Unbounded TEXT; malicious client could upload 1 MB version string | ≤ 64 chars; CHECK regex `^[0-9a-zA-Z\.\-+]+$` |
| `history_secrets.size_bytes` (client-supplied) | Could mismatch actual ciphertext length | Handler MUST verify `size_bytes == len(ciphertext)`; reject with `secret_invalid` on mismatch |
| `devices.label` (user-supplied) | Unbounded TEXT for the UI device name | ≤ 128 chars |
| `critical_events.title` / `body` | Server-generated, but defense-in-depth | ≤ 256 / ≤ 4096 chars |
| `critical_events.context_json` | Server-generated JSONB | ≤ 4 KB serialized |
| `critical_events.actions_json` | Server-generated JSONB | ≤ 4 KB serialized; ≤ 8 actions |

The corresponding handler validation:

```go
func validateProducingVersion(v string) error {
    if len(v) > 64 {
        return errors.New("producing_corecrypto_version too long")
    }
    if !validVersionRegex.MatchString(v) {
        return errors.New("producing_corecrypto_version invalid format")
    }
    return nil
}

func validateHistorySecretPut(req *proto.HistorySecretPutPayload) error {
    ciphertext, err := base64.StdEncoding.DecodeString(req.Ciphertext)
    if err != nil { return err }
    nonce, err := base64.StdEncoding.DecodeString(req.Nonce)
    if err != nil { return err }
    if len(ciphertext) > 8192 { return errSecretTooLarge }
    if len(nonce) != 24 { return errSecretInvalid }
    if req.SizeBytes != len(ciphertext) { return errSecretInvalid }
    if err := validateProducingVersion(req.ProducingCoreCryptoVersion); err != nil { return err }
    // ... clock skew, conversation membership, etc.
    return nil
}
```

CHECK constraint additions to the migrations:

```sql
ALTER TABLE history_secrets
    ADD CONSTRAINT history_secrets_producing_version_length
    CHECK (length(producing_corecrypto_version) <= 64);

ALTER TABLE devices
    ADD CONSTRAINT devices_label_length
    CHECK (label IS NULL OR length(label) <= 128);

ALTER TABLE critical_events
    ADD CONSTRAINT critical_events_title_length CHECK (length(title) <= 256),
    ADD CONSTRAINT critical_events_body_length CHECK (length(body) <= 4096),
    ADD CONSTRAINT critical_events_context_size CHECK (pg_column_size(context_json) <= 4096),
    ADD CONSTRAINT critical_events_actions_size CHECK (pg_column_size(actions_json) <= 4096);
```

### 9.6 Caller binding on every read AND write

Every handler that touches a row MUST scope the query to the
calling user's ID via `conn.UserID` (set at WS auth handshake),
NOT from any client-supplied field. Pattern:

```go
// WRONG: trusts client-supplied user_id
secret, err := store.GetSecret(ctx, req.UserID, req.SecretID)

// RIGHT: scopes by authenticated user
secret, err := store.GetSecret(ctx, conn.UserID, req.SecretID)
```

The SQL queries shown in §§2-5 already encode this pattern (`WHERE
secret_id = $1 AND user_id = $2`). The handler layer must enforce
that `$2` is always `conn.UserID`. Code review and a linter rule
(e.g. forbid any payload field named `UserID` from reaching a store
method) help prevent regression.

### 9.7 origin_kind eventually NOT NULL

Migration 0027 makes `origin_kind` nullable to allow backfill of
pre-11d devices. Once backfill is complete (after the first chalk
release containing phase 11d has been deployed for some grace
period — say, 30 days), a follow-up migration should:

```sql
-- Migration 0028 (post-phase-11d-stabilization)
-- Verify backfill ran for all pre-11d devices.
SELECT COUNT(*) FROM devices WHERE origin_kind IS NULL;
-- Must return 0.

ALTER TABLE devices
    ALTER COLUMN origin_kind SET NOT NULL;
```

This prevents future devices from being created without an
`origin_kind`. If the verification query returns > 0, the
backfill is incomplete — investigate before applying the NOT NULL.

### 9.8 Pruning job must batch

The pruning queries in §4.2 (`DELETE FROM critical_events WHERE ...`)
should be batched in production to avoid long-running transactions
that block other operations:

```sql
-- Prune in chunks of 1000 rows
DELETE FROM critical_events
WHERE event_id IN (
    SELECT event_id FROM critical_events
    WHERE acked_at IS NULL AND created_at < NOW() - INTERVAL '90 days'
    LIMIT 1000
);
-- COMMIT, then repeat until 0 rows affected.
```

Same pattern for the acked-events branch.

---

## 10. Operations and observability

### 10.1 Metrics

Recommended Prometheus / equivalent metrics:

```
# Counters
chalk_backup_envelope_puts_total{outcome="success|conflict|error"}
chalk_history_secret_puts_total{outcome="success|error"}
chalk_history_secret_gets_total{outcome="success|not_found|error"}
chalk_critical_events_emitted_total{kind="..."}
chalk_critical_events_acked_total{kind="...", action="..."}
chalk_pairing_offers_total{outcome="success|expired|cancelled"}
chalk_device_announces_total{origin_kind="paired|recovery|initial"}

# Histograms
chalk_history_secret_size_bytes_bucket
chalk_history_secret_age_at_restore_days_bucket

# Gauges
chalk_history_secrets_total (count per user, aggregated)
chalk_critical_events_pending_total
chalk_pairing_sessions_active
```

### 10.2 Logging

Every state-changing handler logs:
- User ID, device ID
- Frame type and outcome
- Latency
- Error code if applicable

PII redaction (per chalk's existing convention): user IDs are
preserved (UUIDs, not directly identifying), email addresses
redacted. Recovery phrase NEVER touches a server log.

### 10.3 Alerting

Suggested alerts:
- `history_secret_put` error rate > 1% over 5 minutes → page
- Pending critical events backlog > 1000 → investigate
- Pairing offers expiring before claim > 50% → check UX

### 10.4 Migration rollback strategy

Migrations 0024-0027 are all forward-compatible: existing chalk code
that predates them works fine against the upgraded schema (new tables
are empty; new columns are nullable). This means a chalk binary
rollback (revert to pre-11d code) is safe even after migrations are
applied.

However, rolling back the MIGRATIONS themselves (DROP TABLE etc.) is
destructive — any phase-11d data already uploaded would be lost.
Production policy: never run a down-migration for 0024-0027 unless
the upgraded chalkd has been live for less than 24 hours AND no
production user has hit the new tables. Verified by:

```sql
SELECT COUNT(*) FROM backup_envelopes;
SELECT COUNT(*) FROM history_secrets;
SELECT COUNT(*) FROM critical_events;
```

If any return > 0, down-migration is no longer safe; must roll
forward instead.

Suggested down-migrations (for development environments only):

```sql
-- Migration 0027 down
ALTER TABLE devices
    DROP CONSTRAINT IF EXISTS devices_origin_kind_allowed,
    DROP CONSTRAINT IF EXISTS devices_fingerprint_length,
    DROP CONSTRAINT IF EXISTS devices_label_length;
DROP INDEX IF EXISTS devices_active_by_user;
ALTER TABLE devices
    DROP COLUMN IF EXISTS fingerprint,
    DROP COLUMN IF EXISTS origin_kind,
    DROP COLUMN IF EXISTS removed_at,
    DROP COLUMN IF EXISTS label;

-- Migration 0026 down
DROP TABLE IF EXISTS critical_events CASCADE;

-- Migration 0025 down
DROP TABLE IF EXISTS history_secrets CASCADE;

-- Migration 0024 down
DROP TRIGGER IF EXISTS backup_envelopes_updated_at ON backup_envelopes;
DROP FUNCTION IF EXISTS update_backup_envelope_timestamp();
DROP TABLE IF EXISTS backup_envelopes CASCADE;
```

---

## 11. Open questions

**Q22 (new)**: Should chalkd support manual deletion of history_secrets
via an admin endpoint?

Use cases:
- GDPR right-to-erasure requests (the user asks for their secrets to
  be deleted)
- Operational cleanup of corrupted/orphaned rows

Recommendation: yes, but only as a privileged admin operation, not
exposed via the WS protocol. Implementation: chalk's existing admin
endpoint adds `DELETE /admin/users/{user_id}/history_secrets` with
appropriate auth.

**Q23 (new)**: How does chalkd handle a user's account deletion?

Cascade rules in the migrations (ON DELETE CASCADE on `users(id)`)
ensure that deleting a user removes all their backup_envelopes,
history_secrets, and critical_events. Devices may need separate
handling (existing chalk policy applies).

Confirm cascade behavior in the existing devices and channels
foreign keys to be sure no orphaned rows remain.

**Q24 (new)**: Should we add a `history_secrets_total_size` column to
`users` for fast quota lookup?

Pros: O(1) quota check vs SUM aggregation.
Cons: redundancy; can get out of sync without careful trigger
maintenance.

Recommendation: defer until storage pressure becomes a real concern.
For now, compute on demand:
```sql
SELECT COALESCE(SUM(size_bytes), 0) FROM history_secrets
WHERE user_id = $1;
```

---

## 12. Summary

Doc #4 defines:

- **4 new tables**: `backup_envelopes`, `history_secrets`,
  `critical_events`, plus extensions to existing `devices`.
- **4 new migrations**: 0024 through 0027, with a planned 0028 to
  finalize `origin_kind` as NOT NULL after backfill.
- **Handler layout**: 6 new files in `internal/ws/`, 3 new files in
  `internal/store/`.
- **In-memory state**: pairing sessions, status cache, restore
  operation tracking.
- **Rate limits**: per-operation, per-user token buckets.
- **Security hardening** (§9): input-validation limits, caller-binding
  enforcement, batched pruning, eventual NOT NULL on origin_kind.
- **Operations**: metrics, logging, alerting, rollback strategy.

The schema is intentionally conservative: opaque BYTEA for all
encrypted material (no JSON inspection), explicit size caps as CHECK
constraints, partial indexes for the common query patterns. CASCADE
deletion via foreign keys handles user deletion cleanly.

**One open inconsistency to resolve**: §7.3 references
`device_removed_event` but doc #2 doesn't define it as a frame. Doc
#2 should be updated in the next revision pass to add this frame,
symmetric with `device_announce_event`.

Doc #5 (client state machines) is next — it specs the client-side
orchestration of the flows that touch this schema.

End of doc #4. Vienna 2026-05-27.
