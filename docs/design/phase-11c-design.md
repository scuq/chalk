# Phase 11c Design Doc — MLS Channel Encryption

**Status:** Draft for review
**Author:** Claude, per scuq's design choices
**Date:** 2026-05-28 (Vienna)
**Scope:** chalk phase 11c — extending MLS encryption from two-member DMs
(11b) to multi-member channels. Member add/remove flows, commit-race
handling at scale, KeyPackage refill batching, and the history-on-join
question.
**Depends on:** phase 11a (CoreCrypto + KeyPackages, shipped), phase 11b
(MLS DM encryption, shipped). Independent of phase 11d (multi-device +
history transfer).

11c is conceptually "11b but with N members." That simplification hides
several genuinely new problems: commit races between simultaneous
operations, KeyPackage batching, Welcome fan-out at scale, and most
importantly the question of what new joiners can decrypt. This doc
addresses each.

---

## 1. Goals and non-goals

### 1.1 Goals

- **All new channels created from 11c onward are MLS-encrypted.** The
  server stores `mls_ciphertext` bytes, not plaintext.
- **Member add/remove work correctly** under MLS, including the
  initiator's commit flow and other members' processing of the
  resulting Commit/Welcome.
- **Commit races resolve cleanly.** Two members trying to commit
  simultaneously: one wins, the other retries against the new epoch.
- **KeyPackage exhaustion is detectable and surfaceable.** If alice
  wants to create a 5-member channel but carol has zero unused KPs,
  alice sees a clear "carol can't be added right now" message and the
  channel is not created.
- **Pre-11c plaintext channels keep working** but cannot be "upgraded"
  to MLS — they remain plaintext for the channel's lifetime.

### 1.2 Non-goals

- **History on join**: a new member sees only messages from their
  join-epoch forward. Pre-join messages are NOT decryptable. This
  matches MLS's forward-secrecy design and aligns with user
  expectations (Slack/Discord behavior). The "give a new device the
  pre-existing history" problem is phase 11d's responsibility, NOT
  11c's.
- **Multi-device per user**: same as 11b. One device per user. A user
  logging in on a second browser profile cannot decrypt channel
  messages from their first profile. Phase 11d.
- **Reactions, threads, edits, deletes**: existing chalk features that
  already work plaintext. Under 11c's MLS, the message body is
  ciphertext but the routing metadata (`parent_id`, `thread_id`,
  `id`) remains plaintext, same as 11b. Reaction frames extend in a
  later phase.
- **Federation, presence-under-MLS, encrypted attachments**: all
  separate phases.

### 1.3 Decisions inherited from 11b

These remain in force:

| ID | Decision | From |
|----|----------|------|
| D-11b-1 | Hard cutover: new channels are MLS, old ones stay plaintext | 11b-1 |
| D-11b-2 | `mls_ciphertext` content type alongside `application` | 11b-2 |
| D-11b-3 | Server stores opaque MLS bytes; never inspects | 11b-2 |
| D-11b-4 | `mls_commit_bundle` wire frame carries Commit + Welcome | 11b-2 |
| D-11b-5 | LATERAL preview join in `ListMessagesByChannel` returns empty `last_reply_body` for `mls_ciphertext` rows | 11b-2 |
| D-11b-6 | `prepareForTransport` returns dummy bytes (deferred to 11d for in-band history secret; for 11c, still dummy since no history sharing yet) | 11b-3 hotfix |

### 1.4 New decisions for 11c

| ID | Decision |
|----|----------|
| **D-11c-1** | All new multi-member channels (`is_dm=false`) created from 11c onward are MLS by default. The existing `channels.is_mls` boolean (from 11b's migration 0023) is set `true` at creation time. |
| **D-11c-2** | No history-on-join. New members see only post-join messages. UI shows "You joined on <date>" marker at the join boundary. |
| **D-11c-3** | Member add: initiator fetches KP for each new member, builds Commit + Welcome, sends as `mls_commit_bundle`. Server stores Commit, fans Welcomes to new members. |
| **D-11c-4** | Member remove: initiator builds remove-Commit, sends. Server stores, fans Commit to all remaining members (including the removed member, who needs it to know they were removed). |
| **D-11c-5** | Commit races resolved by the delivery service (chalkd) accepting commits in receipt order, refusing any commit whose epoch doesn't match the current group epoch. Client retries against the new epoch. |
| **D-11c-6** | KeyPackage refill batched on group creation: initiator fetches all needed KPs in a single `fetch_key_packages_batch` round trip. |
| **D-11c-7** | KP exhaustion is a hard failure during group creation. No partial group creation. |

---

## 2. Architecture

### 2.1 Single MLS group per channel

Same as 11b: one MLS group per chalk channel, identified by
`channels.id` ↔ `mls_groups.channel_id`. The `mls_groups.mls_group_id`
BYTEA column holds CoreCrypto's opaque group ID; `current_epoch` tracks
the latest known epoch.

For multi-member channels, the group's member set matches the
channel's member set (per `channel_members` table, which already
exists from phase 08). Adding a chalk-channel member ≡ adding an MLS
group member.

### 2.2 Roles

- **Group creator**: the user who created the channel. Has no special
  MLS role; this is purely a chalk-side designation. The creator's
  device performs the initial group setup (one-member group with
  themselves) and the initial Add commits for the other founding
  members.
- **Member**: any user added to the group. Equal MLS rights — any
  member can Add or Remove (subject to chalk-side authorization
  rules; see §7.2).
- **Initiator**: whoever is currently driving an Add or Remove commit.
  Can be any member.

### 2.3 What stays plaintext

Same as 11b:
- `messages.id`, `messages.channel_id`, `messages.parent_id`,
  `messages.thread_id`, `messages.seq`, `messages.created_at`
- `channels.name`, `channels.is_mls`, `channels.is_dm`
- Member identity (user_id, handle)
- Per-channel join order (`channel_members.created_at`)
- Reaction counts (when added in a later phase)

### 2.4 Ciphertext only

- `messages.ciphertext` (the BYTEA body for `mls_ciphertext` rows)
- `messages.mls_epoch` (which epoch the ciphertext was encrypted
  under)
