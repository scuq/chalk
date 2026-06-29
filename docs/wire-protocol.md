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
| `send` | `{ channel_id, thread_id?, parent_id?, body }` | Application messages (plaintext body) |
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
| `message` | `{ id, channel_id, thread_id?, parent_id?, sender, ts, seq, body }` | |
| `member_change` | `{ channel_id, added: [...], removed: [...] }` | |
| `presence_update` | `{ user_id, online, encrypted_state? }` | Friend presence change |
| `typing_update` | `{ channel_id, thread_id?, user_id }` | |
| `friend_request_in` | `{ request_id, from_handle, encrypted_intro? }` | |
| `friend_added` | `{ user_id, handle, devices: [...] }` | |
| `error` | `{ ref?, code, message }` | |

## Encoding

JSON for v1. CBOR may be added behind a subprotocol negotiation in v2 if profiling shows JSON overhead is meaningful. Binary blobs (e.g. attachment chunks) are base64-encoded inside JSON frames where needed.

## Frame size limits

- Default max frame: 1 MiB
- Attachment uploads do NOT go over WebSocket; they use a separate `POST /api/v1/blobs/:id` with `Content-Type: application/octet-stream`

## Pings

Server pings every 15s. Connection torn down on missed pong after 30s. Implemented by the WebSocket library, not the application layer.
