# Changelog

All notable changes to chalk are documented here.

## [Unreleased]

### Planned
- Phase 11d (multi-device + history transfer for MLS-encrypted DMs):
  envelope-wrapped `backup_master_key`, per-conversation per-era
  HistorySecret storage, recovery-phrase and pairing-based restore,
  cross-device synchronized critical events. Design specified in
  `docs/design/phase-11d-doc{1..7}.md`; implementation pending.

### Added
- Phase 11b-3 (MLS DM encryption — receive side and hotfixes): alice2
  and bob2 can exchange end-to-end MLS-encrypted DMs over chalkd.
  `messages.ciphertext` stores opaque MLS ciphertext bytes
  (~190B/msg); server never sees plaintext. Receive path: `mls_welcome`
  push frames are processed client-side to join MLS groups;
  `mls_ciphertext` content type bypasses the LATERAL preview join in
  `ListMessagesByChannel` so the server-side last-reply preview
  stays empty for encrypted DMs. Six hotfixes during stabilization
  (provideTransport ordering, sendCommitBundle return-shape, commit
  encryptedMessage carrying ~978B in-band data, observer timing).
  Multi-device deferred to phase 11d.
- Phase 11b-2 (MLS DM encryption — send side): client-side encryption
  on send path via `@wireapp/core-crypto`; `mls_commit_bundle` wire
  frame carries Commit + Welcome up to chalkd, which stores the
  Commit for late-joining devices and fans the Welcome out to the
  addressee's connected devices. New `content_type` enum value
  `mls_ciphertext` alongside the existing `application` (plaintext).
  Migration 0022 adds `mls_groups` table (`channel_id` PK,
  `mls_group_id` BYTEA, `current_epoch`); migration 0023 adds
  `channels.is_mls` boolean. KeyPackage consumption decrements
  `key_packages.used_at` via `FOR UPDATE SKIP LOCKED` during MLS Add.
- Phase 11b-1 (DM hard-cutover scaffolding): channel header lock
  icon for `is_mls=true` DMs; "peer hasn't logged in recently"
  surface when zero unused KeyPackages exist for the target user; no
  silent plaintext fallback for new DMs. Pre-existing plaintext DMs
  stay plaintext for their channel lifetime.
- Phase 11a (CoreCrypto foundation + relicense): `@wireapp/core-crypto`
  WASM in `web/vendor/`; Web Worker harness for crypto operations.
  KeyPackage publish/fetch (`publish_keypkgs` / `fetch_key_packages`
  wire frames) with server-side `FOR UPDATE SKIP LOCKED` consumption
  semantics. Migration 0020 adds `key_packages` table; migration
  0021 adds index for unused-KP lookups. KeyPackage refill threshold:
  10 KPs stocked, refill triggered when 3 consumed. Defensive
  `any`-typed probe of CoreCrypto's constructor shape in
  `web/src/mls/loader.ts` so common upstream renames surface a clear
  error rather than a build failure.

### Changed
- **License**: relicensed chalk from MIT to GPL-3.0-or-later. The sole
  copyright holder (scuq) is the only contributor of substantive code
  through this date; relicense was performed to align with the
  GPL-3.0 license of `@wireapp/core-crypto`, the MLS library
  introduced in phase 11a. See LICENSE for the full text. Past
  commits remain available under MIT (their original terms); all
  releases from phase 11a onward are GPL-3.0-or-later.
- **Phase numbering**: aligned README, phase-log, and bootstrap on
  the post-09 numbering scheme. Sub-phases (11a, 11b-1, 11b-2,
  11b-3, 11d) are now first-class entries rather than collapsed
  under a parent number. See "Phase numbering note" below.

### Added (Phase 09 series)
- Phase 09d (admin moderation): admin user bootstrapped at chalkd
  startup via `CHALK_ADMIN_USERNAME` + `CHALK_ADMIN_EMAIL`; one-time
  `?admin_bootstrap=<token>` URL printed to stderr for first-run
  passkey enrollment. Once enrolled, admin reaches `/admin` panel
  via StatusBar menu with two tabs: **users** (paginated, searchable
  list with hover-reveal block / unblock / soft-delete / purge
  buttons; status pills for active/blocked/deleted/admin) and
  **blacklist** (add/list/remove blacklisted emails). Purge
  auto-blacklists the user's email with reason `purged_user`. Block
  + soft-delete kick all active WebSocket sessions for the affected
  user via `Hub.CloseConnsForUser`. Migration 0019 adds `blocked_at`
  + `deleted_at` columns plus the `admin_delete_guard` trigger.
- Phase 09c (invites + profile + email-change verification):
  invite-based registration with `?invite=<token>` URLs,
  ProfilePanel, in-chat InvitesPanel for the admin to mint and
  revoke invites, email-change with `?verify_email=<token>`
  verification.
