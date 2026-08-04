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
node test.mjs                      # node:test suite; currently 1161 tests, 0 fail
node build.mjs

# notification sounds (from the repo root)
node tools/sound-bench.mjs         # regenerate + open tools/sound-bench.html

# finding code (from the repo root)
tools/where.sh -c parking          # which layers does a feature touch?
tools/where.sh friend_request      # the chain, both sides of the wire

# database (dev)
sudo docker exec -i chalk-dev-pg psql -U chalk -d chalk
```

Run the full verify chain (build, vet, tests, tsc, client tests, bundle)
before declaring any change done.

Start feature work and bug hunts with `tools/where.sh`, not a bare grep.
chalk's features cut vertically — schema → wire frame → ws handler → store →
client proto → reducer → component — and the script runs that sweep in one
pass, groups the hits in that order, and tags each one with its enclosing
`func`/`const`/`case`. `-c` gives the layer map alone, which is usually enough
to tell whether a bug is server-side or client-side before opening anything.
It is a locator, not an index: it shells out to ripgrep every time (the whole
repo greps in ~6 ms), so it can never go stale.

It also matches a plain identifier across naming conventions, which matters
because chalk renames at every hop: `friend_request` → `TypeFriendRequest` →
`handleFriendRequest` → `friends.Request`. Seeding with the wire string finds
the whole chain; a literal grep for it never reaches `internal/server/` or
`internal/friends/` at all. Pass `-l` for a literal match; a pattern containing
regex characters is used as written.

Topics are tagged, and the tags already exist: ~650 phase comments (`// 54-2:`)
across ~120 files. `docs/tags.md` is the legend mapping topics to those phase
numbers and to the paths they live in — `tools/where.sh -g roster` searches
both at once, `-g` alone lists every tag. This finds code whose *name* never
mentions the topic: `-g camera-bg` works even though that string appears
nowhere in the source, because phase 52 is tagged throughout it.

A tag whose phases have drifted is worse than a missing one, so `-g` warns when
a listed path no longer exists. Keeping the legend current is a working
agreement below, not an optional tidy-up.

It needs ripgrep, and exits with `where.sh: needs ripgrep` when it is missing.
That is not something to work around with `grep -r` — ask scuq to install it
(`sudo apt install ripgrep` on this Debian box) and carry on once it is there.

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
- **Release version follows `CHANGELOG.md`.** Cutting a release means renaming
  `## Unreleased` to `## vX.Y.Z — <D Month YYYY> — <theme>`; in the same change
  set, update "Latest release" under *Current state / open items* below to that
  version. The topmost `## vX.Y.Z` heading in `CHANGELOG.md` is the source of
  truth and this file only points at it — nothing else in the repo carries a
  version number, since it is stamped from the git tag through ldflags
  (`Makefile` `VERSION`, set by `.github/workflows/release.yml`). A stale
  pointer is worse than none, because it still reads as current.
- **Tags with the phase.** A new phase number gets a line in `docs/tags.md`, or
  its number appended to the topic already listed there, in the same change set
  — and the file goes in the proposed `git add` list. Same whenever a search
  shows a topic living somewhere its paths do not cover: widen that line. The
  legend is the only thing that makes the phase comments findable by topic, and
  it stays true only if it moves with the code. Correct a drifted entry in
  place; never add a second line for a topic that already has one.
- **A phase doc with the phase.** A new phase number also gets its own
  `docs/PHASE-<N>-<TOPIC>.md` — created with the first slice, not after the
  last — and the file goes in the proposed `git add` list. Name the topic in
  caps, one word (`PHASE-82-SIGNEDWRAP.md`, `PHASE-84-PINBACKUP.md`). It
  carries what the code cannot: the problem the phase exists to solve, the
  design and what was rejected, the slice list with what each one lands, and
  any manual checklist a slice leaves open. Keep it current as slices land —
  a plan that stopped matching the code is worse than no plan. Then point at
  it from *Current state / open items* below while the phase is open, and
  from `docs/phase-log.md` once it ships.
- **Probes belong in the test suite.** To find out how code behaves, add or
  extend a `*.test.ts` beside it and run `node test.mjs`, or a `_test.go` and
  `go test ./internal/...` — both are permitted, so neither prompts. Do not
  pipe a throwaway script into `node`: a heredoc write plus an arbitrary
  `node <path>` run is precisely what the permission prompts exist to catch,
  it cannot be allowlisted without granting blanket execution, and the answer
  evaporates instead of becoming regression cover. `--experimental-strip-types`
  is specifically what `web/test.mjs` exists to avoid — read its header before
  reaching for it. Check for an existing test file first; the behaviour in
  question is often already asserted.
  The exception is UI probes, which need a browser and a running stack and so
  cannot be a `*.test.ts`: write those to
  `.claude/skills/run-chalk/probes/ui.mjs` (allowlisted, gitignored, rewritten
  per investigation) and run them from the repo root with no `cd`, no `rm` and
  no pipe — the probe cleans `/tmp/chalk-probe/` itself and prints its own
  summary. A probe worth a second run gets a topic name, a commit beside
  `readme-shots.mjs`, and its own allowlist entry.
