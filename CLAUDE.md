# CLAUDE.md — chalk

Self-hosted, end-to-end-encrypted group chat. Sole developer: scuq. One repo,
one deployable image (chalkd + web bundle) plus the `chalkctl` deployment
manager.

## Code Style

- Write code for humans first. Prioritize readability over cleverness.
- Keep implementations simple, clean, and maintainable.
- Prefer explicit code over unnecessary abstractions.
- Avoid premature optimization and over-engineering.
- Keep functions focused on a single responsibility.

## Comments

- Do not comment obvious code.
- Add comments only when the intent, reasoning, or a non-obvious implementation needs explanation.
- Comments should explain *why*, not *what* the code does.
- Remove outdated comments instead of leaving misleading documentation.

## Dependencies

- Minimize external dependencies.
- Prefer the standard library whenever it provides a reasonable solution.
- Only introduce third-party libraries when they provide significant value.
- Choose mature, stable, actively maintained, and widely adopted libraries.
- Avoid adding dependencies for trivial functionality.

## Maintainability

- Keep the codebase consistent in style and structure.
- Avoid unnecessary complexity.
- Prefer predictable, stable solutions over clever tricks.
- Refactor duplicated logic when it improves clarity without introducing unnecessary abstractions.
- Write code that another engineer can understand in a few minutes.

## General Principles

- Optimize for long-term maintainability rather than short-term convenience.
- Favor robustness and correctness over micro-optimizations.
- When multiple solutions exist, choose the simplest one that satisfies the requirements.

## Stack & layout

- **Server**: Go 1.25, net/http (method-pattern mux), pgx/v5, PostgreSQL.
  - `internal/auth/` — passkeys (go-webauthn), auth v2 (password+TOTP), sessions
  - `internal/store/` — all SQL; `s.Pool` for one-shot queries, `s.withTx`
    (store.go) + `FOR UPDATE` for anything needing consistency guarantees
  - `internal/chalkctl/` + `cmd/chalkctl/` — deployment manager (podman
    quadlets, Caddy, coturn, cosign-verified GHCR pulls, weekly update timer)
- **Client**: Preact + TypeScript, esbuild, Node 22. Lives in `web/`.
  - `web/src/auth/`, `web/src/crypto/`, `web/src/components/`, `web/src/state/`
  - All E2E crypto is client-side: BIP-39 identity seed → X25519/Ed25519;
    per-channel space keys, AES-256-GCM; server is a blind relay.
- **Infra**: Dockerfile/Containerfile at root; `.github/workflows/release.yml`
  builds multi-arch image + chalkctl binaries on `v*` tags, cosign-signed.

## Commands

```bash
# server
go build ./... && go vet ./...
go test ./...                      # or scoped: ./internal/auth/ ./internal/chalkctl/
gofmt -l .                         # must be empty before commit

# client (from web/)
npm install
npx tsc --noEmit
node test.mjs                      # node:test suite; currently 729 tests, 0 fail
node build.mjs

# database (dev)
sudo docker exec -i chalk-dev-pg psql -U chalk -d chalk
```

Run the full verify chain (build, vet, tests, tsc, client tests, bundle)
before declaring any change done.

## Working agreements

- **NEVER commit or push.** Propose the `git add` file list and a
  `git commit -m "..."` one-liner; scuq runs it. Commit messages:
  `phase <N>-<slice>: <summary>` (e.g. `phase 31-9: auth-v2 hard cutover ...`).
- Features are built as **numbered slices** (31-1 … 31-13, 30-1 … 30-8), each
  independently verifiable. Ask before widening scope beyond the slice.
- **Surgical fixes over architectural change** for bugs found in testing.
- **Changelog with the change.** Any slice a user would notice — a feature, a
  behaviour change, a bug they could have hit — gets a bullet under
  `## Unreleased` in `CHANGELOG.md` in the same change set, and the file goes
  in the proposed `git add` list. Skip it for refactors, tests, docs, and
  internal plumbing nobody outside the repo can observe; if it's borderline,
  add the bullet. Write it for a chalk *user*, not for the commit log: what
  they can now do, or what used to go wrong and no longer does — no slice
  numbers, no file or symbol names. Fixes say what the wrong behaviour looked
  like. Sections in an `## Unreleased` block: `### Added`, `### Changed`,
  `### Fixed`. Never invent a version heading; scuq cuts releases by tagging,
  and `## Unreleased` gets renamed then.
- Ask before adding dependencies (Go modules or npm packages).
- Style: direct, concise, no filler. Explain what changed and why in a few
  lines, then the verify commands.

## Hard-won gotchas

- **SELECT/scan three-site rule**: RETURNING column count, struct field
  count, and scan argument count must all match. Check all three whenever any
  one changes.
- **SQL scope**: LATERAL/subquery columns not exposed to the outer SELECT
  compile in Go but fail at runtime in Postgres. Trace column scope manually;
  `go build` proves nothing about SQL.
- **gofmt realignment**: const blocks, struct fields, and keyed composite
  literals get value/comment column realignment. Never assume byte-exact
  content of such regions; re-read before editing.
- **Client cache vs server**: IndexedDB caches (space keys, identities,
  attachments) can mask or mimic server bugs — distinguish stale client state
  from real server holes before "fixing" the server.
- **npm audit**: the 1 moderate esbuild dev-server advisory is known and
  accepted. Never run `npm audit fix --force`.
