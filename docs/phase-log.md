# Phase Log

What each bootstrap phase delivers and what it tests. Kept in sync with `bootstrap/`, `README.md`, and `CHANGELOG.md`.

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
- Plaintext payload (placeholder for MLS in phase 11a/11b)

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

Note: phase 06 ships the user-lifecycle schema but defers the write paths (deactivate/delete/reactivate) to phase 12. Phase 06's lifecycle is read-only state.

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

## 09 — auth ✅

Phase 09 shipped in four sub-phases (a, b, c, d), each landing as
an independent applier package.

### 09a — multi-tab ✅

**Delivered**
- Hub connection map keyed by `userID` instead of `deviceID`
- WebSocket sessions scoped to user identity (precursor for 09b's session cookies)
- Multiple tabs of the same user no longer evict each other

**Tested**
- Two browser tabs (same user) both stay connected without eviction
- Per-user fan-out: a message lands in every tab simultaneously

### 09b — auth ✅

**Delivered**
- WebAuthn passkey registration + authentication using `github.com/go-webauthn/webauthn`
- 24-word BIP-39 recovery codes; recovery flow restores account on a fresh device
- Session cookies (HttpOnly, Secure-in-prod, SameSite=Lax) replacing the dev device-id shim
- HTTP endpoints under `/api/auth`: `config`, `register/{begin,finish}`, `authenticate/{begin,finish}`, `recovery`, `logout`, `me`
- SPA auth flow: LoginScreen, RegisterScreen, RecoveryScreen, RecoveryLoginScreen, RegenerateScreen, gated by `AuthGate` before the chat UI mounts
- Migrations 0011–0014: users extension (username, display_name, email, role, email_verified_at), passkeys, sessions, recovery_codes

**Tested**
- Register passkey, log out, log back in via passkey
- Recovery code restores account on a fresh device
- Session expiry + refresh
- Go integration tests against ephemeral PG; HTTP tests with `virtualwebauthn`

### 09c — invites + profile + email-change ✅

**Delivered**
- Invite-based registration: admin mints a token via API, recipient registers via `?invite=<token>` URL
- ProfilePanel for viewing own identity + session
- In-chat InvitesPanel for admins (mint / revoke / list invites)
- Email-change flow: request → verification email → click `?verify_email=<token>` → email updated
- Migrations 0015–0018: devices_link, invites, admin_bootstrap, email_blacklist

**Tested**
- Invite mint → registration flow end-to-end
- Email-change request → verify → /me reflects new email
- Invite revoke prevents redemption

### 09d — admin moderation ✅

**Delivered** (across four sub-steps 09d-1 / -2a / -2b / -2c)

09d-1 — **server**:
- First-run admin user creation via `CHALK_ADMIN_USERNAME` + `CHALK_ADMIN_EMAIL`; chalkd prints a one-time `?admin_bootstrap=<token>` URL to stderr
- Admin moderation API: `GET/POST/DELETE /api/admin/users/{id}/{block,unblock,soft-delete}`, `DELETE /api/admin/users/{id}` (purge with auto-blacklist), `GET/POST/DELETE /api/admin/blacklist[/{email}]`
- `RequireAdmin` middleware wrapping `RequireSession`
- `Hub.CloseConnsForUser` for terminating active WS connections on block/soft-delete/purge
- Migration 0019: `users.blocked_at` + `users.deleted_at` columns, partial indexes, `admin_delete_guard` BEFORE-UPDATE trigger preventing role changes on admins and a separate trigger refusing direct DELETE on admin rows

09d-2a — **SPA bootstrap flow**:
- `web/src/auth/admin.ts` typed client
- `AdminBootstrapScreen` (URL-driven first-run admin enrollment)
- `AuthGate` detects `?admin_bootstrap=<token>` and routes accordingly

09d-2b — **moderation panel**:
- Top-level `/admin` route via browser history API (back button works, refresh stays)
- StatusBar dropdown entry visible only when `me.role === "admin"`
- `AdminPanel` with tabs: users (search, paginate, hover-reveal action buttons, status pills) and blacklist (add form + paginated list + remove)
- `ConfirmModal` for destructive actions (soft-delete and purge); block/unblock skip the modal because they're reversible

09d-2c — **e2e + docs**:
- Playwright spec (`test/e2e/admin.spec.ts`) covering: bootstrap ceremony via Chromium's virtual authenticator, admin panel reach, block/unblock cycle
- CHANGELOG + this phase-log update

**Tested**
- Server: 23 store tests + 16 HTTP tests, all green
- SPA: `tsc --noEmit` clean under strict mode; manual browser smoke through the full bootstrap-to-moderation journey
- e2e: `test/e2e/admin.spec.ts` exercises the user-visible flow end-to-end with a virtual authenticator; requires chalkd running + PG via `docker exec chalk-dev-pg`

## 11a — CoreCrypto foundation + relicense ✅

**Delivered**
- `@wireapp/core-crypto` WASM pinned to an exact version in `web/package.json` (no `^`, no `~`); see `docs/updating-core-crypto.md` for the upgrade procedure
- Web Worker harness in `web/src/mls/` for crypto operations
- KeyPackage publish/fetch via new wire frames: `publish_keypkgs` (C→S) and `fetch_key_packages` (C→S)
- Server-side KeyPackage consumption with `FOR UPDATE SKIP LOCKED` semantics during MLS Add operations
- Migration 0020: `key_packages` table (`id` UUID, `user_id` REFERENCES users, `device_id` REFERENCES devices, `keypackage_bytes` BYTEA, `used_at` TIMESTAMPTZ NULL, `created_at`)
- Migration 0021: index on `(user_id, used_at) WHERE used_at IS NULL` for fast unused-KP lookups
- KeyPackage refill threshold: stock 10 KPs per device; refill triggered when 3 consumed (server pushes `keypkg_low` when threshold crossed)
- Defensive `any`-typed probe of CoreCrypto's constructor shape in `web/src/mls/loader.ts` to surface upstream renames as runtime errors with clear messages rather than silent build breaks
- License changed from MIT to GPL-3.0-or-later to align with `@wireapp/core-crypto`. Past commits remain MIT (their original terms); 11a-onward releases are GPL-3.0-or-later

**Tested**
- Browser smoke: passkey-login user generates 10 KeyPackages, publishes via `publish_keypkgs`, server stores all 10
- `fetch_key_packages` returns one unused KP, marks it consumed
- Concurrent fetch races on the same user's KPs: each returns a distinct unused KP (no double-consumption)
- DevTools console shows `[chalk] MLS KP stock: { before: N, after: M, published: K }` on refill events
- DB query `SELECT count(*) FROM key_packages WHERE used_at IS NULL` reflects consumption correctly

## 11b — MLS DM encryption ✅

Phase 11b shipped in three sub-phases (11b-1, 11b-2, 11b-3) with
several hotfixes during stabilization.

### 11b-1 — DM hard-cutover scaffolding ✅

**Delivered**
- `is_mls` boolean on `channels` (migration 0023): new DMs created from 11b onward are MLS; existing DMs stay plaintext for their channel lifetime
- Channel header lock icon for `is_mls=true` DMs
- "Peer hasn't logged in recently" surface when zero unused KeyPackages exist for the target user (no silent plaintext fallback)

**Tested**
- Pre-existing plaintext DMs remain readable and accept new plaintext messages
- New DMs created post-11b show the lock icon
- DM creation against a peer with zero unused KPs surfaces the clear error

### 11b-2 — MLS DM encryption, send side ✅

**Delivered**
- Migration 0022: `mls_groups` table (`channel_id` PK REFERENCES channels, `mls_group_id` BYTEA, `current_epoch` BIGINT, `created_at`)
- `content_type` enum extended with `mls_ciphertext` alongside existing `application`
- New wire frame `mls_commit_bundle` (C→S) carrying Commit + Welcome bytes from CoreCrypto
- Server stores the Commit for late-joining devices; fans the Welcome out to the addressee's connected devices as `mls_welcome` push frames
- Client-side encryption integrated into the Composer send path: when `is_mls=true`, body is encrypted via CoreCrypto and the wire frame carries `content_type: "mls_ciphertext"` with the base64 ciphertext
- Server `handleSend` updated to skip plaintext sanity-checks when `content_type == "mls_ciphertext"` and pass raw bytes through to fan-out
- LATERAL preview join in `ListMessagesByChannel` returns empty `last_reply_body` for rows where `content_type == "mls_ciphertext"`

**Tested**
- alice2 creates a DM with bob2 → DM channel has `is_mls=true` server-side
- alice2 sends "hello" → server receives `mls_commit_bundle` then `send{content_type: mls_ciphertext}` → row in `messages` shows opaque bytes (~190B for "hello" payload)
- Server-side `SELECT content_type, ciphertext FROM messages WHERE channel_id = '...'` shows `mls_ciphertext` and the bytes are NOT a UTF-8 plaintext

### 11b-3 — MLS DM encryption, receive side + hotfixes ✅

**Delivered**
- Client-side `processWelcome` handling for incoming `mls_welcome` push frames: the addressee processes the welcome to join the MLS group, then sends `mls_welcome_ack` so the server knows delivery succeeded
- Incoming frame intake updated to detect `content_type === "mls_ciphertext"` and call `decryptForGroup` before dispatching to the reducer; the reducer never sees ciphertext
- Failed decryption surfaces a "[unable to decrypt]" placeholder rather than crashing
- Reload-resilience: MLS group state persists in IndexedDB via CoreCrypto's own storage; bob2 reloading still decrypts history

**Six hotfixes during stabilization** (small, listed for the historical record):
1. `provideTransport(ds)` must be called BEFORE `mlsInit` (which takes only `clientId`/`ciphersuites`/`nbKP`, no transport arg)
2. `sendCommitBundle` returns the string `"success"`, not `{variant: "Success"}` — clients had to accept both
3. The commit's `encryptedMessage` field carries ~978B carrying the in-band history-secret payload as an encrypted MLS app message; verified for storage/forwarding semantics
4. EpochObserver and HistoryObserver ordering: epoch observer's `epochChanged` fires before history observer's `historyClientCreated` for the same epoch advance, validated empirically
5. ClientId byte-copy timing: `historySecret.clientId.copyBytes()` and `new Uint8Array(historySecret.data)` must happen synchronously before any `await` because CoreCrypto may free the underlying WASM memory after the observer returns
6. `prepareForTransport` callback: must return some bytes even when chalk wants to use only the out-of-band delivery path; returning dummy 32 random bytes (chosen for phase 11d's security model; see design doc #1 §8.2) is sufficient

**Tested**
- alice2 → bob2 single-message round trip end-to-end (alice2 encrypts, server stores `mls_ciphertext`, bob2 receives `mls_welcome` then `message`, decrypts to "hello")
- alice2 reload → can still decrypt own history
- bob2 reload → can still decrypt alice2's messages
- Server-side: DB row inspection confirms only opaque bytes are stored; no plaintext leak

### What 11b does NOT include
- Multi-member channel encryption — phase 11c
- Multi-device per user — phase 11d (extensively designed; not yet implemented)
- Forward secrecy via periodic key rotation — phase 11e or later

## 11c — channel encryption 🔮

**Planned**
- Extend MLS from DMs to multi-member channels
- Member add/remove via MLS Commits with Welcome to the new joiner
- KeyPackage refill batching as group size grows

## 11d — multi-device + history transfer 📐

**Designed, not yet implemented.** Full design specified across seven
documents in `docs/design/`:

- `phase-11d-doc1-threat-model.md` — threat model, crypto primitives, 10 security considerations
- `phase-11d-doc2-wire-protocol.md` — 32+ new wire frames (envelope, history secrets, pairing, multi-device, status, critical events)
- `phase-11d-doc3-serialization.md` — HistorySecret encrypted payload format, export/import procedures
- `phase-11d-doc4-server-schema.md` — `backup_envelopes`, `history_secrets`, `critical_events` tables, handler layout
- `phase-11d-doc5-client-state-machines.md` — nine client flows (setup, upload, restore, pairing, rotation, events, removal, cancellation, self-add)
- `phase-11d-doc6-pairing.md` — online QR-based pairing with ECDH(X25519) + HKDF + OOB authentication
- `phase-11d-doc7-migration-and-test-plan.md` — landing sequence (7 lands, ~14 PRs), verification matrix (18 assumptions), known v1 limitations

**Will deliver**
- Envelope-wrapped `backup_master_key` stored at chalkd
- Per-conversation per-era HistorySecrets enabling new-device history restore
- Online pairing flow (QR code, 128-bit OOB secret)
- Recovery-phrase-based restore flow
- Critical event lifecycle with cross-device synchronized acknowledgment
- Device add/remove via MLS Commits

**Will test** (per design doc #7 §4)
- ~270 unit tests across the 7 lands
- 20 integration scenarios (IT1–IT20)
- 6 end-to-end scenarios

## 12 — lifecycle 🔮

**Will deliver**
- Wire frames + handlers for `deactivate_account`, `delete_account`, `reactivate_account`
- Cascading cleanup (presence, friendships, channel memberships, MLS groups)
- Self-service UI in the SPA
- Completes the phase-06 schema with the missing write paths

**Will test**
- Deactivate hides user from friend lists, freezes presence
- Reactivate restores prior friendships
- Delete is cascading and irreversible

## 13 — blobs 🔮

**Will deliver**
- `blobs` table, blob upload endpoint with token auth
- Client-side AES-256-GCM encryption helpers
- Attachment UI in composer
- GC for unreferenced blobs

**Will test**
- Upload 1MB blob with token, download it
- Server bytes ≠ uploaded bytes (encrypted)
- GC removes unreferenced blobs after TTL

## 14 — hardening 🔮

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

## 15 — cross-browser 🔮

**Will deliver**
- `test/e2e/` Playwright config
- Engine matrix: Chromium / Firefox / WebKit
- Viewport matrix: desktop / mobile-iOS / mobile-Android
- Manual real-device checklist

**Will test**
- Full e2e suite passes on all engine × viewport combinations
- HTML report uploaded as artifact

---

## Phase numbering note

The 09+ ordering above differs from the original `bootstrap/`
scaffold's stub names. See `CHANGELOG.md` "Phase numbering note"
section for the canonical mapping. Short version: 09 stayed as auth
(shipped as 09a–d); "10 MLS" was folded into the 11-series (11a
foundation, 11b DMs, 11c channels, 11d multi-device); subsequent
phases shifted up by one slot.
