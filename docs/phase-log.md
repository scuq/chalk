# Phase Log

What each bootstrap phase delivers and what it tests. Kept in sync with `bootstrap/`.

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

## 03 — postgres ⏳

**Will deliver**
- pgx connection pool (`internal/store`)
- Embedded migrations runner
- Initial schema (`migrations/0001_init.sql` — users, devices)
- Store interfaces and implementations for users, devices

**Will test**
- Spin ephemeral PG, apply migrations, idempotent re-apply
- Seed alice/bob/carol via fixture, query them back
- Concurrent inserts (race detector enabled)

## 04 — ws-relay ⏳

**Will deliver**
- `internal/server/ws.go` — WebSocket handler
- `internal/server/hub.go` — local connection registry
- Ping/pong with 15s/30s timing
- Plaintext echo protocol (placeholder for MLS in phase 10)

**Will test**
- Two clients connect, one sends, the other receives
- Ping/pong keeps connection alive 60s
- Idle connection torn down after missed pongs

## 05 — pubsub ⏳

**Will deliver**
- `internal/pubsub` — NOTIFY publisher + dedicated LISTEN connection
- Per-instance NOTIFY channels for routing
- Hub integration: incoming NOTIFY → fan out to local sockets

**Will test**
- Two chalkd instances on different ports
- Client A on instance 1 sends, client B on instance 2 receives within 50ms
- Postgres restart → instances reconnect listener cleanly

## 06 — presence ⏳

**Will deliver**
- `device_presence` table with `device_type` and TTL logic
- Multi-device aggregate (`active`/`away`/`dnd`/`offline`)
- Instance heartbeat + janitor for crash recovery
- Coarse online/offline broadcast via NOTIFY

**Will test**
- Connect alice from "phone", bob sees alice online within 1s
- Phone idle 90s → alice shows away (TTL decay)
- Desktop active overrides phone away → alice shows active
- Kill chalkd hard → janitor cleans up within 20s

## 07 — frontend-shell ⏳

**Will deliver**
- `web/` SPA scaffold (vanilla ES modules, no build step)
- Theming system (CSS vars, default Matrix theme, alternates)
- Hack font (4 weights, WOFF2)
- Sound engine (synthesized + sample pack hooks)
- Roster UI shell
- Composer with optimistic local rendering

**Will test**
- Binary serves SPA from `embed.FS`
- Composer keystroke → paint < 16ms (measured in browser harness)
- Theme switching via `data-theme` attribute
- User overrides via injected `<style>`
- Roster shows seeded users with online status

## 08 — channels ⏳

**Will deliver**
- `channels`, `channel_members`, `messages` tables
- Wire protocol: `create_channel`, `send`, `fetch_history`, `fetch_thread`
- Threading model (thread_id, parent_id)
- Channel UI with thread pane

**Will test**
- alice creates channel, adds bob+carol
- Top-level message → all three receive
- Reply in thread → fetch_thread returns only that thread
- Reconnect → catch-up via `seq` returns missed messages in order

## 09 — blobs ⏳

**Will deliver**
- `blobs` table, blob upload endpoint with token auth
- Client-side AES-256-GCM encryption helpers
- Attachment UI in composer
- GC for unreferenced blobs

**Will test**
- Upload 1MB blob with token, download it
- Server bytes ≠ uploaded bytes (encrypted)
- GC removes unreferenced blobs after TTL

## 10 — mls ⏳

**Will deliver**
- CoreCrypto WASM in `web/vendor/`
- Web Worker harness for crypto
- KeyPackage publish/fetch with `FOR UPDATE SKIP LOCKED`
- MLS group creation, Add, Remove, Welcome flows

**Will test**
- alice + bob + carol form an MLS group
- All three exchange messages; server logs verified to contain only ciphertext
- Member add/remove works
- KeyPackage refill triggered when low

## 11 — friending ⏳

**Will deliver**
- `friendships`, `friend_requests` tables
- Encrypted presence over per-friendship MLS group
- Last-seen sharing (encrypted, opt-out)
- Roster UI showing per-device breakdown on hover

**Will test**
- alice sends request to bob, bob accepts, both rosters update
- alice goes away, bob's roster reflects in <2s
- Remove friend → presence subscription revoked

## 12 — hardening ⏳

**Will deliver**
- Per-connection rate limit (`golang.org/x/time/rate`)
- Payload size caps
- Blob quota per user
- Structured JSON logging (zerolog)
- Prometheus `/metrics` endpoint
- `chalkd --migrate-only` flag

**Will test**
- Flood test → rate limiter triggers expected 429s
- Oversized payload rejected
- `/metrics` exposes request counts and ws connections

## 13 — cross-browser ⏳

**Will deliver**
- `test/e2e/` Playwright config
- Engine matrix: Chromium / Firefox / WebKit
- Viewport matrix: desktop / mobile-iOS / mobile-Android
- Manual real-device checklist

**Will test**
- Full e2e suite passes on all engine × viewport combinations
- HTML report uploaded as artifact
