# Phase Log

What each bootstrap phase delivers and what it tests. Kept in sync with `bootstrap/` and `README.md`.

## 00 — init ✅

**Delivers**
- Repo scaffolding (top-level files, directory tree)
- Bootstrap library (`lib/common.sh`, `lib/checks.sh`, `lib/postgres.sh`, `lib/testing.sh`, `lib/browsers.sh`)
- Test fixtures (`fixtures/users.sql`, `fixtures/seed.sh`)
- Phase orchestrator (`run-all.sh`)

**Tests**
- Host environment (Go ≥1.23, Docker, git, bash 5+)
- All expected directories and files present
- Shellcheck passes (if installed)

## 01 — go-skeleton ✅

**Delivers**
- `cmd/chalkd/main.go` — entry, graceful shutdown, `/healthz`, `/version`
- `internal/version` — build-time version
- `internal/config` — env + flag loading, validation

**Tests**
- `go vet ./...`
- `go test ./internal/config/...` — defaults, env overrides, flags, validation
- `go build` — release flags, CGO disabled
- Binary smoke test: `chalkd --version`

## 02 — container ✅

**Delivers**
- `docker/Dockerfile` — multi-stage, distroless final
- `docker/Dockerfile.dev` — alpine + tini for debugging
- `docker/docker-compose.yml` — dev stack
- `docker/docker-compose.test.yml` — ephemeral CI stack
- `docker/docker-compose.prod.yml` — multi-instance + Caddy

**Tests**
- `docker build` succeeds
- `docker run chalk:dev --version` prints expected banner
- Container starts and `/healthz` returns 200 over HTTP
- Image size < 30MB target (warning, not failure)

## 03 — postgres ✅

**Delivers**
- pgx connection pool (`internal/store`)
- Embedded migrations runner (`internal/migrate`)
- Initial schema: `0001_init.sql` (users, devices), `0002_channels.sql`, `0003_messages.sql`
- Store interfaces for users (`CreateUser`, `UpsertUser`, `GetUserByID`, `GetUserByHandle`, `CountUsers`), devices, channels, messages

**Tests**
- Ephemeral PG, migrations apply + are idempotent
- Seed alice/bob/carol via `fixtures/users.sql`, query them back
- Concurrent insert race tests

## 04 — ws-relay ✅

**Delivers**
- `internal/server/ws.go` — WebSocket handler with coder/websocket
- `internal/server/hub.go` — local connection registry keyed by deviceID
- Ping/pong with configurable timing
- Wire protocol v0: `hello` / `welcome` / `send` / `message`
- Plaintext payload (placeholder for MLS in phase 10)

**Tests**
- Two clients connect, A sends, B receives
- Ping/pong keeps connection alive
- Hub eviction on duplicate deviceID

## 05 — pubsub ✅

**Delivers**
- `internal/pubsub` — NOTIFY publisher + dedicated LISTEN connection
- `chalk_global` channel for cross-instance routing
- Hub integration: incoming NOTIFY → fan out to local sockets

**Tests**
- Two chalkd instances on different ports, message from A reaches B
- Postgres restart → listener reconnects cleanly
- Drain semantics for hijacked connection

## 06 — presence ✅

**Delivers**
- `migrations/0006_user_lifecycle.sql` — user account states
- `migrations/0007_friendships.sql` — friend requests + acceptance
- `migrations/0008_presence.sql` — `device_presence` with TTL
- `internal/presence` — multi-device aggregate (`active`/`away`/`offline`), heartbeats, janitor
- `internal/friends` — friend store with bucketed queries
- Frames: `friend_request`, `friend_accept`, `friend_list`, presence broadcasts

**Tests**
- Friend lifecycle (request → accept → list)
- Presence TTL decay and janitor cleanup
- Cross-instance presence propagation

Note: phase 06 ships the user-lifecycle schema but defers the write paths (deactivate/delete/reactivate) to phase 11. Phase 06's lifecycle is read-only state.

## 07 — frontend-shell ✅

**Delivers**
- `web/` SPA (Preact + TypeScript, esbuild)
- Matrix-green-on-black theme via CSS variables
- Hack font (4 weights, WOFF2)
- StatusBar with connection state, Composer with optimistic-append
- `tools/dev.sh` and `make dev` for the full local stack
- `embed.go` serves the built SPA from the chalkd binary

**Tests**
- Binary serves SPA from `embed.FS`
- Playwright smoke: page loads, connects to chalkd, status indicator goes green

## 08 — channels ✅

