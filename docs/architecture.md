# Architecture

## One-line summary

Multi-instance Go server backed by Postgres (storage + LISTEN/NOTIFY pub/sub). Browser client speaks MLS (RFC 9420) for end-to-end group encryption via WASM. Server only ever sees ciphertext, routing metadata, and coarse presence.

## Components

```
                 ┌──────────────┐
   browser  ──▶  │   chalkd #1  │ ──┐
                 └──────────────┘   │
                                    ├──▶ Postgres
                 ┌──────────────┐   │   (storage + LISTEN/NOTIFY)
   browser  ──▶  │   chalkd #N  │ ──┘
                 └──────────────┘
```

Each chalkd is stateless except for in-memory WebSocket connection state. Postgres is the source of truth and the message bus.

## Why Postgres for pub/sub

`LISTEN/NOTIFY` is sufficient for chat workloads up to thousands of concurrent users on a single PG instance. It's payload-light, sub-ms in-database, and means we don't run a second data store.

Each chalkd instance holds:
- One pgx connection pool for queries
- One dedicated `LISTEN` connection for receiving fan-out
- An in-memory hub mapping `channel_id → []*conn` for routing notifications to local sockets

Notifications are tiny (`{channel_id, message_id, seq}`); the row is fetched once per receiving instance, not once per receiver.

## E2E crypto

- **Messages**: MLS (RFC 9420) via `@wireapp/core-crypto` WASM in a Web Worker. One MLS group per chalk channel. Threading is plaintext metadata in the encrypted MLS payload (server sees thread IDs but not content).
- **Attachments**: AES-256-GCM via WebCrypto. Client encrypts with a fresh random key, uploads ciphertext, embeds `{blob_id, key, nonce}` in the encrypted message.
- **Settings, theme, sound prefs**: encrypted blob server-side, decrypted client-side.

## Server's role

| Sees | Doesn't see |
|---|---|
| User identities (handles, public keys) | Message content |
| Channel membership | Attachment content / filenames |
| Message IDs, thread IDs, parent IDs | Thread topics, presence detail |
| Timestamps, sender device | Settings detail |
| Attachment blob IDs and sizes | Identities of friends-of-friends |
| Coarse presence (online/offline from socket) | Active/away/dnd granularity |

## Multi-device

Each device is a separate MLS member with its own identity key and KeyPackages. Devices have a type (`phone` / `tablet` / `desktop`) which drives presence TTLs:

| Device type | "Active" TTL |
|---|---|
| phone | 90 seconds |
| tablet | 3 minutes |
| desktop | 10 minutes |

User's aggregate presence = max(device states), where a device's state decays to `away` after its TTL elapses.

## Authentication

Passkeys (WebAuthn) only. No passwords anywhere in the system.

A 24-word recovery phrase, shown once at registration, is stored on the server as an Argon2id hash. The phrase is **enrollment-only**: it can register a new passkey on a fresh device but never grants login, message read, or message write capability. Recovery establishes new sessions going forward; it does not restore historical message decryption (MLS forward secrecy).

## Threading model

Slack-style: one MLS group per channel; threads are flat metadata. A message has:
- `thread_id` (UUID, null = top-level channel message)
- `parent_id` (UUID, optional reply-target inside a thread)

Threads are not nested. The server can serve `fetch_thread(channel_id, thread_id)` as a fast indexed query. Clients reconstruct UI hierarchy.

## Containerization

Single Go binary, distroless final image (~25MB). Docker compose stacks for dev, test, and a multi-instance production example with Caddy in front for TLS termination and sticky WebSocket sessions.
