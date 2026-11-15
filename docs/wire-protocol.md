# Wire Protocol

JSON over WebSocket. Subprotocol: `chalk.v1`. Path: `/ws`.

>
> **Crypto status:** chalk is end-to-end encrypted. Message and attachment
> bodies on the wire are ciphertext (per-channel space keys, AES-256-GCM);
> the server relays opaque bytes. Key distribution is via identity-wrapped
> space-key frames. This document describes the live `chalk.v1` protocol.

Every frame has a `type` (string) and an optional `ref` (correlation ID for request/response). Server-initiated frames omit `ref`.

## Lifecycle

1. Client connects with a session cookie (`chalk_sid`) obtained via passkey auth.
2. Client sends `hello { device_id }`.
3. Server replies `welcome { user_id, device_id, channels: [...] }`.
4. Steady-state frame exchange.
5. Either side closes; server reaps state.

## Client → Server

| Type | Payload | Notes |
|---|---|---|
| `hello` | `{ device_id }` | First frame after connect |
| `create_channel` | `{ name, initial_members: [user_id...] }` | |
| `send` | `{ channel_id, parent_id?, body, key_version, client_msg_id? }` | `body` is base64 ciphertext; `key_version >= 1` is enforced |
| `fetch_history` | `{ channel_id, after_seq?, before_seq?, limit }` | Catch-up via per-channel `seq` |
| `fetch_thread` | `{ channel_id, thread_id }` | All messages in one thread |
| `upload_blob_init` | `{ size, mime_hint }` | Returns upload URL + token |
| `presence_set` | `{ state: "active"\|"away"\|"dnd" }` | Per-device |
| `typing` | `{ channel_id, thread_id? }` | Ephemeral, not persisted. No ack. Throttled server-side; over-rate and non-member frames are dropped silently. `thread_id` is relayed but unused |
| `friend_request_send` | `{ handle, encrypted_intro? }` | |
| `friend_request_accept` | `{ request_id }` | |
| `ack` | `{ message_id }` | Read receipts (optional) |
| `delete_message` | `{ channel_id, message_id, ts }` | Own message always; another's per governance |
| `edit_message` | `{ channel_id, message_id, ts, body, key_version }` | Phase 37: sender only, within 15 min, not deleted |
| `set_reactions` | `{ channel_id, message_id, ts, body, key_version? }` | Phase 37: replaces YOUR whole set; empty body clears |
| `fetch_reactions` | `{ channel_id, message_ids }` | Backfill after a history fetch |

## Server → Client

| Type | Payload | Notes |
|---|---|---|
| `welcome` | `{ user_id, device_id, channels, friends }` | After `hello` |
| `message` | `{ id, channel_id, thread_id?, parent_id?, sender, ts, seq, body }` | |
| `member_change` | `{ channel_id, added: [...], removed: [...] }` | |
| `presence_update` | `{ user_id, online, encrypted_state? }` | Friend presence change |
| `typing_update` | `{ channel_id, thread_id?, user_id }` | Sent to a channel's other members only -- never to the typist's own devices. Holds for a few seconds, then expires client-side; there is no stop frame |
| `friend_request_in` | `{ request_id, from_handle, encrypted_intro? }` | |
| `friend_added` | `{ user_id, handle, devices: [...] }` | |
| `message_deleted` | `{ channel_id, message_id, seq, deleted_by?, deleted_at? }` | Tombstone the row locally |
| `message_edited` | `{ channel_id, message_id, seq, body, key_version, edited_at }` | Phase 37: swap the body in place; `seq` is unchanged |
| `reaction_update` | `{ channel_id, reaction: { message_id, ts, user_id, body?, key_version? } }` | Phase 37: one member's new set; empty body = cleared |
| `server_notice` | `{ kind, version?, commit? }` | An announcement about the server itself. `kind: "restarting"` is fanned out to every connection on the instance just before graceful shutdown closes them. Unknown kinds are ignored client-side |
| `error` | `{ ref?, code, message }` | |

## Web push (phase 65)

The push frames exist only on a sealed connection. A guest connection and a connection without a login session cannot use them.

| Type | Payload | Notes |
|---|---|---|
| `push_state` | none | Asks for the push settings and the subscription of the session of this connection |
| `push_subscribe` | `PushSubscribePayload` | Stores the browser subscription for this session and replaces an earlier one |
| `push_unsubscribe` | none | Deletes the subscription of this session |

The server answers each request with a `push_state_ack`, `push_subscribe_ack`, or `push_unsubscribe_ack` frame.
The ack has the `ref` of the request.
Its payload is always a `PushStatePayload`.

`PushSubscribePayload` fields:

| Field | Meaning |
|---|---|
| `endpoint` | The https URL of the push service for this browser |
| `p256dh` | The public key of the browser, base64url |
| `auth` | The auth secret of the browser, base64url |
| `scope` | `dms` or `all` |
| `vapid_public_key` | The `applicationServerKey` that the browser subscribed with |

`PushStatePayload` fields:

| Field | Meaning |
|---|---|
| `enabled` | True if the server sends push |
| `vapid_public_key` | The key a browser must subscribe with. Absent if `enabled` is false |
| `subscribed` | True if the session has a subscription |
| `endpoint` | The endpoint of the subscription. Absent if there is none |
| `scope` | The scope of the subscription. Absent if there is none |
| `key_current` | True if the browser made the subscription with `vapid_public_key`. A subscription with `key_current` false receives no push |

The server answers a failed request with an `error` frame.
These codes belong to the push frames:

| Code | Meaning |
|---|---|
| `push_disabled` | Push is off on the server. Only `push_subscribe` answers with this code |
| `push_unsealed` | The connection has no sealed channel |
| `push_no_session` | The connection has no login session, or the session ended |
| `push_key_stale` | The browser subscribed with a key that is not the current key. Subscribe again with the key from `push_state` |

## Reminder wakes (phase 87-7)

The server holds one wake record for each pending reminder of a user who has web push on.
A record is a random reminder ID and a due time.
It holds no message, no channel, and no text.
The frame exists only on a sealed connection.
A guest connection and a connection without a login session cannot use it.

| Type | Payload | Notes |
|---|---|---|
| `reminder_wakes_set` | `ReminderWakesSetPayload` | Replaces the whole wake set of the user |

The server answers with a `reminder_wakes_set_ack` frame.
The ack has the `ref` of the request.
Its payload is a `ReminderWakesAckPayload`.

`ReminderWakesSetPayload` fields:

| Field | Meaning |
|---|---|
| `wakes` | A list of at most 25 records. An empty list deletes the stored set |

Each record of `wakes` has these fields:

| Field | Meaning |
|---|---|
| `id` | The random UUID of the reminder. It must occur once in the list |
| `due_at` | The due time in milliseconds since the Unix epoch. It must be greater than 0 and less than 253402300800000 |

`ReminderWakesAckPayload` fields:

| Field | Meaning |
|---|---|
| `stored` | The number of records that the server holds after the frame. It is 0 if the user has no push subscription |

If the user has no push subscription, the server deletes the set and stores nothing.
The server deletes the set of a user when the last push subscription of the user goes away.
A refused frame leaves the stored set unchanged.
The server answers a refused frame with an `error` frame.
These codes belong to the frame:

| Code | Meaning |
|---|---|
| `push_unsealed` | The connection has no sealed channel |
| `push_no_session` | The connection is a guest connection or has no login session, or the session ended |
| `push_disabled` | Push is off on the server |
| `bad_payload` | The list has more than 25 records, an `id` is not a UUID, an `id` occurs twice, or a `due_at` is out of range |

### Push plaintext

The server sends each push to the push service as an RFC 8291 encrypted body.
The server pads the plaintext to 1024 bytes before encryption, so every body has one length.
The plaintext is one JSON object.
It has no field for message content.

| Field | Meaning |
|---|---|
| `v` | The version. Always 1 |
| `kind` | The kind. Always `message` |
| `channel_id` | The channel of the message |
| `message_id` | The message |
| `thread_id` | The thread of the message. Absent if the message is not in a thread |
| `sender_handle` | The handle of the sender, cut to 80 characters |
| `channel_name` | The channel name, cut to 80 characters. Absent for a direct message |
| `is_dm` | True for a direct message |
| `unread` | The badge count for the recipient, at most 99 |

The service worker parses this object in `parsePushPayload` (`web/src/sw-logic.ts`).
For anything else, it shows a generic notification.

### Click URL

If no chalk window is open, a click on a notification opens `/?open=<channel>&thread=<thread>`.
The `thread` parameter is absent for a message outside a thread.
Both ids match `^[A-Za-z0-9-]{1,64}$`.
The worker and the page both check them.
If the channel id is not valid, the worker opens `/`.
The page drops the query from the address when it loads.

## Encoding

JSON for v1. CBOR may be added behind a subprotocol negotiation in v2 if profiling shows JSON overhead is meaningful. Binary blobs (e.g. attachment chunks) are base64-encoded inside JSON frames where needed.

## Frame size limits

- Default max frame: 1 MiB
- Attachment uploads do NOT go over WebSocket; they use a separate `POST /api/v1/blobs/:id` with `Content-Type: application/octet-stream`

## Pings

Server pings every 15s. Connection torn down on missed pong after 30s. Implemented by the WebSocket library, not the application layer.
