# Wire Protocol

JSON over WebSocket. Subprotocol: `chalk.v1`. Path: `/ws`.

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
| `publish_keypkgs` | `{ keypackages: [b64...] }` | Refill MLS KeyPackage pool |
| `create_channel` | `{ name, initial_members: [user_id...] }` | |
| `join_request` | `{ channel_id }` | Server forwards to existing member |
| `fetch_keypkg` | `{ user_id, device_id }` | For MLS Add operation |
| `send` | `{ channel_id, thread_id?, parent_id?, ciphertext, mls_epoch, content_type }` | Application messages |
| `fetch_history` | `{ channel_id, after_seq?, before_seq?, limit }` | Catch-up via per-channel `seq` |
| `fetch_thread` | `{ channel_id, thread_id }` | All messages in one thread |
| `upload_blob_init` | `{ size, mime_hint }` | Returns upload URL + token |
| `presence_set` | `{ state: "active"\|"away"\|"dnd" }` | Per-device |
| `typing` | `{ channel_id, thread_id? }` | Ephemeral, not persisted |
| `friend_request_send` | `{ handle, encrypted_intro? }` | |
| `friend_request_accept` | `{ request_id }` | |
| `ack` | `{ message_id }` | Read receipts (optional) |

## Server → Client

| Type | Payload | Notes |
|---|---|---|
| `welcome` | `{ user_id, device_id, channels, friends }` | After `hello` |
| `message` | `{ id, channel_id, thread_id?, parent_id?, sender, ts, seq, ciphertext, mls_epoch, content_type }` | |
| `mls_commit` | `{ channel_id, ciphertext, epoch }` | Group state changes |
| `mls_welcome` | `{ channel_id, ciphertext }` | You've been added to a group |
| `member_change` | `{ channel_id, added: [...], removed: [...] }` | |
| `presence_update` | `{ user_id, online, encrypted_state? }` | Friend presence change |
| `typing_update` | `{ channel_id, thread_id?, user_id }` | |
| `keypkg_low` | `{ remaining: N }` | Refill request |
| `friend_request_in` | `{ request_id, from_handle, encrypted_intro? }` | |
| `friend_added` | `{ user_id, handle, devices: [...] }` | |
| `error` | `{ ref?, code, message }` | |

## Encoding

JSON for v1. CBOR may be added behind a subprotocol negotiation in v2 if profiling shows JSON overhead is meaningful. Binary blobs (MLS ciphertext, keypackages) are base64-encoded inside JSON frames.

## Frame size limits

- Default max frame: 1 MiB
- Attachment uploads do NOT go over WebSocket; they use a separate `POST /api/v1/blobs/:id` with `Content-Type: application/octet-stream`

## Pings

Server pings every 15s. Connection torn down on missed pong after 30s. Implemented by the WebSocket library, not the application layer.