- **Read and search with the dedicated tools, not shell text-slicing.** To read
  a known range, use the file-read tool with an offset and a line count — not
  `sed -n '150,215p'`, `head`, or `cat`. It returns numbered lines, it does not
  prompt, and an edit needs the file read first anyway, so `sed` reads it twice.
  When `tools/where.sh` is the wrong shape for the question — one literal string
  in one known file — call `rg` directly: `grep -r` walks `node_modules/` and
  `web/dist/`, and a `web/src/**/*.ts` glob silently matches a single directory
  level unless the shell has `globstar` on. Issue independent lookups as
  separate parallel tool calls instead of chaining them with `;` and `echo
  "=== ... ==="` separators — chained one-liners run serially, each unique
  string misses the allowlist and prompts, and parallel results come back
  labelled already.
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
- **Notification sounds are tuned by ear, never derived.** `SOUND_SPECS`
  (`web/src/notify/synth.ts`) is the recording of a listening session, and
  its comments say *why* each number is what it is — changing one means
  listening again and rewriting the comment with it. `node
  tools/sound-bench.mjs` builds the bench that session needs (every
  category, the real synth graph extracted from the source so it can't
  drift, sliders, A/B against what's committed, and the `synth.test.ts`
  invariants shown live so tuning can't end in a red build) and prints its
  `file://` URL for scuq to open. Its "copy tuned specs" block pastes back
  into the table.
- **Client cache vs server**: IndexedDB caches (space keys, identities,
  attachments) can mask or mimic server bugs — distinguish stale client state
  from real server holes before "fixing" the server.
- **npm audit**: clean in both `web/` and `test/e2e/` as of 81-5, which
  retired the long-accepted esbuild dev-server advisory by bumping to 0.25.
  Keep it that way; never run `npm audit fix --force`.
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
(user-facing). Latest release: v0.7.0 — keep this in step with the topmost
`## vX.Y.Z` heading in `CHANGELOG.md`. Only what is NOT done belongs here.

- Phase 85 is the newest work; `docs/phase-log.md` has the full history,
  and the arcs named here are a sample, not the whole list. Among the complete
  ones: auth v2 (31), voice/video
  (30-1 … 30-8 plus the 41/44/47/48 mic, device and call-UI work), governance
  (gov-1/gov-2, panel included), attachments, multi-device, unread + read
  cursors (33), threads and the thread inbox (42/47/49), notifications
  (40/50), mobile layout (32), CSP + security headers (51-1), the voice
  scratchpad (45), camera background effects (52), the parking lot
  (53-1/53-2), roster filter + channel groups (54, plan in
  `docs/PHASE-54-ROSTER.md`), main-feed scrollback paging (55, plan in
  `docs/PHASE-55-HISTORY.md`), composer @mention autocomplete (56-1), link
  previews (57, plan in `docs/PHASE-57-LINKPREVIEW.md`: sender-built,
  E2E-embedded, opt-in, SSRF-guarded server fetcher), the security-audit
  remediation (81, record in `docs/PHASE-81-SECAUDIT.md`), signed channel-key
  wraps (82, record in `docs/PHASE-82-SIGNEDWRAP.md`), the identity-pin backup
  (84, record in `docs/PHASE-84-PINBACKUP.md`), operational logging (85-1 …
  85-4, record in `docs/PHASE-85-OPLOG.md`: security events, the opt-in
  connection snapshot, slow requests, and Caddy's access log; chalkd's knobs
  are `CHALK_OPLOG_*`, documented in `internal/config/oplog.go`). Phase 85's
  open items are the live-stack run of the connection snapshot and the missing
  off switch for the Caddy access log — both listed at the end of its record.
- **Phase 82 (signed channel-key wraps) is COMPLETE** — 82-1 … 82-9, record in
  `docs/PHASE-82-SIGNEDWRAP.md`. It closes the phase-81 audit's C-01, but
  **conditionally**: `CHALK_WRAP_SIG_REQUIRED` defaults to false, and until an
  operator flips it (after the self-healing sweep has re-signed their wraps) a
  server can still substitute a key on a channel no current-build member has
  opened. Never describe C-01 as fixed unconditionally. `chalkctl wrapsig
  status` is what says whether a deployment is ready to flip.
  - Two follow-ups are still open: the **end-to-end run against a live stack**
    (checklist at the end of the phase doc — the only exercise of the real
    Postgres upsert guard, and worth doing before a release carries this), and
    the guest path's remaining exposure: links minted before 82-7 stay unsigned
    until they expire.
- **Open security gap, confirmed by the phase-81 audit** (analysis in
  `docs/PHASE-81-SECAUDIT.md`; `docs/threat-model.md` states it as an unmet
  guarantee):
  - **Messages carry no sender signature.** The AEAD associated data is only
    suite/channel/key-version, so sender, message ID and timestamp are
    unauthenticated server-supplied metadata and any key holder can be
    impersonated. Fix = signed message envelope, extended to edits, reactions
    and attachment refs. Phase 83, together with the **authenticated
    channel-state transcript**: membership is still server-asserted, so a
    server that adds a principal it controls gets the key handed to it by a
    member's auto-reshare. 82-8 makes that visible (the join notice) but
    cannot prevent it. Both share the identity anchor phase 82 already paid
    for, and should copy `web/src/voice/signal-crypto.ts`, which already does
    canonical-encode → Ed25519 sign → fail-closed verify correctly.
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