- The Commit bytes themselves (stored separately; see §4.2)

---

## 3. Group lifecycle

### 3.1 Channel creation (multi-member)

The new flow for `create_channel` when `is_dm=false` and the
initial member count is > 1:

```
Initiator (alice's device):

1. SPA's CreateChannelModal collects:
   - Channel name
   - Initial member list: [bob, carol, dave]
   (= 3 members + the creator, so a 4-member channel)

2. SPA submits create_channel to chalkd with:
   - name, is_dm=false, is_mls=true
   - initial_members: [bob.uid, carol.uid, dave.uid]

3. Server validates:
   - All initial_members exist as friends of alice (existing rule)
   - All have at least one unused KeyPackage (NEW: fast count check)
   - Channel name is valid

4. If any member has zero KPs, server responds:
   create_channel_error {
     code: "peer_no_keypackages",
     details: { user: "carol", display: "carol hasn't logged in
                recently; they need to come online once before
                they can be added to encrypted channels." }
   }
   → channel is NOT created. Alice retries when carol comes back.

5. Server responds create_channel_ack with:
   - channel_id (the new chalk channel ID)
   - mls_group_pending: true (channel exists but MLS group not
                              yet established)
   - keypackages: { bob: <kp_bytes>, carol: <kp_bytes>,
                    dave: <kp_bytes> }
   (Server consumed one KP per member via FOR UPDATE SKIP LOCKED,
   marked them used_at = NOW().)

6. Alice's SPA:
   - cc.createConversation(channel_id) → empty group, alice is the
     sole member
   - cc.addClientsToConversation(channel_id,
        [bob_kp, carol_kp, dave_kp]) → produces a Commit
        + Welcomes for bob/carol/dave
   - cc.commitAccepted(channel_id) → merges locally
   - Alice sends mls_commit_bundle {
       channel_id, mls_group_id: <new>,
       commit: <bytes>, welcomes: { bob: <bytes>, carol: <bytes>,
                                    dave: <bytes> },
       new_epoch: 1
     }

7. Server stores the Commit in mls_commits (see §4.2), fans the
   per-member Welcomes out via mls_welcome push frames.

8. Bob/Carol/Dave each receive their Welcome, process it via
   cc.processWelcomeMessage, send mls_welcome_ack. Their devices
   now have the group state at epoch 1.

9. From here, send/receive work like 11b: any member can encrypt;
   any member can decrypt.
```

This is a two-round-trip flow (create_channel + mls_commit_bundle).
We accept the extra round trip; collapsing them is possible but
complicates the server's role.

### 3.2 Adding a member to an existing group

```
Initiator (alice, currently a member of a 4-member channel):

1. Alice clicks "Add member" in channel UI → picks emma
2. SPA sends add_to_channel { channel_id, user_id: emma.uid }
3. Server:
   - Validates emma is a friend of alice (or channel allows it; see §7.2)
   - Validates emma has an unused KP
   - Consumes one KP via FOR UPDATE SKIP LOCKED
   - Responds add_to_channel_ack {
       keypackage: { emma: <kp_bytes> }
     }
4. Alice's SPA:
   - cc.addClientsToConversation(channel_id, [emma_kp])
   - Produces Commit + Welcome for emma
   - Sends mls_commit_bundle { channel_id, commit, welcomes: { emma },
                                new_epoch: <current+1> }
5. Server stores the Commit, fans:
   - mls_welcome to emma (with the Welcome bytes)
   - mls_commit_event to bob/carol/dave (existing members) so they
     process the new Commit and advance their epoch
6. Existing members each call cc.decryptMessage(commit_bytes) to
   process the Add, advancing their local epoch to match.
7. Emma processes Welcome, joins the group at the new epoch.
```

### 3.3 Removing a member

```
Initiator (alice, removing carol from a 4-member channel):

1. Alice clicks "Remove" on carol in channel UI
2. SPA sends remove_from_channel { channel_id, user_id: carol.uid }
3. Server validates alice has permission to remove carol (see §7.2)
4. Alice's SPA:
   - Looks up carol's MLS member index in the group (CoreCrypto
     stores this internally; cc.getClientIds(channel_id) returns
     the member list)
   - cc.removeClientsFromConversation(channel_id, [carol_client_id])
   - Produces a Commit (no Welcome — Remove doesn't generate one)
   - Sends mls_commit_bundle { channel_id, commit, welcomes: {},
                                new_epoch: <current+1> }
5. Server stores the Commit, fans mls_commit_event to ALL members
   including carol (so she can process the Commit and know she was
   removed).
6. Carol's device processes the Commit, sees herself removed, updates
   local UI (channel disappears from her sidebar, history archived
   client-side).
7. Bob and Dave process the Commit, advance their epoch, continue
   normally.

Server-side: chalkd ALSO updates channel_members (removes carol's
row) and the channel disappears from carol's list_channels response
on next fetch.
```

### 3.4 Channel deletion (entire channel removed)

Reuses 11b's channel-delete logic. Server-side:
- Cascade-deletes `mls_groups` row, all `messages` rows,
  `channel_members` rows
- Sends `channel_deleted` push frame to all current members
- Members' devices: drop the local CoreCrypto conversation for that
  channel_id

The MLS group is never explicitly "dissolved" — members just receive
a `channel_deleted` event and clean up locally. The opaque key
material on each device gets garbage-collected eventually.

---

## 4. Server-side state

### 4.1 Reuses existing schema from 11b

`mls_groups` table (migration 0022) is unchanged. One row per
MLS-encrypted channel, regardless of member count.

### 4.2 New: mls_commits table (migration 0024)

To handle commit races and late-joiner catchup, chalkd needs to
store committed bundles so devices that missed a Commit (offline at
the time) can fetch and process them on reconnect.

```sql
-- Migration 0024 — store MLS commits for late-joiner catchup.

CREATE TABLE IF NOT EXISTS mls_commits (
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    epoch BIGINT NOT NULL,
    commit_bytes BYTEA NOT NULL,
    committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    committed_by_device UUID NOT NULL REFERENCES devices(id),
    PRIMARY KEY (channel_id, epoch)
);

-- Size cap for safety
ALTER TABLE mls_commits
    ADD CONSTRAINT mls_commits_size_cap
    CHECK (octet_length(commit_bytes) <= 65536);

-- Lookup pattern: fetch all commits for a channel after a given epoch
CREATE INDEX IF NOT EXISTS mls_commits_by_channel_after
    ON mls_commits (channel_id, epoch);
```