- **Env config**: everything is `CHALK_*` env vars, deployed via
  `internal/chalkctl/templates/chalk.env.tmpl`. A new server env var is not
  done until chalkctl generates/preserves it (see `CHALK_TOTP_ENC_KEY` /
  `CHALK_ADMIN_BOOTSTRAP_TOKEN` in init.go for the pattern: generate fresh,
  preserve on `--force`, backfill on `update` when absent).
- **webauthn**: go-webauthn v0.17 validates credential BE/BS flags, so a
  credential row with zero-value flags fails login against a synced passkey
  ("Backup Eligible flag inconsistency"). Handled: migration 0042 stores the
  flags and `adoptLegacyFlags` (internal/auth/http.go) seeds pre-0042 rows
  from the asserted flags. Any new credential path must persist them.

## Auth model (v2, phase 31 — complete)

- Password ≥20 chars, 4 classes (space counts as special), client-enforced;
  server floor Argon2id 256 MiB/3/1.
- master = Argon2id(pw, salt); authProof = HKDF(master, "chalk/auth") (server
  stores SHA-256 of it); KEK = HKDF(master, "chalk/kek") wraps the 32-byte
  identity entropy (`identity_seed_wrap`).
- TOTP mandatory on every login, including the passkey path. Passkeys are a
  convenience factor, not a bypass.
- Two separate 24-word phrases: recovery phrase (auth reset) vs encryption
  phrase (identity seed; never leaves the client).
- Hard cutover: `CHALK_AUTH_V2_REQUIRED` (default on) + per-user
  `auth_v2_enrolled`; un-enrolled sessions get 409 → client migration wizard.
- Admin bootstrap: reserved admin username claimable only with the one-shot
  `CHALK_ADMIN_BOOTSTRAP_TOKEN` (URL `?admin_token=...`), dead once the admin
  account exists.
- Recovery = **reset**, not login (31-13): the phrase sets a new password via
  `/api/auth/recovery/reset-auth`, plus a live `totp_code` — or `reset_totp`
  when the authenticator is what was lost, which clears TOTP for re-enrollment
  through the minted session. Phrase-alone `/api/auth/recovery` is 409
  `auth_reset_required` for enrolled accounts (it bypassed the second factor
  and left the user unable to change the password they'd forgotten). The reset
  purges the password seed wraps; only the identity gate's
  `maybeUploadSeedWrap` re-creates them from the encryption phrase.

## Current state / open items

Shipped history lives in `docs/phase-log.md` (engineering) and `CHANGELOG.md`
(user-facing). Latest release: v0.4.10. Only what is NOT done belongs here.

- Phases through 57-4 are committed. Complete arcs: auth v2 (31), voice/video
  (30-1 … 30-8 plus the 41/44/47/48 mic, device and call-UI work), governance
  (gov-1/gov-2, panel included), attachments, multi-device, unread + read
  cursors (33), threads and the thread inbox (42/47/49), notifications
  (40/50), mobile layout (32), CSP + security headers (51-1), the voice
  scratchpad (45), camera background effects (52), the parking lot
  (53-1/53-2), roster filter + channel groups (54, plan in
  `docs/PHASE-54-ROSTER.md`), main-feed scrollback paging (55, plan in
  `docs/PHASE-55-HISTORY.md`), composer @mention autocomplete (56-1), link
  previews (57, plan in `docs/PHASE-57-LINKPREVIEW.md`: sender-built,
  E2E-embedded, opt-in, SSRF-guarded server fetcher).
- Next candidates, none started: web push notifications (phase 65, full
  plan in `docs/PHASE-65-PUSH.md`: hand-rolled `internal/webpush`, DMs-only
  default, content-free payloads); the SFU seam (voice design Slice I) for
  rooms too large for a mesh; governance `set_config` proposals.
- Deferred cleanup, all verified still open:
  - `RegisterFromInviteScreen` still registers passkey-first
    (`navigator.credentials.create()`), out of step with the auth-v2 password
    + TOTP flow every other entry point uses.
  - `auth_backup_code` is dormant: migration 0040 creates it and
    `store/auth_v2.go` has `ReplaceBackupCodes` / `ConsumeBackupCode` /
    `CountUnusedBackupCodes`, with no caller anywhere. Drop table + funcs.
  - `docs/phase-31/PHASE-31-ADDENDUM-B-ENVELOPE.md` needs the correction noted
    during phase 31.
  - The threads dot's server total is only re-synced on a debounced refetch;
    threads whose inbox rows this client doesn't hold still lag until then
    (`threadsNeedingYouCount` corrects only held rows).
  - The camera choice (`device-prefs.ts` cameraId) has the same stale-id
    weakness the mic had before 63-3 (Brave re-randomizes deviceIds per
    session; late-plugged devices unmatched). Fix the same way: persist the
    label, resolve via `voice/device-resolve.ts` at capture time.
  - The client's windowed attachment backfill (App.tsx `listAttachments`
    effect, `GET /api/attachments`, `CHALK_ATTACH_FETCH_WINDOW_HOURS`) is
    redundant since fetch_history started carrying attachment refs on the
    page itself; drop the effect, the endpoint, the
    `ListAttachmentsForChannelWindow` query and the env knob together.
  - `docker/Dockerfile`'s frontend stage runs `npm run build` without
    `NODE_ENV=production`, so released images ship unminified bundles with
    inline sourcemaps. Costlier since 52-2 (the MediaPipe chunk is 153 KB
    minified vs 737 KB as shipped).
