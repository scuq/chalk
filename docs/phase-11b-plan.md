# Phase 11b — MLS DM encryption (plan)

Status: **planned**. Phase 11a foundation is operational
(KeyPackages published, stored, claimable). 11b layers actual
encryption on top, scoped to direct messages.

## Goal

When alice2 sends a DM to bob2:
- The message body is MLS-encrypted on alice2's device
- The server receives and stores opaque ciphertext bytes
- bob2 decrypts on his device
- The server cannot read the body, at rest or in transit

Channels (multi-member) remain plaintext; that's 11c.

## Scope decisions

### Which DMs become MLS?

**Hard cutover, new-only.** All DMs created from 11b onwards are
MLS. Existing DMs stay plaintext forever — migrating them gains
nothing (the server already saw those messages). A "lock" icon in
the channel header indicates encryption status.

### What if the peer is offline?

**Fail cleanly.** If bob2 has zero unused KeyPackages on the server
(never logged in since 11a, or used them all), alice2's attempt to
start an encrypted DM shows: "bob2 hasn't logged into chalk recently;
encrypted messaging needs them to come online once." No silent
plaintext fallback.

### Multi-device per user

**Deferred to 11d.** For 11b: assume one device per user. If you log
in on a second browser profile, encrypted DMs from your other
profile won't decrypt. We accept this limitation; 11d adds the
"self-add at login" flow.

### Thread metadata under MLS

The server needs to route by `parent_id` / `thread_id`, so those
stay plaintext alongside the ciphertext (they're just opaque UUIDs,
no content leak).

`last_reply_body` and `last_reply_sender_user_id` are computed
server-side from row contents — under MLS the server can't see the
body. For MLS DM rows: `last_reply_body` drops to empty string.
The preview line in the main feed will show just the sender's name
(or hide entirely for MLS rows; UX decision).

### Wire frame shape

The `messages` table already has a `content_type` column for
routing per RFC 9420 vocabulary. We add a new content type:
- `application` — plaintext (existing)
- `mls_ciphertext` — MLS-encrypted body (new in 11b)

The server never decodes `mls_ciphertext`; it stores the bytes and
fans out the existing `message` push frame. Clients distinguish by
content_type and decrypt accordingly.

## Server changes

### New migration `0022_mls_groups.sql`

```sql
CREATE TABLE mls_groups (
    channel_id UUID PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    -- The MLS group ID (opaque bytes from CoreCrypto)
    mls_group_id BYTEA NOT NULL,
    current_epoch BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### New WS frames in `proto.go`

```go
// mls_commit_bundle: client uploads a Commit + Welcome after
// creating or modifying an MLS group. Server stores the Commit
// (for late-joining devices to catch up) and fans out the
// Welcome to the addressee's connected devices.
TypeMlsCommitBundle    = "mls_commit_bundle"
TypeMlsCommitBundleAck = "mls_commit_bundle_ack"

// mls_welcome: server -> client push. The addressee processes
// this to join the MLS group. After processing, the client acks
// so the server knows the welcome was delivered.
TypeMlsWelcome    = "mls_welcome"
TypeMlsWelcomeAck = "mls_welcome_ack"
```

### Modified `handleSend`

When `content_type == "mls_ciphertext"`:
- Skip any "looks like a plain string" sanity check
- Store the raw bytes in `messages.ciphertext`
- Pass through to the existing fan-out

### Modified `ListMessagesByChannel`

The LATERAL preview join (from 10e) should NOT populate
`last_reply_body` for rows where `content_type == "mls_ciphertext"`.
Return empty string for those.

## Client changes

### New module `web/src/mls/groups.ts`

High-level helpers above `loader.ts`:

```ts
// Returns the MLS group ID for a channel, creating it if absent.
// For a new DM with peer bob2:
//   1. Fetch bob2's KeyPackage via fetch_key_packages
//   2. CoreCrypto: create conversation, add bob2's KP
//   3. Send commit_bundle to server
//   4. Wait for ack
// Returns the group_id for use in encryptMessage.
async function ensureGroupForDM(channelID, peerUserID, session, send);

// Encrypt a plaintext body for the given group.
async function encryptForGroup(groupID, body, session);

// Decrypt an incoming ciphertext (returns plaintext bytes).
async function decryptForGroup(groupID, ciphertext, session);

// Process an incoming Welcome (sent by another user adding us).
// Returns the new group_id.
async function processWelcome(welcome, session);
```

### Modified `Composer` / send path

For a DM channel where the SPA has an MLS group:
- Before sending, call `encryptForGroup(groupID, body, session)`
- Set `content_type: "mls_ciphertext"`, body field = base64 ciphertext

For a DM channel where the SPA does NOT have an MLS group:
- Call `ensureGroupForDM` first (which sets up MLS)
- Then send as encrypted

For non-DM channels: unchanged (plaintext).

### Modified frame intake (App.tsx `handleFrame`)

When a `TypeMessage` push arrives:
- If `content_type === "mls_ciphertext"`, call `decryptForGroup`
  before dispatching `kind: "message"` to the reducer
- The reducer never sees ciphertext; it always sees plaintext bodies
- Failed decryption: log warning, dispatch a "decryption failed"
  placeholder message (e.g. "[unable to decrypt]")

### Welcome push handling

New case in `handleFrame`: `TypeMlsWelcome` → call `processWelcome`
in MLS session → ack to server.

## Testing matrix

1. alice2 creates a new DM with bob2 (both online):
   - DM channel appears
   - alice2 sends "hello" → ciphertext on the wire → bob2 sees "hello"
   - Server-side query `SELECT content_type, ciphertext FROM messages
     WHERE channel_id = '...'` shows `mls_ciphertext` and unreadable bytes
2. alice2 reloads → still has group state → can still decrypt history
3. bob2 reloads → same
4. New DM in offline scenario:
   - Take bob2 offline
   - alice2 tries to DM bob2 from a never-existed channel
   - Surfaces: "bob2 hasn't logged in recently..."
   - alice2 brings bob2 back, retries → succeeds
5. Old (pre-11b) plaintext DMs:
   - Should still be readable
   - New messages in those channels: TBD (force-encrypt by group-init,
     or leave as plaintext forever?)

## Open questions to decide at the start of 11b

- For pre-11b plaintext DMs: do new messages in them start a new
  MLS group (mixed history)? Or stay plaintext for the lifetime
  of the channel? **My lean: stay plaintext for that channel's
  whole life; users can create a new DM to upgrade.**

- The KeyPackage refresh cycle: bob2 has 10 KPs. If alice2 starts
  a DM, one is consumed. After 3 consumed, the threshold triggers
  bob2's client to refill on next WS open. Is 10/3 the right
  ratio, or should we go bigger?

- Lock icon UX: where does it sit? Channel header? Per-message?
  Per-DM in the sidebar?

## What 11b does NOT include

- Multi-member channel encryption (that's 11c)
- Multi-device sync within a user (that's 11d)
- Forward secrecy via periodic key rotation (could be 11e or later)
- Sender key auth — relying on the existing username/passkey
  binding plus MLS's own credential checks for now
- Per-message ACK or read receipts under encryption (existing acks
  remain plaintext over the existing channel)

## Estimated scope

~800-1200 lines net code change. Multiple debug iterations expected;
the CoreCrypto API surface for group operations is larger than the
KeyPackage surface we exercised in 11a. Likely 3-5 hotfixes before
the happy path lands.