A 4-member channel doing weekly member changes accumulates ~50
commits per year, each ~2-4 KB. Storage cost: ~150 KB per channel
per year. Acceptable.

**Retention**: keep commits indefinitely. Pruning would silently
break catchup for any device that's been offline longer than the
retention window. If storage pressure ever requires pruning, prune
all commits older than the OLDEST currently-active device's last
seen epoch, per channel.

### 4.3 New: mls_pending_commits in-memory state

Server holds a brief in-memory window per channel during a commit
exchange. From the moment chalkd receives an `mls_commit_bundle`
until all targets have acked their Welcomes / processed the Commit,
the channel is in a "pending commit" state.

```go
// In internal/server/mls_state.go (new file in 11c)
type PendingCommit struct {
    ChannelID       string
    InitiatorDevice string
    Epoch           uint64
    CommitBytes     []byte
    Welcomes        map[string][]byte  // user_id → welcome bytes
    AckedBy         map[string]bool    // user_id → did they ack?
    CreatedAt       time.Time
    ExpiresAt       time.Time
}

type PendingCommitStore struct {
    mu       sync.RWMutex
    pending  map[string]*PendingCommit  // channel_id → state
}
```

Purpose:
- Detect commit races: if a new `mls_commit_bundle` arrives for a
  channel that already has a pending one at the same epoch, reject
  the second.
- Track which members have processed the commit (via
  `mls_welcome_ack` / `mls_commit_ack`).
- After 60s, age out: regardless of ack state, drop the pending
  state. The Commit is already stored in `mls_commits`; offline
  devices catch up on next connect via §4.4.

This is **soft state**. A chalkd restart drops it; clients that were
mid-handshake retry from their persisted state on reconnect.

### 4.4 Commit catchup on reconnect

When a device reconnects to chalkd, it sends `hello` with its
known-epochs per channel:

```go
type HelloPayload struct {
    DeviceID    string                          `json:"device_id"`
    MLSEpochs   map[string]uint64               `json:"mls_epochs"`
    // channel_id → highest epoch this device has processed
}
```

The server's `handleHello` checks each entry: if the channel's
current epoch is ahead of the device's known epoch, the server
queues `mls_commit_event` frames carrying every missing commit, in
order. The device processes them sequentially, advancing its epoch
to match.

This handles the case "device offline for 2 weeks, comes back, 7
member-change Commits happened in the meantime." Server replays
them all; client catches up; from then on, real-time push frames
work normally.

---

## 5. Wire protocol

### 5.1 New frames (extending 11b's `mls_*` family)

| Type | Direction | Purpose |
|------|-----------|---------|
| `add_to_channel` | C→S | Initiate adding a member to an MLS channel |
| `add_to_channel_ack` | S→C | Returns the new member's KeyPackage |
| `remove_from_channel` | C→S | Initiate removing a member from an MLS channel |
| `remove_from_channel_ack` | S→C | Confirmation; server has validated the request |
| `mls_commit_event` | S→C | Push: a Commit has happened in a channel you're a member of; process it |
| `mls_commit_ack` | C→S | Confirmation: I processed the commit and advanced my epoch |
| `fetch_key_packages_batch` | C→S | Fetch one unused KP each for multiple users in one round trip |
| `fetch_key_packages_batch_ack` | S→C | Returns the batch of KPs |
| `fetch_mls_commits` | C→S | Request all commits after a given epoch (mid-session catchup) |
| `fetch_mls_commits_ack` | S→C | Returns the missing commits in order |

The existing 11b frames (`publish_keypkgs`, `fetch_key_packages`,
`mls_commit_bundle`, `mls_welcome`, `mls_welcome_ack`) are reused
unchanged.

Total new frames in 11c: **10**.

### 5.2 Frame schemas

#### `add_to_channel` (C→S)

```go
type AddToChannelPayload struct {
    ChannelID string `json:"channel_id"`  // UUID
    UserID    string `json:"user_id"`     // UUID of the user to add
}

type AddToChannelAckPayload struct {
    ChannelID  string `json:"channel_id"`
    UserID     string `json:"user_id"`
    KeyPackage string `json:"keypackage"`  // base64 of the KP bytes
}
```

**Server validation**:
- Caller (`conn.UserID`) is a current member of `channel_id`
- `user_id` is a friend of the caller, OR the channel allows
  non-friend adds (see §7.2)
- `user_id` is NOT already a member
- `user_id` has at least one unused KeyPackage

On success, server consumes one KP (sets `used_at = NOW()`) and
returns its bytes.

**Errors**: `not_a_member`, `target_not_friend`, `already_member`,
`peer_no_keypackages`, `channel_not_mls`.

#### `remove_from_channel` (C→S)

```go
type RemoveFromChannelPayload struct {
    ChannelID string `json:"channel_id"`
    UserID    string `json:"user_id"`
}

type RemoveFromChannelAckPayload struct {
    ChannelID string `json:"channel_id"`
    UserID    string `json:"user_id"`
}
```

**Server validation**:
- Caller is a current member
- Target is a current member
- Caller has permission to remove target (per channel's permission
  model; default: only the channel creator can remove others, or
  any member can remove themselves; see §7.2)

The actual member-remove from `channel_members` happens AFTER the
client has sent `mls_commit_bundle` and the server has stored the
Commit. Up to that point, the target is still a member from
chalkd's perspective.

**Errors**: `not_a_member`, `target_not_member`, `not_authorized`,
`channel_not_mls`.

#### `mls_commit_event` (S→C)

```go
type MLSCommitEventPayload struct {
    ChannelID   string `json:"channel_id"`
    Epoch       uint64 `json:"epoch"`  // the NEW epoch this commit advances to
    CommitBytes string `json:"commit_bytes"`  // base64
    CommittedBy string `json:"committed_by"`  // user_id of the initiator
}
```

