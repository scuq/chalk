# Phase Log

What each bootstrap phase delivers and what it tests. Kept in sync with `README.md` and `CHANGELOG.md`.

Phases 00–30 are recorded in full below, in the shape the bootstrap phases were
written in — which is a **plan** shape, and four of those entries never came
true. [phases/PHASE-00-29-FOUNDATION.md](phases/PHASE-00-29-FOUNDATION.md) is
the as-built pass over the same ground, checked against the code; where the two
disagree it wins, and the entries it corrects carry a note. From 31 on, each
phase has its own record under
`docs/phases/PHASE-<N>-<TOPIC>.md` — see the index immediately below — and the
[31 and after](#31-and-after) section is the chronological summary that ties
them together. `CHANGELOG.md` is the user-facing view of the same history.

## Phase doc index

Records for phases 30 and later. Those marked *backfilled* were written after
the fact from the commit history and the changelog, so their design notes are
as-built rather than a contemporaneous plan.

| Phase | Topic | Record |
| --- | --- | --- |
| 00–29 | foundation, the MLS detour, the encryption rebuild | [phases/PHASE-00-29-FOUNDATION.md](phases/PHASE-00-29-FOUNDATION.md) *(backfilled; corrects the plan entries below)* |
| 30 | voice and video | [PHASE-30-VOICE.md](phases/PHASE-30-VOICE.md) *(backfilled; spec in [design/](design/chalk-phase-30-voice-video-design.md))* |
| 31 | auth v2 — password + TOTP | [PHASE-31-AUTHV2.md](phases/PHASE-31-AUTHV2.md) |
| 32 | mobile layout | [PHASE-32-MOBILE.md](phases/PHASE-32-MOBILE.md) *(backfilled)* |
| 33 | unread tracking, read cursors | [PHASE-33-UNREAD.md](phases/PHASE-33-UNREAD.md) *(backfilled)* |
| 34 | presence correctness | [PHASE-34-PRESENCE.md](phases/PHASE-34-PRESENCE.md) *(backfilled)* |
| 35 | message deletion | [PHASE-35-DELETION.md](phases/PHASE-35-DELETION.md) *(backfilled)* |
| 36 | branding, installable app | [PHASE-36-PWA.md](phases/PHASE-36-PWA.md) *(backfilled)* |
| 37 | edit and react | [PHASE-37-EDITREACT.md](phases/PHASE-37-EDITREACT.md) *(backfilled)* |
| 38 | channel-key delivery | [PHASE-38-KEYDELIVERY.md](phases/PHASE-38-KEYDELIVERY.md) *(backfilled)* |
| 39 | version badge | [PHASE-39-VERSION.md](phases/PHASE-39-VERSION.md) *(backfilled)* |
| 40 | notification sounds | [PHASE-40-SOUNDS.md](phases/PHASE-40-SOUNDS.md) *(backfilled)* |
| 41 | microphone settings, row menu | [PHASE-41-MICROPHONE.md](phases/PHASE-41-MICROPHONE.md) *(backfilled)* |
| 42 | thread read state, thread inbox | [PHASE-42-THREADS.md](phases/PHASE-42-THREADS.md) *(backfilled)* |
| 43 | typing indicators | [PHASE-43-TYPING.md](phases/PHASE-43-TYPING.md) *(backfilled)* |
| 44 | global voice panel, device pickers | [PHASE-44-VOICEPANEL.md](phases/PHASE-44-VOICEPANEL.md) *(backfilled)* |
| 45 | voice scratchpad, away detection | [PHASE-45-SCRATCHPAD.md](phases/PHASE-45-SCRATCHPAD.md) *(backfilled)* |
| 46 | server-update notice | [PHASE-46-UPDATENOTICE.md](phases/PHASE-46-UPDATENOTICE.md) *(backfilled)* |
| 47 | thread filtering, tile pop-outs, colours | [PHASE-47-THREADINBOX.md](phases/PHASE-47-THREADINBOX.md) *(backfilled)* |
| 48 | browser reality (storage, IME, curves) | [PHASE-48-BROWSER.md](phases/PHASE-48-BROWSER.md) *(backfilled)* |
| 49 | thread titles, jump-to-origin | [PHASE-49-THREADTITLES.md](phases/PHASE-49-THREADTITLES.md) *(backfilled)* |
| 50 | notification rules | [PHASE-50-NOTIFYRULES.md](phases/PHASE-50-NOTIFYRULES.md) *(backfilled)* |
| 51 | CSP and security headers | [PHASE-51-CSP.md](phases/PHASE-51-CSP.md) *(backfilled)* |
| 52 | camera background effects | [PHASE-52-CAMERABG.md](phases/PHASE-52-CAMERABG.md) *(backfilled)* |
| 53 | the parking lot | [PHASE-53-PARKING.md](phases/PHASE-53-PARKING.md) *(backfilled)* |
| 54 | roster filter, channel groups | [PHASE-54-ROSTER.md](phases/PHASE-54-ROSTER.md) |
| 55 | main-feed scrollback paging | [PHASE-55-HISTORY.md](phases/PHASE-55-HISTORY.md) |
| 56 | @mention autocomplete | [PHASE-56-MENTIONS.md](phases/PHASE-56-MENTIONS.md) *(backfilled)* |
| 57 | link previews | [PHASE-57-LINKPREVIEW.md](phases/PHASE-57-LINKPREVIEW.md) |
| 58 | edit any recent message | [PHASE-58-EDITWINDOW.md](phases/PHASE-58-EDITWINDOW.md) *(backfilled)* |
| 59 | user directory, one-click add | [PHASE-59-FRIENDS.md](phases/PHASE-59-FRIENDS.md) *(backfilled)* |
| 60 | 16px control floor, pinned header | [PHASE-60-MOBILEFIT.md](phases/PHASE-60-MOBILEFIT.md) *(backfilled)* |
| 61 | message search | [PHASE-61-SEARCH.md](phases/PHASE-61-SEARCH.md) |
| 62 | zuckermode conversation list | [PHASE-62-ZUCKER.md](phases/PHASE-62-ZUCKER.md) *(backfilled)* |
| 63 | call grid, speaking dot, mic by label | [PHASE-63-CALLTILES.md](phases/PHASE-63-CALLTILES.md) *(backfilled)* |
| 64 | the back swipe | [PHASE-64-SWIPEBACK.md](phases/PHASE-64-SWIPEBACK.md) *(backfilled)* |
| 65 | web push — **planned, not started** | [PHASE-65-PUSH.md](phases/PHASE-65-PUSH.md) |
| 66 | call preferences that follow the account | [PHASE-66-CALLPREFS.md](phases/PHASE-66-CALLPREFS.md) *(backfilled)* |
| 67 | link labels | [PHASE-67-LINKLABELS.md](phases/PHASE-67-LINKLABELS.md) *(backfilled)* |
| 68 | settings tabs, cross-tab filter | [PHASE-68-SETTINGSTABS.md](phases/PHASE-68-SETTINGSTABS.md) *(backfilled)* |
| 69 | attachment refs on history, pinned header | [PHASE-69-PINNEDHEADER.md](phases/PHASE-69-PINNEDHEADER.md) *(backfilled)* |
| 70 | fonts, scrollbars, steady settings | [PHASE-70-APPEARANCE.md](phases/PHASE-70-APPEARANCE.md) *(backfilled)* |
| 71 | call sounds, chalk-stroke grain | [PHASE-71-CALLSOUNDS.md](phases/PHASE-71-CALLSOUNDS.md) *(backfilled)* |
| 72 | chalkctl backup/restore, maintenance | [PHASE-72-BACKUP.md](phases/PHASE-72-BACKUP.md) *(backfilled)* |
| 73 | chalkctl metrics | [PHASE-73-METRICS.md](phases/PHASE-73-METRICS.md) *(backfilled)* |
| 74 | code blocks | [PHASE-74-CODEBLOCKS.md](phases/PHASE-74-CODEBLOCKS.md) *(backfilled)* |
| 75 | who sent a reaction | [PHASE-75-REACTORS.md](phases/PHASE-75-REACTORS.md) *(backfilled)* |
| 76 | shortcuts to settings, landing fixes | [PHASE-76-SHORTCUTS.md](phases/PHASE-76-SHORTCUTS.md) *(backfilled)* |
| 77 | nano markdown | [PHASE-77-NANOMD.md](phases/PHASE-77-NANOMD.md) *(backfilled)* |
| 78 | hidden channels | [PHASE-78-HIDECHANNELS.md](phases/PHASE-78-HIDECHANNELS.md) *(backfilled)* |
| 79 | the landing target | [PHASE-79-LANDING.md](phases/PHASE-79-LANDING.md) *(backfilled)* |
| 80 | ephemeral voice rooms, guest links | [PHASE-80-EPHEMERAL.md](phases/PHASE-80-EPHEMERAL.md) |
| 81 | security audit and remediation | [PHASE-81-SECAUDIT.md](phases/PHASE-81-SECAUDIT.md) |
| 82 | signed channel-key wraps | [PHASE-82-SIGNEDWRAP.md](phases/PHASE-82-SIGNEDWRAP.md) |
| 83 | signed message envelope + channel-state transcript — **planned, not started** | [PHASE-83-MSGSIG.md](phases/PHASE-83-MSGSIG.md) |
| 84 | identity-pin backup | [PHASE-84-PINBACKUP.md](phases/PHASE-84-PINBACKUP.md) |
| 85 | operational logging | [PHASE-85-OPLOG.md](phases/PHASE-85-OPLOG.md) |
| 86 | ties: answering without quoting — **planned, not started** | [PHASE-86-TIES.md](phases/PHASE-86-TIES.md) |
| 87 | message reminders — **planned, not started** | [PHASE-87-REMINDERS.md](phases/PHASE-87-REMINDERS.md) |
| 88 | federation — **considered and declined** | [PHASE-88-FEDERATION.md](phases/PHASE-88-FEDERATION.md) |
| 89 | the friend-request hint | [PHASE-89-REQUESTHINT.md](phases/PHASE-89-REQUESTHINT.md) |
| 90 | a local idle agent — **planned, not started** | [PHASE-90-IDLEEXT.md](phases/PHASE-90-IDLEEXT.md) |
| 91 | resizing the message box | [PHASE-91-COMPOSERSIZE.md](phases/PHASE-91-COMPOSERSIZE.md) |
| 92 | the roster hover card | [PHASE-92-HOVERCARD.md](phases/PHASE-92-HOVERCARD.md) |
| 93 | the full-width layout | [PHASE-93-WIDTH.md](phases/PHASE-93-WIDTH.md) |

Every number above is claimed by a topic in `docs/tags.md`, so the code behind
any of them is reachable with `tools/where.sh -g <topic>`.

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

## 11c — channel encryption ✅ then removed

> **Correction.** The plan below is what was written; 11c then *shipped*, across
> 11c-1 … 11c-10 (buffered Welcomes with TTL eviction, catch-up-on-reconnect,
> member-management UI, split-brain guards, orphaned-KeyPackage sweep), and was
> removed wholesale by phase 21 along with the rest of MLS. See
> [phases/PHASE-00-29-FOUNDATION.md](phases/PHASE-00-29-FOUNDATION.md).

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

## 12 — lifecycle 🔮 (still open)

> **Correction.** Never built. No `deactivate_account` / `delete_account` /
> `reactivate_account` frames exist; phase 06's lifecycle schema is still
> read-only.

**Will deliver**
- Wire frames + handlers for `deactivate_account`, `delete_account`, `reactivate_account`
- Cascading cleanup (presence, friendships, channel memberships, MLS groups)
- Self-service UI in the SPA
- Completes the phase-06 schema with the missing write paths

**Will test**
- Deactivate hides user from friend lists, freezes presence
- Reactivate restores prior friendships
- Delete is cascading and irreversible

## 13 — blobs 🔮 (superseded)

> **Correction.** Superseded by the attachments arc (att-1 … att-4, migration
> 0037), which solved this differently: a partitioned table, chunked HTTP
> transfer off the WS, and encrypted metadata as well as encrypted blobs.

**Will deliver**
- `blobs` table, blob upload endpoint with token auth
- Client-side AES-256-GCM encryption helpers
- Attachment UI in composer
- GC for unreferenced blobs

**Will test**
- Upload 1MB blob with token, download it
- Server bytes ≠ uploaded bytes (encrypted)
- GC removes unreferenced blobs after TTL

## 14 — hardening 🔮 (partly, elsewhere)

> **Correction.** Rate limiting arrived in phase 81 (`internal/ratelimit`), and
> server metrics became `chalkctl metrics` in phase 73, reading Postgres' own
> statistics views. There is no `/metrics` endpoint and no Prometheus.

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

## 15 — cross-browser 🔮 (partly)

> **Correction.** `test/e2e/` exists with a Playwright config and five specs
> (smoke, channels, multitab, admin, mobile); the full engine × viewport matrix
> was never stood up. `docs/browser-support.md` carries the support statement.

**Will deliver**
- `test/e2e/` Playwright config
- Engine matrix: Chromium / Firefox / WebKit
- Viewport matrix: desktop / mobile-iOS / mobile-Android
- Manual real-device checklist

**Will test**
- Full e2e suite passes on all engine × viewport combinations
- HTML report uploaded as artifact

## 21 — crypto rip-out + rebuild (in progress) ✅/🔧

The MLS encryption stack (11a–11d) was removed wholesale and the codebase
returned to a clean plaintext baseline, ahead of a fresh encryption design.
History above (11a–11d) is left intact — it was accurate when written.

**Delivered (21-1 .. 21-7)**
- 21-1..21-6: removed all MLS — client `web/src/mls/`, `@wireapp/core-crypto`
  + WASM, server ws/store MLS files, the MLS wire frames, and the MLS tables
  (migrations dropped `key_packages`, `mls_groups`, `mls_commits`,
  `mls_pending_welcomes`).
- 21-7: removed the dormant encryption *concept* — the stub seam, e2ee
  badges, the channel-members panel, and the schema scaffolding. Migrations
  0027–0030 dropped `messages.content_type`, `messages.mls_epoch`, and
  `channels.is_mls`, and renamed `messages.ciphertext → messages.body`.
- Result: chalk is a plaintext group chat; the server sees message content.
  Verified end-to-end (two-user send/receive) on the live dev stack.
- Housekeeping: pruned stale 11c/11d/09/11b design docs; de-phased Go
  filenames (`*_phaseNN.go` merged into `frames.go` / `ws.go` / `hub.go`).

**Planned (22 .. 25) 🔮**
- 22: identity keys (X25519 + Ed25519 from a 24-word BIP-39 phrase, native
  WebCrypto, `identity_keys` table with a `generation` column).
- 23: space keys + real AES-256-GCM message encryption; server back to
  blind relay; rebuild the group-members UI.
- 24: picture-word verification (anti key-substitution).
- 25: weekly space-key rotation + identity-rotation governance.

(The phase-21+ crypto-rebuild plan and its amendment guided phases 22–25;
removed after the rebuild shipped. The 22–30 section below records what landed.)

---

## 22–30 — encryption rebuild, governance, attachments, multi-device (delivered) ✅

The phase 21+ plan above ("Planned 22..25") is now BUILT and live. Recorded
here so this log reflects reality.

**22–25 — identity-wrapped space-key encryption (live).**
- 22: identity keys — X25519 + Ed25519 from a 24-word BIP-39 phrase, native
  WebCrypto, `identity_keys` table (one active per user), self-signature.
- 23: space keys + AES-256-GCM message encryption; server back to blind relay;
  crypto-agility wrap/message suites (`web/src/crypto/spacekey.ts`); group-
  members UI rebuilt. chalk is end-to-end encrypted from here on.
- 24: picture-word (safety-number) verification — anti key-substitution.
- 25: space-key rotation (creator-minted, monotonic versions) + membership
  lifecycle: add / remove (rotate-on-removal, wrap-scrub) / leave / re-add,
  all forward-only.

**Governance (gov-1a .. gov-2-2) — live.** Per-channel `governance_mode`
(dictator | democratic) with a generic proposal→vote→resolve→action engine.
Proposal types: remove_member, add_member, delete_message, set_mode. Hardened
tally (frozen eligibility snapshot, turnout quorum + majority-of-voters,
target exclusion, set_mode→dictator supermajority reverting to the original
creator, re-propose cooldown, mandatory expiry, resolve-on-certainty).
Client governance panel: mode toggle, propose, live tally, vote, cancel.

**Attachments (att-1 .. att-4) — live.** Partitioned `attachments` table,
chunked HTTP upload/download (the 1 MiB WS frame limit forces it off the WS),
encrypted blobs + encrypted metadata (server sees only sizes), client-side
downscaled encrypted previews (preview-first, full-on-scroll), ciphertext
IndexedDB cache (LRU, clear-on-logout). Giphy via URL-reference with per-user
tri-state opt-in consent + host allowlist + server-proxied search.

**Multi-device (md-1 .. md-7) — live.** Shared identity key: a second device
re-enters the 24-word phrase, derives the same identity, and verifies the
derived key matches the published one before persisting (no divergent-identity
fork). Self-echo to a user's other devices; passkey enrollment after recovery
login; passkey deletion with a last-passkey guard. No per-device revocation
(remedy is identity rotation).

**Admin moderation (09d) — live.** Block / unblock / soft-delete / purge users,
email blacklist CRUD, admin-protection triggers (migration 0019), SPA admin
panel.

**Voice/video (Phase 30, slices 30-1 .. 30-8) — live.** Discord-style voice
channels: full WebRTC mesh between clients with coturn as the mandatory media
relay (short-lived HMAC creds minted per join), E2E-encrypted signaling under
the channel space key with Ed25519-signed DTLS fingerprints (anti-MITM: a bad
signature aborts the peer, never degrades). Client: sidebar occupancy with
mute/cam/screen badges (❯ text / ▶ voice glyphs), big-tile + filmstrip stage,
call duration, in-UI diagnostics drawer (event ring + getStats + copy report).
Polish: removed-member voice eviction cascade, WS-loss teardown (v1: rejoin by
click), post-join state sync, getUserMedia error UX, `voice_enabled` welcome
flag gating the client. Screen/game share (30-7, Addendum B): separate
transceivers (camera + screen simultaneous) under perfect negotiation, a
three-way motion/detail/text Prioritize toggle (W3C contentHint + mode-keyed
degradationPreference), mode-dependent codec ladder via setCodecPreferences
(AV1 CPU-gated for detail/text), shared program audio, per-viewer screen
hide, mid-call camera add. Adaptive quality (30-8, Addendum D): pre-stream
uplink probe (`POST /api/netprobe`) picks the starting tier; passive getStats
re-checks on `CHALK_VOICE_RECHECK_SECS` (never active tests mid-call); a mesh
budget divider (headroom → per-peer audio reserve → per-copy caps, screen
prioritized over camera thumbnails) feeds a per-mode tier ladder with
hysteresis (fast down, slow single-rung up), applied via sender.setParameters
without renegotiation; game bottom rung pauses + warns. Gated behind
`CHALK_VOICE_ENABLED`; see
`docs/design/chalk-phase-30-voice-video-design.md` and `docs/deployment.md`.

**Designed, not yet built:** future SFU seam (Slice I) for large voice rooms.
Deferred-small: governance `set_config` proposal type.

---

## 31 and after

From phase 31 the log stops being a bootstrap checklist: phases are numbered
slices of feature work, each with its own record in the index above. What
follows is the chronological summary — what the arc was for and which release
carried it. The per-phase docs hold the design and the slice lists.

**31 — auth v2 (v0.3.15 – v0.3.19).** Password (≥20 chars, Argon2id, never
leaving the browser) + mandatory TOTP on every path including passkeys; two
separate 24-word phrases (recovery vs encryption); hard cutover behind
`CHALK_AUTH_V2_REQUIRED` with a migration wizard; one-shot admin bootstrap
token; recovery as *reset*, not login. Recorded in `docs/phases/PHASE-31-AUTHV2.md`,
which consolidates the seven-file spec that preceded it.

**32–36 — the app becomes usable outside a desktop tab (v0.3.20 – v0.3.29).**
Mobile layout (32), unread tracking with cross-device read cursors and
client-side mention detection (33), presence counted by connection rather than
device (34), message deletion routed through governance (35), logo, icons and
PWA install (36).

**37–39 — message surface and self-identification (v0.3.27 – v0.3.29).** Edit
(author-only, 15 minutes, no override) and encrypted per-user reactions (37),
key delivery on channel add without a reload (38), the version badge linking the
running build's changelog, plus three themes (39).

**40–41 — sound and voice controls (v0.3.40 – v0.3.42).** The synthesised
chalk-stroke sound pack with its suppression, rate and gesture gates (40);
microphone capture graph, device picker, transmit modes and voice keys, and the
pointer-anchored message row menu (41).

**42–45 — threads, typing, and the always-there voice panel (v0.3.45 –
v0.4.3).** Durable cross-device thread read state and the active-threads inbox
(42), throttled reciprocal-opt-out typing indicators (43), the global voice
panel with account-synced mic settings, dB VAD meter and camera/output pickers
(44), the purge-on-empty voice scratchpad, activity-based away detection, and
unread dots that mean something (45).

**46–49 — knowing what you are looking at (v0.3.47 – v0.3.54).** Server-update
reload pill and labelled restarts (46), thread filtering that searches inside
threads, multi-window tile pop-outs and theme-independent status colours (47),
browser reality — blocked storage, insecure contexts, IME composition, WebCrypto
curve probing, lost drafts (48), client-derived thread titles and jump-to-origin
(49).

**50–53 — rules, policy and privacy (v0.4.0 – v0.4.4).** Priority-driven
notification rules synced under an identity-derived key, with banners, tab blink
and an unread badge (50); CSP and security headers on every served page (51);
on-device camera background blur that degrades loudly (52); the parking lot, and
chalk starting in it (53).

**54–61 — finding things (v0.4.5 – v0.5.0).** Roster filter and channel groups
(54), scrollback that reaches all the way back (55), @mention autocomplete (56),
sender-built SSRF-guarded link previews embedded in the E2E payload (57), edit
from the row menu on any recent message (58), the server user directory (59),
the 16px control floor and pinned room header (60), on-device message search
with a full-history crawl (61).

**62–71 — the phone as a first-class client, and call polish (v0.5.0 –
v0.5.8).** Zuckermode conversation list backed by a channel-activity index and
ciphertext previews (62), equal-tile call grid, speaking dot and mic resolution
by label (63), the back swipe that follows your finger (64), account-following
call preferences with client-sealed per-peer audio (66), link labels (67),
settings tabs with a cross-tab filter (68), attachment refs on history pages and
the desktop pinned header (69), four bundled fonts, themed scrollbars and steady
settings frames (70), call sounds and the stick-slip chalk grain (71).

**72–79 — operations and reading comfort (v0.5.9 – v0.6.4).** chalkctl
backup/restore with the TOTP key and a served maintenance page (72), metrics
from Postgres' own statistics views (73), code blocks as a first-class message
kind (74), reactor lists (75), shortcuts moved into settings (76),
receive-side-only nano markdown (77), hidden channels that never suppress
notifications (78), and the landing target settled once so late-decrypting
images cannot drag the reader (79).

**80–85 — guests, and taking the crypto seriously (v0.7.0 – v0.7.1).**
Ephemeral voice rooms with guest magic links, a `chalk_guest` RLS fence and
expiry-driven purge (80); the security audit and its remediation — session
revocation on credential change, step-up auth, per-IP anonymous rate limits,
trusted-proxy handling, dependency bumps (81); Ed25519-signed channel-key wraps
with TOFU identity pinning, a self-healing re-sign sweep and `chalkctl wrapsig`
(82); identity-pin backup sealed under the identity key (84); operational
logging — security events, opt-in connection snapshot, slow requests, Caddy
access log (85).

**Not started.** 65 (web push), 83 (signed message envelope plus authenticated
channel-state transcript), 86 (ties), 87 (message reminders) and 90 (a local
idle agent) — each planned in its own `PHASE-*.md`, and each marked
*planned, not started* in the index above. CLAUDE.md's *Current state / open
items* is the authority on what is open; this log only records what shipped.

## Phase numbering note

The 09+ ordering above differs from the original bootstrap scaffold's
stub names. `phases/PHASE-00-29-FOUNDATION.md` decodes the old scheme
slot by slot; `CHANGELOG.md` has the same mapping for readers. Short
version: 09 stayed as auth
(shipped as 09a–d); "10 MLS" was folded into the 11-series (11a
foundation, 11b DMs, 11c channels, 11d multi-device); subsequent
phases shifted up by one slot.
