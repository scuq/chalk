# chalk phase 06 — apply notes

Phase 06 ships presence (per-device, multi-device aggregated, with
heartbeat / janitor / demotion loops) plus friendships (request /
accept / decline / remove / block / unblock / list) plus the account-
lifecycle schema (status / status_reason / status_changed_at /
last_seen_at).

The phase ships schema and read-path enforcement only. Write-path
lifecycle transitions (account_deactivate, account_delete, admin_lock)
are deferred to phase 11+ when authenticated sessions exist to gate
them. Phase 12 will add the dormancy and tombstone-purge GC sweeps.

## What changed at a high level

- 4 new migrations (0006..0009)
- 2 new packages: `internal/friends`, `internal/presence`
- proto package extended with new frame types (additive) and an extra
  field on `HelloPayload`
- pubsub package extended with new event fields (additive)
- server package: `ws.go`, `ws_phase06.go`, `server.go` updated/added
- 1 integration test
- 1 bootstrap phase script

## Manual step required: extend `HelloPayload`

Phase 06's `frames_phase06.go` is additive, but the per-connection
presence cadence depends on a `device_type` field that didn't exist in
the phase-04 `HelloPayload`. You have one of two options:

### Option A (recommended): replace your `internal/proto/types.go`

This archive includes `internal/proto/types.go`. It defines the
chalk wire payload structs as they existed in phase 04 plus the new
`DeviceType` field on `HelloPayload`. If your existing payload file
is named `types.go` and contains only the structs in the shipped
replacement, replace it directly.

If your existing payload file is named differently (e.g.
`payloads.go`), either rename to match or skip Option A and use
Option B below — Go will refuse to compile a package containing two
declarations of `HelloPayload`.

### Option B: add one line to your existing `HelloPayload`

Open whichever file currently declares `HelloPayload` and add
`DeviceType` exactly as below:

```go
type HelloPayload struct {
    DeviceID   string `json:"device_id"`
    DeviceType string `json:"device_type,omitempty"`  // <-- add this line
}
```

The field is JSON-omitempty, so clients that don't send `device_type`
work unchanged; the server treats missing values as `browser-unknown`.

## Files to copy into your tree

```
migrations/0006_user_lifecycle.sql
migrations/0007_friendships.sql
migrations/0008_presence.sql
migrations/0009_messages_nullable_sender.sql

internal/proto/frames_phase06.go      (new, additive)

internal/friends/store.go             (new package)
internal/friends/store_test.go

internal/presence/store.go            (new package)
internal/presence/loops.go

internal/pubsub/notifier.go           (REPLACES the phase-05 version)

internal/server/ws.go                 (REPLACES the phase-05 version)
internal/server/ws_phase06.go         (new)
internal/server/server.go            (REPLACES the phase-05 version)

test/integration/presence_friends_test.go
bootstrap/phase-06-presence.sh
```

Three server files are replacements; review the diff against your
phase-05 versions before committing. The phase-05 message path inside
`handleSend` and `handleMessageEvent` is preserved verbatim.

## Wiring changes in `main.go` (chalkd entry point)

`server.NewServer` gained four `Options` fields:

```go
opts := server.Options{
    // ... existing phase-05 fields ...
    Presence:           &presence.Store{Pool: pool},
    Friends:            &friends.Store{Pool: pool},
    PresenceLoopConfig: nil,  // use defaults; tests override
}
```

If your `main.go` currently passes `server.Options{...}` to
`NewServer`, add the four fields. With nil presence/friends, the
server still starts and serves phase-05 message frames; only the new
phase-06 features go dark. Phase-06 frame types reaching the server
without presence/friends configured get `internal` error frames back.

## Behavioral changes for existing clients

- Phase-06 clients sending hello without `device_type` work unchanged
  (server defaults to `browser-unknown`, 10-minute heartbeat TTL).
- A user whose account `status != 'active'` is rejected at hello with
  WebSocket close-code policy-violation, reason `account <status>`.
  In a fresh phase-06 deploy, all seeded users default to `active`,
  so this only fires for users explicitly transitioned.
- `messages.sender_device_id` is now nullable. Existing message rows
  are unaffected (they have non-null sender_device_ids); new rows
  inserted from purged users will have NULL. The wire frame's
  `sender` field is `""` for NULL sender_device_id.

## New wire frame types (proto package)

Server-to-client:
- `presence` — push of a target user's aggregated state
- `presence_subscribe_ack`, `presence_unsubscribe_ack`,
  `presence_update_ack`
- `friend_request_ack`, `friend_accept_ack`, `friend_decline_ack`,
  `friend_remove_ack`, `friend_block_ack`, `friend_unblock_ack`,
  `friend_list_ack`
- `friend_event` — async push of friendship state changes
  (kinds: `request_received`, `accepted`, `declined`, `removed`)

Client-to-server:
- `presence_subscribe`, `presence_unsubscribe`, `presence_update`
- `friend_request`, `friend_accept`, `friend_decline`,
  `friend_remove`, `friend_block`, `friend_unblock`, `friend_list`

New error codes:
- `user_not_found`, `user_unavailable`, `not_friends`,
  `already_friends`, `friendship_blocked`, `cannot_self_friend`,
  `no_pending_request`, `invalid_state`

## Presence semantics

- States: `online`, `away`, `offline`.
- Clients can claim `online` or `away`. `offline` is server-enforced
  on disconnect or by the demotion sweep.
- Aggregation: a user's effective state is the max across all of
  their devices (`online` > `away` > `offline`).
- TTLs by device_type:
  - phone: 90s
  - tablet: 3min
  - desktop: 10min
  - browser-unknown: 10min (safest default)
- Heartbeat interval = TTL/3 (so a single missed heartbeat doesn't
  cause demotion).
- Demotion: online devices past TTL get demoted to away; away devices
  past 2x TTL get demoted to offline.
- Subscription requires mutual `accepted` friendship. The check
  happens at subscribe time AND on every push, so un-friending an
  active subscriber's target takes effect immediately.

## Friendship semantics

- Symmetric storage convention:
  - `accepted` rows are stored with `user_a < user_b` lexicographically.
  - `pending` rows preserve direction (user_a = requester).
  - `blocked` rows preserve direction (user_a = blocker).
- A friend request to someone who already requested you auto-accepts
  (both sides become accepted in one operation).
- Blocking removes any existing friendship and rejects future
  requests in either direction. The blocked party is NOT notified.
- The `friend_list_ack` payload includes the account-status field on
  each friend entry so the UI can render "alice (inactive)" for
  friends whose accounts went soft_blocked or deleted.

## How to run

Bootstrap phase 06 from a phase-05-green tree:

```sh
cd chalk
./bootstrap/phase-06-presence.sh
```

The script verifies the new files exist, applies migrations 0001..0009
on a fresh database, seeds fixtures, runs the friends unit tests, vet-
checks the presence package, builds chalkd, and runs the two-instance
integration test.

Expected wall-clock: ~15s for the full bootstrap including the
integration test (which itself takes ~10s due to deliberate waits for
janitor sweeps).

## Known scope cuts

- No write-path for account lifecycle transitions. Deactivate / delete
  / lock / unlock arrive in phase 11.
- No dormancy GC. last_seen_at is bumped on every hello, ready for
  the phase-12 GC sweep.
- No tombstone GC. ON DELETE SET NULL on messages.sender_device_id is
  in place for when phase 12 actually purges users.
- Bob's user row is seeded by the integration test, not by the phase-
  03 fixture. If you want bob seeded permanently, update
  `bootstrap/fixtures/users.sql`.