Pushed to all members of the channel (including the initiator
themselves for symmetry, though they already merged locally — they
should detect "this is my own commit, ignore" via the
`committed_by` field).

**Client action**: call `cc.decryptMessage(channel_id, commit_bytes)`
(yes, decryptMessage handles commits per CoreCrypto's API), advance
local epoch, then `mls_commit_ack`.

#### `mls_commit_ack` (C→S)

```go
type MLSCommitAckPayload struct {
    ChannelID string `json:"channel_id"`
    Epoch     uint64 `json:"epoch"`
}
```

Server marks this device as having acked the commit for this epoch.
Used for the in-memory `PendingCommit` tracking (§4.3); informational
once persisted.

#### `fetch_key_packages_batch` (C→S)

```go
type FetchKeyPackagesBatchPayload struct {
    UserIDs []string `json:"user_ids"`
}

type FetchKeyPackagesBatchAckPayload struct {
    KeyPackages map[string]string `json:"keypackages"`  // user_id → base64 KP
    Failures    map[string]string `json:"failures"`     // user_id → error code
}
```

**Server behavior**:
- For each user_id, attempt to consume one unused KP via
  `FOR UPDATE SKIP LOCKED`
- On success: add to `keypackages`
- On failure (no KP available, user not found, etc.): add to
  `failures` with error code

The client decides what to do with partial results. For group
creation (§3.1), ANY failure aborts the group creation — but the
client can show the user which specific peers were missing KPs.

**Errors at the frame level**: `batch_too_large` (≥ 100 users in
one batch; rare).

### 5.3 Modified frames

#### `mls_commit_bundle` (extension)

Existing in 11b, extended to carry multiple Welcomes:

```go
type MLSCommitBundlePayload struct {
    ChannelID   string            `json:"channel_id"`
    MLSGroupID  string            `json:"mls_group_id,omitempty"`  // set only for initial create
    Epoch       uint64            `json:"epoch"`     // the NEW epoch
    Commit      string            `json:"commit"`    // base64 commit bytes
    Welcomes    map[string]string `json:"welcomes"`  // user_id → base64 welcome bytes
                                                     // empty for Remove commits
}
```

Was: `welcome` (single, optional). Now: `welcomes` (map, possibly
empty).

Server-side handler updated to:
- Store the commit in `mls_commits` table
- For each entry in `welcomes`, push `mls_welcome` to that user
- Push `mls_commit_event` to all OTHER members of the channel (not
  the initiator, not the welcomed members)

#### `create_channel` (extension)

Existing from phase 08, extended for MLS:

```go
type CreateChannelPayload struct {
    Name            string   `json:"name"`
    IsDM            bool     `json:"is_dm"`
    InitialMembers  []string `json:"initial_members"`  // user_ids
    // NEW: hint to server to pre-check KPs
    EncryptionMode  string   `json:"encryption_mode,omitempty"`
    // "mls" (default for new non-DM channels), "plaintext" (forced
    // legacy mode; admin override only)
}
```

For backward compatibility, missing `encryption_mode` defaults to
"mls" for `is_dm=false` channels from 11c onward. Plaintext
fallback (`encryption_mode=plaintext`) is available only to admin
users via a chalk config flag; not exposed in normal UI.

### 5.4 Removed/deprecated frames

None. 11c is purely additive.

---

## 6. KeyPackage refill strategy

### 6.1 The N-member problem

Phase 11a established the refill threshold: 10 KPs stocked,
refill triggered when 3 consumed. This was tuned for DMs (one
KP consumption per DM creation).

For a 10-member channel creation, one creation consumes 9 KPs at
once. If two such channels are created in rapid succession,
30 KPs could be consumed before refill catches up.

**Decision**: keep the 10/3 stocked/threshold ratio for v1. Trust
that the refill mechanism keeps up in practice. If real-world usage
shows refill lagging, raise to 25/10.

### 6.2 KP refill push frame

Reuse 11a's `keypkg_low` push: server detects when a user crosses
the threshold and pushes `keypkg_low { remaining: N }`. Client
generates new KPs and uploads via `publish_keypkgs`.

In 11c, this push fires more often per user (because more KP
consumption events). No design change.

### 6.3 KP exhaustion during group creation

Per D-11c-7: hard failure. The `fetch_key_packages_batch` ack
contains both successful KPs and per-user failures. If any failure,
the client aborts:
- No CoreCrypto group is created
- No `mls_commit_bundle` is sent
- Server doesn't see any partial state
- UI shows "Can't create channel: <list of users without KPs>.
  Ask them to come online once."

Note: the server consumed KPs for the successful members during the
batch fetch. Those consumed KPs are now "wasted" (no group used
them). This is an edge case worth measuring; if it becomes
significant, we add a `release_keypackages` frame to undo the
consume. For v1: accept the waste.

---

## 7. Permission model

### 7.1 Who can add members?

**Default for 11c**: any member of a channel can add another user,
PROVIDED that user is a friend of the inviter. This matches 11b's
DM-creation model (alice can only DM friends).

This is restrictive: it means alice can't add bob to a channel if
bob isn't her friend, even if bob is friends with carol (who is
also in the channel).

Alternative: any-member-can-add-any-friend-of-any-member. More
permissive, more confusing for users. Defer.

**Recommendation**: stick with the restrictive default for 11c.
Channels with active member growth tend to have a small set of
"adders" anyway. Reconsider if user feedback complains.

### 7.2 Who can remove members?

**Default for 11c**:
- Any member can remove THEMSELVES (leave the channel)
- The channel creator can remove anyone
- No one else can remove other members

This is the simplest non-degenerate model. Future phases may add
"channel admin" roles distinct from "creator."

### 7.3 Server-side enforcement

The server enforces all of the above on the `add_to_channel` and
`remove_from_channel` handlers. The MLS layer doesn't know about
chalk's permission model — MLS allows any member to commit any
proposal — so the server is the only enforcement point.

A misbehaving client that sends `mls_commit_bundle` directly without
first calling `add_to_channel` would be caught at the
`mls_commit_bundle` handler:
- Server checks the new epoch's member list against the previous
  epoch's
