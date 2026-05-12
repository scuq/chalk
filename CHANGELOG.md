# Changelog

All notable changes to chalk are documented here.

## [Unreleased]

### Added
- Phase 08c: handles in welcome, channel summaries, and friend picker. Status badge shows `you (alice)`, sidebar DMs show `@bob`, friend picker renders handles with UUID fallback.
- Phase 08b: SPA channels. Sidebar with channel list, create-channel modal, friend picker via bucketed `friend_list`. `subscribe_channel` wire frame lets the SPA drive per-channel topic subscriptions. Optimistic-append for own sends. Playwright integration tests.
- Phase 08: channels. Per-channel pubsub topics with dynamic LISTEN refcounting, DM cardinality trigger, `create_channel` / `list_channels` / `fetch_history` / `channel_event` frames. Echo-suppression so the sender device doesn't receive its own message back. Migrations 0009 and 0010.
- Phase 07: Preact + esbuild SPA. Matrix-green-on-black theme, Hack font, StatusBar, Composer with optimistic local rendering. `tools/dev.sh` and `make dev` for the full local stack. SPA served from `embed.FS` by `chalkd`.
- Phase 06: presence and friends. `device_presence` table with TTL, multi-device aggregate (active/away/offline), heartbeat + janitor. Friend store with bucketed queries (pending_outgoing, pending_incoming, accepted, blocked). User-lifecycle schema (write paths deferred to phase 11). Migrations 0006–0008.
- Phase 05: cross-instance fan-out. `internal/pubsub` with NOTIFY publisher and dedicated LISTEN connection on `chalk_global`. Hub integration so a message published on one chalkd instance reaches subscribers on any other.
- Phase 04: WebSocket relay. `internal/server/ws.go` (coder/websocket), `internal/server/hub.go` (local connection registry by deviceID), ping/pong, wire protocol v0 (hello/welcome/send/message). Plaintext payload; MLS arrives in phase 10.
- Phase 03: Postgres store. pgx connection pool, embedded migrations runner, initial schema for users + devices + channels + messages. Store interfaces for users (create/upsert/get/count), devices, channels, messages.
- Phase 02: containerization (Dockerfile, compose files for dev/test/prod, healthcheck).
- Phase 01: `chalkd` Go skeleton with config, version, and graceful shutdown.
- Phase 00: bootstrap scaffolding, library helpers, project layout.

### Known issues
- Sender labels in the message list still show the device-id suffix for non-self senders, because the message frame doesn't yet carry sender handles. Deferred to phase 09 (auth/usernames).
- Multiple browser tabs of the same user evict each other because the hub keys connections by deviceID and localStorage shares the device id across tabs. To be addressed in phase 09 (multi-conn-per-user).
- Account lifecycle write paths (deactivate, delete, reactivate) aren't wired up; the phase-06 schema supports them but no handlers exist yet. Phase 11.

### Phase numbering note
The 09+ ordering in `README.md` and `docs/phase-log.md` differs from the original scaffold. New plan: 09 auth, 10 mls, 11 lifecycle, 12 blobs, 13 hardening, 14 cross-browser. Old scaffold had: 09 blobs, 10 mls, 11 friending, 12 hardening, 13 cross-browser. The stubs in `bootstrap/` still carry the old names and will be renamed as each phase starts.