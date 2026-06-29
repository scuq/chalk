# Architecture

## One-line summary

Multi-instance Go server backed by Postgres (storage + LISTEN/NOTIFY
pub/sub). Browser client over WebSocket. **Messages and attachments are
end-to-end encrypted** under an identity-wrapped-space-key design (phases
22–25; native WebCrypto, AES-256-GCM), with the server as a blind relay.

> **Crypto status.** chalk is end-to-end encrypted (identity-wrapped space
> keys, native WebCrypto — no MLS, no WASM, no bundled crypto library). The
> server stores and relays only ciphertext. The earlier MLS (RFC 9420)
> implementation was removed in the 21-series and replaced across phases
> 22–25.

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

Each chalkd is stateless except for in-memory WebSocket connection state.
Postgres is the source of truth and the message bus.

## Why Postgres for pub/sub

`LISTEN/NOTIFY` is sufficient for chat workloads up to thousands of
concurrent users on a single PG instance. It's payload-light, sub-ms
in-database, and means we don't run a second data store.

Each chalkd instance holds:
- One pgx connection pool for queries
- One dedicated `LISTEN` connection for receiving fan-out
- An in-memory hub mapping `channel_id → []*conn` for routing notifications
  to local sockets

Notifications are tiny (`{channel_id, message_id, seq}`); the row is
fetched once per receiving instance, not once per receiver.

## Message storage (current)

Messages live in a `messages` table partitioned by `ts` (RANGE). The body
column is `body BYTEA` — currently UTF-8 plaintext. There is no
`content_type`, `mls_epoch`, or per-channel `is_mls` flag; all of that was
removed in 21-7. A message row carries `id, channel_id, thread_id,
parent_id, sender_device_id, seq, ts, delivered_at, body, meta`.

## Planned E2E crypto (phase 22+)

Not yet implemented. The design (see the rebuild plan + AMENDMENT):

- **Identity keys (phase 22):** each user derives an X25519 + Ed25519
  keypair from a 24-word BIP-39 phrase. X25519 is imported into WebCrypto
  via a PKCS#8 template (raw private-key import isn't supported for
  X25519); Ed25519 is used for signatures. Private key lives in IndexedDB;
  public keys + a `generation` go in a server `identity_keys` table. All
  native WebCrypto — no bundled crypto.
- **Space keys (phase 23):** one long-lived symmetric key per space,
  wrapped per-member under their X25519 public key (ECDH → HKDF → AES-GCM).
  Messages encrypted AES-256-GCM with a key-version tag. The server becomes
  a blind relay again.
- **Verification (phase 24):** picture-word out-of-band check to defeat
  active key substitution.
- **Rotation + governance (phase 25):** weekly space-key rotation; identity
  rotation re-wraps space keys (from a device holding the old key, or from
  the user re-entering their externally-saved phrase).

Explicit non-goals of the new design: forward secrecy and post-quantum
security. See the AMENDMENT for the recovery/rotation model and its limits.

## Server's role

Today (plaintext) the server sees everything it stores, including message
content. Under the phase 22+ design it returns to seeing only:

| Will see | Won't see (phase 22+) |
|---|---|
| User identities (handles, public keys) | Message content |
| Channel membership | Thread topics |
| Message IDs, thread IDs, parent IDs | Settings detail |
| Timestamps, sender device | Friends-of-friends identities |
| Coarse presence (online/offline from socket) | Active/away/dnd granularity |

## Multi-device

Each device has a type (`phone` / `tablet` / `desktop`) which drives
presence TTLs:

| Device type | "Active" TTL |
|---|---|
| phone | 90 seconds |
| tablet | 3 minutes |
| desktop | 10 minutes |

User's aggregate presence = max(device states), where a device's state
decays to `away` after its TTL elapses. (Under phase 22+, each device also
holds its own copy of the identity private key, restored from the phrase.)

## Authentication

Passkeys (WebAuthn) only. No passwords anywhere in the system.

Account recovery uses one-time **recovery codes** (Argon2id-hashed
server-side) to register a new passkey on a fresh device — auth recovery
only, decoupled from message decryption. The separate 24-word phrase
(phase 22+) is the decryption root, not a login credential. See the
AMENDMENT for the full two-secret model.

## Threading model

Slack-style: threads are flat metadata. A message has:
- `thread_id` (UUID, null = top-level channel message)
- `parent_id` (UUID, optional reply-target inside a thread)

Threads are not nested. The server serves `fetch_thread(channel_id,
thread_id)` as a fast indexed query. Clients reconstruct UI hierarchy.

## Containerization

Single Go binary, distroless final image (~25MB). Docker compose stacks
for dev, test, and a multi-instance production example with Caddy in front
for TLS termination and sticky WebSocket sessions.