- Computes the diff (added/removed members)
- Validates each diff entry against the permission model
- Rejects the entire commit if any entry violates the rules

This is the **server's role as MLS validator**: it never decrypts
content, but it does verify that the membership transitions
encoded in the commit match what chalk's permission model allows.

To do this, the server needs to track group membership server-side
alongside MLS's internal tracking. We already have
`channel_members`; that's the authoritative source for chalkd's
view of "who's in the group." The MLS commit's member list (which
chalkd can read from the commit's header without decrypting the
application messages) must match.

This is a real new piece of server-side validation work. See §9.4
for the implementation sketch.

---

## 8. Failure modes and edge cases

### 8.1 Commit race (two members commit simultaneously)

Both alice (adding emma) and bob (removing carol) send
`mls_commit_bundle` for channel X, both targeting the same new
epoch (current+1).

**Server behavior**:
- First commit arrives, server stores it, advances current_epoch
- Second commit arrives, server checks: does its `epoch` match the
  channel's current_epoch + 1? If yes, accept. If no (it targeted
  the old epoch), reject with `mls_stale_commit`.

Client behavior on `mls_stale_commit`:
- Discard the local commit attempt
- Wait for the winning commit's `mls_commit_event` (it'll arrive
  via push)
- Process that commit, advance to the new epoch
- Re-attempt the original operation (add emma) against the new
  member list

This is the same pattern as 11d Flow 9's self-add race (doc #5 §10.2).

### 8.2 Commit lost in transit

Initiator sends `mls_commit_bundle` but the WS connection drops
before the ack arrives.

**Client behavior**:
- Treat the commit as "uncertain": don't know if server received
- On reconnect, send `hello` with current epoch
- Server's `handleHello` either:
  - Sees the device's epoch matches current → no catchup needed
  - Sees the device's epoch is behind → sends `mls_commit_event`
    for each missing commit, which includes any that landed
    successfully before the drop

Idempotency: if the initiator's commit DID land on the server but
the ack was lost, the initiator's local CoreCrypto already merged
the commit (it was the local epoch=N+1 when the network dropped).
On reconnect, the server's view shows epoch=N+1; initiator's view
matches; no replay needed.

If the commit DIDN'T land, initiator's local CoreCrypto is at N+1
but the rest of the world is at N. Other members' next commit will
push initiator's view back via `mls_commit_event`. CoreCrypto may
need to be "rolled back" from N+1 to N — this is where things get
hairy.

**Mitigation**: clients should NOT mark a commit as "merged locally"
until they receive `mls_commit_bundle_ack` from the server. If the
ack times out (10s), revert the local merge. This requires
CoreCrypto support for tentative commits — TBD whether it's
available; needs integration testing per §10.

### 8.3 Member removes themselves

Carol clicks "Leave channel."

Carol's SPA sends `remove_from_channel { user_id: carol.uid }`.

Server validates: caller is a member, target is the caller → allowed
under "any member can remove themselves" (§7.2). Responds ack.

Carol's SPA builds the remove-Commit, sends `mls_commit_bundle`.

Server stores, fans `mls_commit_event` to all other members.

Carol's device processes the Commit, sees herself removed, cleans
up the local conversation state.

Edge case: what if Carol's leave-Commit is rejected (race lost)?
Then carol is technically still a member. UI should retry the
leave automatically until it succeeds.

### 8.4 The channel creator leaves

Alice created channel X, then later leaves. The channel still
exists; other members continue normally.

The "creator" designation (`channels.created_by`) is a static
historical record. It doesn't grant ongoing privileges except
"remove other members" (per §7.2). When alice leaves, there's no
one with remove-other privileges. The channel becomes
"non-moderated" until phase 13 introduces admin roles.

For 11c v1: accept this. Members can still remove themselves;
just can't remove each other.

### 8.5 Last member leaves

If the last member of a channel removes themselves, the channel
becomes orphaned. Server-side handler should detect this and
either:
- (a) Auto-delete the channel
- (b) Leave it as zero-member orphan (won't appear in anyone's
      list_channels)

**Decision**: (a) auto-delete. Cleaner. The channel deletion cascade
removes all messages and the MLS group state.

### 8.6 Welcome arrives but recipient is offline

Server fans the `mls_welcome` push, but emma isn't connected.

**Server behavior**: queue the welcome in `mls_pending_welcomes`
(in-memory or new table?). When emma reconnects, deliver as part
of catchup.

In-memory is too volatile (chalkd restart loses welcomes).
Recommend new table:

```sql
-- Migration 0025 — pending welcomes for offline recipients

CREATE TABLE IF NOT EXISTS mls_pending_welcomes (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    epoch BIGINT NOT NULL,
    welcome_bytes BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, channel_id)
);

ALTER TABLE mls_pending_welcomes
    ADD CONSTRAINT mls_pending_welcomes_size_cap
    CHECK (octet_length(welcome_bytes) <= 65536);
```

On `mls_welcome_ack` from the recipient, the row is deleted.

Retention: indefinite. A welcome that's never been acked stays
forever (the user might come back). This is a small storage cost
per never-returning user; accept it.

### 8.7 Commit references a member who left mid-add

Race: alice starts to add emma to a channel. While alice's
`add_to_channel` is in flight, emma deactivates her account
(when account lifecycle ships in phase 12).

Server's `add_to_channel` handler checks emma's account status. If
deactivated, returns `target_unavailable`. Alice retries with a
different member.

For 11c (before phase 12 ships), this race doesn't occur.

### 8.8 KeyPackage was consumed but Welcome was never delivered

Alice's `add_to_channel` consumed bob's KP. Alice's
`mls_commit_bundle` got sent. Server fanned the Welcome to bob, but
bob's device failed to process it (CoreCrypto threw, IndexedDB
write failed, etc.).

Bob's KP is now consumed but bob isn't in the group (from his
perspective).

**Recovery**: bob's SPA on next launch detects "I have a pending
welcome for channel X that I haven't successfully processed" via
the `mls_pending_welcomes` table (server returns these on hello).
SPA retries the Welcome processing. If it still fails after N
retries, surface to user: "Couldn't join channel X. Ask the
inviter to re-add you."