- Phase 09b (auth): WebAuthn passkey registration and authentication
  with `go-webauthn`, 24-word BIP-39 recovery codes, session
  cookies, login/logout, `/api/auth/{config,register/begin,register/finish,authenticate/begin,authenticate/finish,recovery,logout,me}`.
  SPA gains a full auth flow (LoginScreen, RegisterScreen,
  RecoveryScreen, RecoveryLoginScreen, RegenerateScreen) gated by
  AuthGate before the chat UI mounts. Phase 05's device-ensure shim
  is gone in non-dev mode; dev mode keeps it as `--open-registration`.
- Phase 09a (multi-tab): hub's local connection map keyed by
  `userID` instead of `deviceID`, so multiple tabs of the same user
  no longer evict each other. WebSocket sessions are now scoped to
  user identity via session cookies.

### Added (Phase 00–08 series)
- Phase 08c: handles in welcome, channel summaries, and friend
  picker. Status badge shows `you (alice)`, sidebar DMs show
  `@bob`, friend picker renders handles with UUID fallback.
- Phase 08b: SPA channels. Sidebar with channel list, create-channel
  modal, friend picker via bucketed `friend_list`. `subscribe_channel`
  wire frame lets the SPA drive per-channel topic subscriptions.
  Optimistic-append for own sends. Playwright integration tests.
- Phase 08: channels. Per-channel pubsub topics with dynamic LISTEN
  refcounting, DM cardinality trigger, `create_channel` /
  `list_channels` / `fetch_history` / `channel_event` frames.
  Echo-suppression so the sender device doesn't receive its own
  message back. Migrations 0009 and 0010.
- Phase 07: Preact + esbuild SPA. Matrix-green-on-black theme, Hack
  font, StatusBar, Composer with optimistic local rendering.
  `tools/dev.sh` and `make dev` for the full local stack. SPA
  served from `embed.FS` by `chalkd`.
- Phase 06: presence and friends. `device_presence` table with TTL,
  multi-device aggregate (active/away/offline), heartbeat + janitor.
  Friend store with bucketed queries (pending_outgoing,
  pending_incoming, accepted, blocked). User-lifecycle schema (write
  paths deferred to phase 11). Migrations 0006–0008.
- Phase 05: cross-instance fan-out. `internal/pubsub` with NOTIFY
  publisher and dedicated LISTEN connection on `chalk_global`. Hub
  integration so a message published on one chalkd instance reaches
  subscribers on any other.
- Phase 04: WebSocket relay. `internal/server/ws.go`
  (coder/websocket), `internal/server/hub.go` (local connection
  registry by deviceID), ping/pong, wire protocol v0
  (hello/welcome/send/message). Plaintext payload; MLS arrived in
  phase 11a/11b.
- Phase 03: Postgres store. pgx connection pool, embedded migrations
  runner, initial schema for users + devices + channels + messages.
  Store interfaces for users (create/upsert/get/count), devices,
  channels, messages.
- Phase 02: containerization (Dockerfile, compose files for
  dev/test/prod, healthcheck).
- Phase 01: `chalkd` Go skeleton with config, version, and graceful
  shutdown.
- Phase 00: bootstrap scaffolding, library helpers, project layout.

### Known issues
- Account lifecycle write paths (deactivate, delete, reactivate)
  aren't wired up; the phase-06 schema supports them but no
  handlers exist yet. Deferred to a future phase (formerly numbered
  phase 11 in the older plan; superseded by the current MLS-focused
  11-series).
- Multi-device support for MLS-encrypted DMs is incomplete in 11b.
  A user's second browser profile cannot decrypt MLS DMs sent from
  their first profile. Resolved in phase 11d (design specified in
  `docs/design/phase-11d-doc{1..7}.md`).

### Phase numbering note
The 09+ ordering in `README.md` and `docs/phase-log.md` differs from
the original `bootstrap/` scaffold's stub names (which had 09 blobs,
10 mls, 11 friending, 12 hardening, 13 cross-browser). The current
plan, reflected in this CHANGELOG and `docs/phase-log.md`:

- **09** auth (shipped as 09a–09d)
- **10** (skipped; the original "MLS" phase was folded into the 11
  series for clarity)
- **11a** CoreCrypto foundation (shipped)
- **11b** MLS DM encryption (shipped as 11b-1, 11b-2, 11b-3)
- **11c** MLS multi-member channel encryption (planned)
- **11d** Multi-device + history transfer (designed, not yet
  implemented)
- **12** Account lifecycle write paths (planned)
- **13** Blobs / encrypted attachments (planned)
- **14** Hardening: rate limits, metrics, GC, `--migrate-only`
  (planned)
- **15** Cross-browser testing matrix (planned)

The stubs in `bootstrap/` still carry the old names and will be
renamed as each phase actually starts. See
`docs/phase-log.md` for the canonical history.
