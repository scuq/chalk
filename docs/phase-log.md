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

## 09 — auth ✅

Phase 09 shipped in four sub-phases (a, b, c, d), each landing as
an independent applier package. The aggregate scope:

### 09a — multi-tab

**Delivered**
- Hub connection map keyed by `userID` instead of `deviceID`.
- WebSocket sessions scoped to user identity (precursor work for 09b's session cookies).
- Multiple tabs of the same user no longer evict each other.

**Tested**
- Two browser tabs (same user) both stay connected without eviction.
- Per-user fan-out: a message lands in every tab simultaneously.

### 09b — auth

**Delivered**
- WebAuthn passkey registration + authentication using `github.com/go-webauthn/webauthn`.
- 24-word BIP-39 recovery codes; recovery flow restores account on a fresh device.
- Session cookies (HttpOnly, Secure-in-prod, SameSite=Lax) replacing the dev device-id shim.
- HTTP endpoints under `/api/auth`: `config`, `register/{begin,finish}`, `authenticate/{begin,finish}`, `recovery`, `logout`, `me`.
- SPA auth flow: LoginScreen, RegisterScreen, RecoveryScreen, RecoveryLoginScreen, RegenerateScreen, gated by `AuthGate` before the chat UI mounts.
- Migrations 0011–0014: users extension (username, display_name, email, role, email_verified_at), passkeys, sessions, recovery_codes.

**Tested**
- Register passkey, log out, log back in via passkey.
- Recovery code restores account on a fresh device.
- Session expiry + refresh.
- Go integration tests against ephemeral PG; HTTP tests with `virtualwebauthn`.

### 09c — invites + profile + email-change

**Delivered**
- Invite-based registration: admin mints a token via API, recipient registers via `?invite=<token>` URL.
- ProfilePanel for viewing own identity + session.
- In-chat InvitesPanel for admins (mint / revoke / list invites).
- Email-change flow: request → verification email → click `?verify_email=<token>` → email updated.
- Migrations 0015–0018: devices_link, invites, admin_bootstrap (token table, see 09d), email_blacklist.

**Tested**
- Invite mint → registration flow end-to-end.
- Email-change request → verify → /me reflects new email.
- Invite revoke prevents redemption.

### 09d — admin moderation

**Delivered** (across four sub-steps 09d-1 / -2a / -2b / -2c)

09d-1 — **server**:
- First-run admin user creation via `CHALK_ADMIN_USERNAME` + `CHALK_ADMIN_EMAIL`; chalkd prints a one-time `?admin_bootstrap=<token>` URL to stderr.
- Admin moderation API: `GET/POST/DELETE /api/admin/users/{id}/{block,unblock,soft-delete}`, `DELETE /api/admin/users/{id}` (purge with auto-blacklist), `GET/POST/DELETE /api/admin/blacklist[/{email}]`.
- `RequireAdmin` middleware wrapping `RequireSession`.
- `Hub.CloseConnsForUser` for terminating active WS connections on block/soft-delete/purge.
- Migration 0019: `users.blocked_at` + `users.deleted_at` columns, partial indexes, `admin_delete_guard` BEFORE-UPDATE trigger preventing role changes on admins and a separate trigger refusing direct DELETE on admin rows.

09d-2a — **SPA bootstrap flow**:
- `web/src/auth/admin.ts` typed client.
- `AdminBootstrapScreen` (URL-driven first-run admin enrollment).
- `AuthGate` detects `?admin_bootstrap=<token>` and routes accordingly.

09d-2b — **moderation panel**:
- Top-level `/admin` route via browser history API (back button works, refresh stays).
- StatusBar dropdown entry visible only when `me.role === "admin"`.
- `AdminPanel` with tabs: users (search, paginate, hover-reveal action buttons, status pills) and blacklist (add form + paginated list + remove).
- `ConfirmModal` for destructive actions (soft-delete and purge); block/unblock skip the modal because they're reversible.

09d-2c — **e2e + docs**:
- Playwright spec (`test/e2e/admin.spec.ts`) covering: bootstrap ceremony via Chromium's virtual authenticator, admin panel reach, block/unblock cycle.
- CHANGELOG + this phase-log update.

**Tested**
- Server: 23 store tests + 16 HTTP tests, all green.
- SPA: `tsc --noEmit` clean under strict mode; manual browser smoke through the full bootstrap-to-moderation journey.
- e2e: `test/e2e/admin.spec.ts` exercises the user-visible flow end-to-end with a virtual authenticator; requires chalkd running + PG via `docker exec chalk-dev-pg`.

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