Alice re-adding bob would consume another of bob's KPs. Wasteful
but correct.

---

## 9. Server implementation

### 9.1 Handler files

New / extended:

| File | Scope |
|------|-------|
| `internal/ws/channel_members.go` (new) | `add_to_channel`, `remove_from_channel` |
| `internal/ws/mls_commits.go` (new) | `mls_commit_bundle` extended, `mls_commit_event` dispatch, `mls_commit_ack` |
| `internal/ws/keypackages.go` (extends 11a) | `fetch_key_packages_batch` |
| `internal/ws/ws_phase08.go` (extends) | `create_channel` extended for MLS multi-member |
| `internal/server/mls_state.go` (new) | `PendingCommitStore` |
| `internal/store/mls_commits.go` (new) | CRUD for `mls_commits` table |
| `internal/store/mls_pending_welcomes.go` (new) | CRUD for `mls_pending_welcomes` table |

### 9.2 Migrations

| Number | File | Scope |
|--------|------|-------|
| 0024 | `0024_mls_commits.sql` | `mls_commits` table + size constraint + index |
| 0025 | `0025_mls_pending_welcomes.sql` | `mls_pending_welcomes` table + size constraint |

Both forward-compatible: existing chalk code that predates them
works fine against the upgraded schema.

**Note on phase-11d migration numbers**: phase 11d's design (doc #4)
provisionally claimed 0024-0028 before the decision to do 11c first.
After 11c ships with 0024-0025, phase 11d's migrations shift to
0026 (backup_envelopes), 0027 (history_secrets), 0028
(critical_events), 0029 (devices extensions), 0030 (devices
origin_kind NOT NULL). Doc #4 and doc #7 should be updated to
reflect this before 11d implementation starts.

### 9.3 Validating MLS commits server-side (§7.3 detail)

The server must validate that membership transitions in a commit
match chalk's permission model. Implementation sketch:

```go
// internal/server/mls_validate.go (new)

func ValidateCommitMembership(
    ctx context.Context,
    db *pgxpool.Pool,
    channelID, initiatorUserID string,
    proposedNewMembers []string,
    proposedRemovedMembers []string,
) error {
    // 1. Look up current channel members
    currentMembers, err := store.ListChannelMembers(ctx, db, channelID)
    if err != nil { return err }

    // 2. For each proposed add, validate
    for _, newMember := range proposedNewMembers {
        if !isFriend(ctx, db, initiatorUserID, newMember) {
            return ErrTargetNotFriend
        }
        if contains(currentMembers, newMember) {
            return ErrAlreadyMember
        }
    }

    // 3. For each proposed remove, validate
    for _, removed := range proposedRemovedMembers {
        if !contains(currentMembers, removed) {
            return ErrTargetNotMember
        }
        // Only the channel creator can remove others; anyone can remove self
        if removed != initiatorUserID {
            creator, err := store.GetChannelCreator(ctx, db, channelID)
            if err != nil { return err }
            if creator != initiatorUserID {
                return ErrNotAuthorized
            }
        }
    }

    return nil
}
```

The hard part is extracting the member list from the commit
bytes WITHOUT decrypting application messages. MLS Commits include
a list of Add and Remove proposals in their public header. CoreCrypto
on the server side could parse this, but chalkd doesn't have
CoreCrypto — it's a pure relay.

**Two options**:
- (a) Server doesn't parse the commit. Instead, the client includes a
  `proposed_changes` field in `mls_commit_bundle` that summarizes
  the membership changes. Server validates against this. Client could
  lie, but if it does, OTHER clients (who DO process the commit)
  will see the real changes and the lie surfaces as a UX inconsistency.
- (b) Add a Go MLS library to chalkd (e.g. `github.com/wireapp/melissa`
  if it exists, or similar) that can parse Commit headers. Significant
  new dependency.

**Recommendation**: option (a). The chalkd MLS validation is
defense-in-depth, not the primary security mechanism (MLS itself
guarantees that membership changes are only effective if accepted
by other members). A lying client that adds a non-friend would be
detected by the other members' clients refusing to process the
commit (CoreCrypto would error on the receive side). Server-side
validation is best-effort prevention.

For 11c v1: client sends explicit `proposed_changes`; server
validates. Document the limitation: a fully-malicious client could
attempt to lie, but the lie cannot propagate beyond the server.

#### Updated `mls_commit_bundle` payload

```go
type MLSCommitBundlePayload struct {
    ChannelID       string            `json:"channel_id"`
    MLSGroupID      string            `json:"mls_group_id,omitempty"`
    Epoch           uint64            `json:"epoch"`
    Commit          string            `json:"commit"`
    Welcomes        map[string]string `json:"welcomes"`

    // NEW in 11c: declared member changes for server-side validation
    ProposedAdds    []string `json:"proposed_adds,omitempty"`
    ProposedRemoves []string `json:"proposed_removes,omitempty"`
}
```

### 9.4 Server-side member-list mutation

After successfully accepting a commit, the server updates
`channel_members`:
- For each proposed add: INSERT new row
- For each proposed remove: DELETE row

This happens in the same transaction as storing the commit, so
either both succeed or both fail.

---

## 10. Client implementation

### 10.1 New client modules

| File | Scope |
|------|-------|
| `web/src/mls/groups.ts` (extends 11b) | `addToChannel`, `removeFromChannel` |
| `web/src/mls/commits.ts` (new) | Commit-race retry, `mls_commit_event` processing |
| `web/src/mls/catchup.ts` (new) | Reconnect catchup via `hello` epoch list |
| `web/src/components/ChannelMembersPanel.tsx` (new) | UI for add/remove |

### 10.2 Group creation flow (extends 11b's DM flow)

For a multi-member non-DM channel:

```typescript
async function createMlsChannel(
  name: string,
  initialMembers: string[],
  session: MlsSession,
  send: SendFn,
): Promise<string> {
  // 1. Server-side: create the channel + batch-fetch KPs
  const ack = await send({
    type: 'create_channel',
    name,
    is_dm: false,
    initial_members: initialMembers,
    encryption_mode: 'mls',
  });

  if (ack.error) {
    if (ack.error.code === 'peer_no_keypackages') {
      throw new ChannelCreationError(
        `${ack.error.details.user} hasn't logged in recently; they need to come online once.`,
      );
    }
    throw new Error(`Channel creation failed: ${ack.error.code}`);
  }

  const { channel_id, keypackages } = ack;

  // 2. Client-side: create the empty group, add members
  await session.cc.createConversation(channel_id);

  const kpList = initialMembers.map(uid => base64Decode(keypackages[uid]));
  const result = await session.cc.addClientsToConversation(channel_id, kpList);

  await session.cc.commitAccepted(channel_id);

  // 3. Send commit bundle
  await send({
    type: 'mls_commit_bundle',
    channel_id,
    mls_group_id: base64Encode(await session.cc.conversationId(channel_id)),
    epoch: 1,
    commit: base64Encode(result.commit),
    welcomes: initialMembers.reduce((acc, uid, i) => {
      acc[uid] = base64Encode(result.welcomes[i]);
      return acc;
    }, {} as Record<string, string>),
    proposed_adds: initialMembers,
    proposed_removes: [],
  });

  return channel_id;
}
```

### 10.3 Receive-side: commit processing

```typescript
async function handleMlsCommitEvent(
  event: MLSCommitEventPayload,
  session: MlsSession,
): Promise<void> {
  // Skip own commits (we already merged locally)
  if (event.committed_by === session.userID) return;

  const commitBytes = base64Decode(event.commit_bytes);

  try {
    await session.cc.decryptMessage(event.channel_id, commitBytes);
    // CoreCrypto handles the commit internally; our local epoch advances
  } catch (err) {
    // If the error is "stale commit" we're missing prior commits
    if (err.code === 'CryptoError.StaleProposal' || err.code === 'CryptoError.WrongEpoch') {
      // Trigger catchup
      await catchupChannel(event.channel_id, session);
      // Then retry
      await session.cc.decryptMessage(event.channel_id, commitBytes);
    } else {
      throw err;
    }
  }

  // Ack to server
  await send({
    type: 'mls_commit_ack',
    channel_id: event.channel_id,
    epoch: event.epoch,
  });
}
```

### 10.4 Commit-race retry

```typescript
async function commitWithRetry(
  channelID: string,
  buildCommit: () => Promise<MlsCommitResult>,
  send: SendFn,
  maxAttempts = 5,
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await buildCommit();
    try {
      await send({
        type: 'mls_commit_bundle',
        channel_id: channelID,
        epoch: result.newEpoch,
        commit: base64Encode(result.commit),
        welcomes: result.welcomes,
        proposed_adds: result.proposedAdds,
        proposed_removes: result.proposedRemoves,
      });
      return; // success
    } catch (err) {
      if (err.code === 'mls_stale_commit') {
        // Wait for the winning commit to land via mls_commit_event push
        await waitForEpochAdvance(channelID, attempt + 1);
        // Loop continues; buildCommit() will use the new epoch
      } else {
        throw err;
      }
    }
  }
  throw new Error(`Commit retry exhausted after ${maxAttempts} attempts`);
}
```

### 10.5 Catchup on connect

```typescript
async function catchupChannel(
  channelID: string,
  session: MlsSession,
): Promise<void> {
  const localEpoch = await session.cc.conversationEpoch(channelID);

  // Server will push mls_commit_event frames for all missing commits
  // in response to hello-with-epochs
  // For one-off catchup mid-session, request explicitly:
  await send({
    type: 'fetch_mls_commits',
    channel_id: channelID,
    after_epoch: localEpoch,
  });

  // The ack carries the missing commits; process them in order
}
```

Note: `fetch_mls_commits` and `fetch_mls_commits_ack` are listed in
§5.1 as part of the full 10-frame count.

---

## 11. Testing

### 11.1 Unit tests

Per-component:
- `add_to_channel` handler: friend-check, KP-consume, already-member,
  no-KP cases
- `remove_from_channel` handler: self-remove allowed, creator-removes-other
  allowed, other-removes-other denied
- `mls_commit_bundle` validation: epoch-match, declared-changes-match,
  proposed-adds/removes pass permission check
- `fetch_key_packages_batch` handler: partial-failure response shape
- Client `commitWithRetry`: backoff and retry on stale_commit

### 11.2 Integration tests (sandbox + chalk)

Critical scenarios:

| ID | Scenario | Notes |
|----|----------|-------|
| IT-11c-1 | 4-member channel creation, all members receive Welcome, can send + decrypt | The basic happy path |
| IT-11c-2 | Add 5th member to existing 4-member channel | Existing members process Commit, new member processes Welcome |
| IT-11c-3 | Remove a member; removed member can't decrypt subsequent messages | MLS forward secrecy |
| IT-11c-4 | Removed member's local UI cleanly handles the removal | No crash, archived state |
| IT-11c-5 | Two members simultaneously commit; one wins, other retries successfully | Commit race |
| IT-11c-6 | Create-channel with a member who has zero KPs → hard fail | KP exhaustion |
| IT-11c-7 | Member offline during commit → catches up on reconnect | mls_pending_welcomes + commit replay |
| IT-11c-8 | Channel creator leaves; other members can continue messaging | No remove-others until phase 13 admins |
| IT-11c-9 | Last member leaves → channel auto-deleted | Cleanup |
| IT-11c-10 | Pre-11c plaintext channel still works for sending/receiving | Backward compat |
| IT-11c-11 | New member joining a 6-month-old channel sees no pre-join history | History-on-join non-goal validated |
| IT-11c-12 | Server-side validation: client sends commit with declared "add carol" but commit bytes actually add eve → server detects and rejects | proposed_changes verification |

### 11.3 E2E (Playwright)

Three browser sessions: alice, bob, carol.

| ID | Scenario |
|----|----------|
| E2E-11c-1 | alice creates 3-member channel (alice + bob + carol), sends "hello", both bob and carol see it; server-side row shows mls_ciphertext |
| E2E-11c-2 | alice adds dave (4th browser session); dave's sidebar shows the channel, he can see post-add messages |
| E2E-11c-3 | alice removes carol; carol's sidebar removes the channel; alice's next message is not visible to carol (would require checking she's offline / inspecting another tab) |
| E2E-11c-4 | Race: alice and bob both add a member at the same time; one wins, other retries; final member list is consistent across all clients |

---

## 12. Migration & landing sequence

Suggested split into sub-phases for incremental landing:

### 11c-1 — Server-side foundation

**Scope**:
- Migration 0024 (mls_commits)
- Migration 0025 (mls_pending_welcomes)
- Store layer for both tables + unit tests
- `add_to_channel` / `remove_from_channel` handlers (without
  triggering MLS yet — just chalk-side member-list mutation)
- `fetch_key_packages_batch` handler
- Server-side validation logic in `mls_validate.go`

**Acceptance**: chalkd unit + integration tests pass; manual
admin-only manipulation of channel membership works (without
client-side MLS yet).

### 11c-2 — Client-side group creation

**Scope**:
- `createMlsChannel` flow (§10.2)
- `mls_commit_bundle` send with multiple welcomes
- Server-side handling of multi-welcome bundles + fan-out
- Server-side validation enforcement via `proposed_adds` /
  `proposed_removes`

**Acceptance**: IT-11c-1 passes. Three users in a fresh channel can
exchange MLS-encrypted messages.

### 11c-3 — Add / Remove / Welcome handling

**Scope**:
- `mls_commit_event` push + client processing
- `mls_commit_ack` flow
- Server-side `PendingCommitStore`
- Member add/remove triggered from client UI
- Race retry logic on client (`commitWithRetry`)

**Acceptance**: IT-11c-2 through IT-11c-5 pass. UI for adding/removing
members works in the SPA.

### 11c-4 — Catchup + offline scenarios

**Scope**:
- `hello`-with-epochs extension
- `mls_pending_welcomes` delivery on reconnect
- `fetch_mls_commits` frame
- Removed-member cleanup UI

**Acceptance**: IT-11c-6 through IT-11c-12 pass.

### 11c-5 — E2E + polish

**Scope**:
- Playwright E2E tests
- UI polish (lock icon for MLS channels, "you joined on <date>"
  marker)
- CHANGELOG + phase-log update
- Final round of manual testing

**Acceptance**: All E2E tests pass; manual cross-browser smoke
passes.

Estimated calendar time: ~2-3 weeks per sub-phase with one engineer.
~10-15 weeks total for 11c.

---

## 13. Known limitations at 11c v1 ship

1. **No history on join.** New members see only post-join messages.
2. **One device per user.** Login on a second profile = new MLS
   identity = can't decrypt your own past messages from your first
   profile. Phase 11d.
3. **Channel creator is the only one who can remove others.** No
   role/admin system. Phase 13.
4. **Pre-11c plaintext channels stay plaintext forever.** No upgrade
   path within a channel.
5. **Consumed-but-unused KeyPackages on creation failure are wasted.**
   No release frame. Edge case; accept the waste.
6. **Server-side commit validation is best-effort.** A malicious
   client could declare false `proposed_changes`; other clients
   detect the lie at decrypt time, but the bad commit could still
   reach the server's storage. Defense in depth, not airtight.
7. **No quorum / threshold operations.** Add and Remove are unilateral
   per the permission model. No "two-of-three must agree" semantics.
8. **No member presence under MLS.** Existing plaintext presence
   continues to work. Phase 14+.

---

## 14. Open questions

**Q-11c-1**: Should we support "convert a plaintext channel to MLS"?

Recommendation: no. The conversion would either (a) lose all
plaintext history visibility (no benefit over creating a new
channel), or (b) keep both encrypted and plaintext messages in the
same channel (confusing). Tell users to create a new channel if
they want encryption.

**Q-11c-2**: Channel creator's role beyond "can remove others"?

For 11c v1, the creator has only that one special privilege.
Defer formal admin/role system to a later phase.

**Q-11c-3**: Maximum channel size?

MLS itself handles thousands of members efficiently. The bottleneck
in practice is probably client-side: a 100-member channel means
99 KeyPackage fetches at creation, 99 Welcome encrypts/decrypts,
and per-message epoch keys for 100 members.

Practical limit for 11c v1: soft cap at 50 members. Hard cap at
200. Tunable via server config. If usage shows scale needs,
revisit.

**Q-11c-4**: Should `mls_pending_welcomes` have TTL?

Currently: indefinite. A user who never returns has welcomes
sitting in the table forever.

Recommendation for v1: no TTL. The storage cost is bounded (one
row per pending invitation per inactive user). If accounts get
deleted (phase 12), the row cascades away.

**Q-11c-5**: How do we handle "alice tries to add bob to a channel,
but bob is blocked from chalk by an admin"?

The admin moderation flow (phase 09d) blocks bob's account. Bob's
`is_blocked = true`. `add_to_channel` handler should check this
and refuse with `target_blocked`.

Action: add to validation in §5.2.

**Q-11c-6**: Per-channel encryption-disable for admins (debugging)?

If a channel breaks (corrupted MLS state somehow), admin needs a
way to inspect. Adding a debug flag `--admin-disable-mls=<channel_id>`
that forces plaintext for that channel?

Strong no. Defeats the security model. If a channel breaks,
delete it and create a new one. Document the recovery procedure.

---

## 15. Summary

11c extends MLS from DMs to multi-member channels. The new pieces:

- **Member add/remove flows** with Commits and per-member Welcomes
- **Commit-race resolution** via server epoch validation + client
  retry
- **KeyPackage batching** for multi-member group creation
- **Server-side membership validation** based on declared
  proposed_changes (best-effort defense in depth)
- **Catchup on reconnect** via stored commits in `mls_commits` table
- **Pending welcomes** table for offline recipients

What 11c does NOT include:
- History on join (intentional; matches MLS forward secrecy)
- Multi-device per user (phase 11d)
- Roles/admins beyond "channel creator" (phase 13)
- Plaintext-to-MLS upgrade for existing channels

10 new wire frames, 2 new migrations (0024, 0025), 7 new
server-side handler/store files, 4 new client modules.

Estimated 5 sub-phases (11c-1 through 11c-5), ~10-15 weeks total
calendar time for a single engineer.

End of phase 11c design doc. Vienna 2026-05-28.