**Delivers**
- `migrations/0009_messages_nullable_sender.sql`
- `migrations/0010_channel_members.sql`
- Per-channel pubsub topics (`chalk_chan_<id>`) with dynamic LISTEN refcounting
- DM cardinality trigger (max 2 members for `is_dm=true`)
- Frames: `create_channel`, `create_channel_ack`, `list_channels`, `list_channels_ack`, `fetch_history`, `fetch_history_ack`, `channel_event`
- Echo-suppression: sender device never gets its own message back
- `internal/server/ws_phase08.go` — channel handlers
- `internal/proto/frames_phase08.go` — wire frame definitions

**Tests**
- alice creates DM with bob, both receive `channel_event{added}`
- Cross-instance fan-out via per-channel topics
- DM cardinality trigger refuses 3rd member
- `fetch_history` pagination with `before_seq` cursor

### 08b — channels SPA ✅

**Delivers**
- Sidebar with channel list and "+" button
- `CreateChannelModal` with `FriendPicker` (bucketed friend_list)
- `subscribe_channel` wire frame for SPA-driven topic subscriptions
- Reducer state for channels, friends, messages keyed by channelID
- Optimistic-append for own messages (echo-suppressed by server)
- Integration test `test/e2e/channels.spec.ts`

**Tests**
- Create DM from picker, verify both ends receive `channel_event`
- Send + receive via per-channel topic
- Reload page → channels restored, history fetched

### 08c — handles ✅

**Delivers**
- `internal/store/users.go::HandlesByID` batched lookup
- `WelcomePayload.handle` — status badge shows `you (alice)`
- `ChannelSummary.members []ChannelMember{user_id, handle}` — DM labels show `@bob`
- Friend picker renders `@<handle>` with UUID fallback

**Tests**
- Browser smoke: status badge, sidebar DM, channel header, friend picker all render handles

## Planned phases (subject to change)

The numbering and scope below reflect the current plan. The bootstrap scaffold still has older stubs at `bootstrap/phase-09-blobs.sh` etc. — those will be renamed/rewritten as each phase actually starts.

## 09 — auth 🔮

**Will deliver**
- WebAuthn passkey registration and authentication
- 24-word recovery codes (BIP-39 wordlist)
- Replace the phase-05 device-ensure shim with real account creation
- User handles bound to passkey-derived account
- Multi-conn-per-user (rewrites the hub's deviceID-keyed map to userID-keyed)

**Will test**
- Register passkey, log out, log back in via passkey
- Recovery code restores account on a fresh device
- Two browser tabs (same user) both stay connected without eviction

## 10 — mls 🔮

**Will deliver**
- CoreCrypto WASM in `web/vendor/`
- Web Worker harness for crypto
- KeyPackage publish/fetch with `FOR UPDATE SKIP LOCKED`
- MLS group creation, Add, Remove, Welcome flows
- Wire ciphertext only; server never sees plaintext

**Will test**
- alice + bob + carol form an MLS group
- Server logs verified to contain only ciphertext
- Member add/remove works
- KeyPackage refill triggered when low

## 11 — lifecycle 🔮

**Will deliver**
- Wire frames + handlers for `deactivate_account`, `delete_account`, `reactivate_account`
- Cascading cleanup (presence, friendships, channel memberships)
- Self-service UI in the SPA
- Completes the phase-06 schema with the missing write paths

**Will test**
- Deactivate hides user from friend lists, freezes presence
- Reactivate restores prior friendships
- Delete is cascading and irreversible

## 12 — blobs 🔮

**Will deliver**
- `blobs` table, blob upload endpoint with token auth
- Client-side AES-256-GCM encryption helpers
- Attachment UI in composer
- GC for unreferenced blobs

**Will test**
- Upload 1MB blob with token, download it
- Server bytes ≠ uploaded bytes (encrypted)
- GC removes unreferenced blobs after TTL

## 13 — hardening 🔮

**Will deliver**
- Per-connection rate limit (`golang.org/x/time/rate`)
- Payload size caps
- Blob quota per user
- Structured JSON logging tightening
- Prometheus `/metrics` endpoint
- `chalkd --migrate-only` flag

**Will test**
- Flood test → rate limiter triggers expected 429s
- Oversized payload rejected
- `/metrics` exposes request counts and ws connections

## 14 — cross-browser 🔮

**Will deliver**
- `test/e2e/` Playwright config
- Engine matrix: Chromium / Firefox / WebKit
- Viewport matrix: desktop / mobile-iOS / mobile-Android
- Manual real-device checklist

**Will test**
- Full e2e suite passes on all engine × viewport combinations
- HTML report uploaded as artifact