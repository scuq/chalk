# CLAUDE.md — chalk

Self-hosted, end-to-end-encrypted group chat. Sole developer: scuq. One repo,
one deployable image (chalkd + web bundle) plus the `chalkctl` deployment
manager. This file is only what applies to every session; the detail lives in
`docs/` and is linked from where it is needed.

## Stack

- **Server** — Go 1.25, net/http (method-pattern mux), pgx/v5, PostgreSQL.
  `internal/store/` holds all SQL: `s.Pool` for one-shot queries, `s.withTx`
  (store.go) + `FOR UPDATE` for anything needing consistency guarantees.
  `internal/chalkctl/` + `cmd/chalkctl/` is the deployment manager (podman
  quadlets, Caddy, coturn, cosign-verified GHCR pulls, weekly update timer).
- **Client** — Preact + TypeScript, esbuild, Node 22, all under `web/`.
- **Crypto is client-side and the server is a blind relay** — BIP-39 identity
  seed → X25519/Ed25519, per-channel space keys, AES-256-GCM. Never move a
  decision the client owns onto the server.

## Commands

```bash
# server (repo root)
go build ./... && go vet ./...
go test ./...                      # or scoped: ./internal/auth/ ./internal/chalkctl/
gofmt -l .                         # must be empty before commit

# client (from web/)
npx tsc --noEmit
node test.mjs                      # node:test suite
node build.mjs

# finding code (repo root) — see below
tools/where.sh -c parking          # which layers does a feature touch?
tools/where.sh friend_request      # the chain, both sides of the wire

# dev database
sudo docker exec -i chalk-dev-pg psql -U chalk -d chalk
```

**Run the full verify chain — build, vet, gofmt, `go test`, tsc, `node
test.mjs`, `node build.mjs` — before declaring any change done.**

## Finding code

Start feature work and bug hunts with `tools/where.sh`, not a bare grep.
chalk's features cut vertically (schema → wire frame → ws handler → store →
client proto → reducer → component) and chalk renames at every hop
(`friend_request` → `TypeFriendRequest` → `handleFriendRequest` →
`friends.Request`), so a literal grep for the wire string never reaches
`internal/server/` at all. `where.sh` sweeps every layer in one pass, matches
across naming conventions, and tags each hit with its enclosing symbol. `-c`
gives the layer map alone — usually enough to tell server-side from
client-side before opening anything. `-g <topic>` resolves a topic through
`docs/tags.md` to the ~650 `// 54-2:` phase comments, which finds code whose
*name* never mentions the topic. Run it with no arguments for full usage.

It needs ripgrep and says so when missing — ask scuq to install it
(`sudo apt install ripgrep` on this Debian box) rather than falling back to
`grep -r`.

When `where.sh` is the wrong shape for the question — one literal string in
one known file — call `rg` directly; `grep -r` walks `node_modules/` and
`web/dist/`. To read a known range, use the file-read tool with an offset and
a line count, never `sed -n`, `head` or `cat`. Issue independent lookups as
parallel tool calls rather than `;`-chained one-liners: chained commands run
serially and each unique string misses the allowlist and prompts.

## Working agreements

- **NEVER commit or push.** Propose the `git add` file list and a
  `git commit -m "..."` one-liner; scuq runs it. Messages are
  `phase <N>-<slice>: <summary>`.
- Features are built as **numbered slices**, each independently verifiable.
  **Ask before widening scope beyond the slice.** Prefer surgical fixes over
  architectural change for bugs found in testing.
- **Ask before adding any dependency** (Go module or npm package). chalk
  prefers the standard library and hand-rolls small things on purpose.
- **A change set carries its own paperwork**, and each file below goes in the
  proposed `git add` list:
  - `CHANGELOG.md` — a bullet under `## Unreleased` (`### Added` / `###
    Changed` / `### Fixed`) for anything a user would notice; skip refactors,
    tests, docs and internal plumbing; add it when borderline. Write it for a
    chalk *user*: what they can now do, or what used to go wrong and no longer
    does — no slice numbers, no file or symbol names. Never invent a version
    heading.
  - `docs/tags.md` — a new phase number gets a line, or its number appended to
    the topic already listed there; widen a line whenever a search shows a
    topic living outside its paths. Correct a drifted entry in place, never add
    a second line for a topic that has one. This legend is the only thing that
    makes the phase comments findable by topic.
  - `docs/phases/PHASE-<N>-<TOPIC>.md` — created with the **first** slice, not
    after the last (topic in caps, one word). It carries what the code cannot:
    the problem, the design and what was rejected, the slice list, and any
    manual checklist a slice leaves open. Keep it current as slices land, and
    add its row to the index at the top of `docs/phase-log.md` once it ships.
- **Read `docs/phase-log.md`'s index before proposing a phase number.** Several
  phases are designed with no code behind them (marked *planned, not started*).
  A new idea is often one of them and belongs in its doc rather than a parallel
  number; those numbers are claimed, so the next free one is past them; and
  building one means flipping its status header and its index row in the same
  change set. A plan that turns out wrong gets corrected or retired, never left
  standing beside code that contradicts it.
- **Cutting a release is the `/release` skill.** Do not do it by hand.
- **Probes belong in the test suite.** To learn how code behaves, extend a
  `*.test.ts` and run `node test.mjs`, or a `_test.go` and `go test`; both are
  allowlisted, so neither prompts. Never pipe a throwaway script into `node` —
  it is exactly what the permission prompts exist to catch, it cannot be
  allowlisted without granting blanket execution, and the answer evaporates
  instead of becoming regression cover. Check for an existing test file first;
  the behaviour is often already asserted. UI probes are the exception, since
  they need a browser and a running stack: write those to
  `.claude/skills/run-chalk/probes/ui.mjs` and run them from the repo root with
  no `cd`, no `rm` and no pipe.
- Style: direct, concise, no filler. Explain what changed and why in a few
  lines, then the verify commands.

## Gotchas

- **SELECT/scan three-site rule**: RETURNING column count, struct field count
  and scan argument count must all match. Check all three whenever one changes.
- **SQL scope**: LATERAL/subquery columns not exposed to the outer SELECT
  compile in Go but fail at runtime in Postgres. `go build` proves nothing
  about SQL — trace column scope by hand.
- **gofmt realignment**: const blocks, struct fields and keyed composite
  literals get value/comment column realignment. Never assume byte-exact
  content of such regions; re-read before editing.
- **Client cache vs server**: IndexedDB caches (space keys, identities,
  attachments) can mask or mimic server bugs. Rule out stale client state
  before "fixing" the server.
- **Env config**: everything is `CHALK_*` env vars. A new server env var is not
  done until `chalkctl` generates it fresh, preserves it on `--force` and
  backfills it on `update` (pattern: `CHALK_TOTP_ENC_KEY` in
  `internal/chalkctl/init.go`; template `templates/chalk.env.tmpl`).
- **webauthn**: go-webauthn v0.17 validates credential BE/BS flags, so a
  credential row with zero-value flags fails login against a synced passkey.
  Any new credential path must persist them (migration 0042, `adoptLegacyFlags`
  in `internal/auth/http.go`).
- **npm audit** is clean in `web/` and `test/e2e/`. Keep it that way; never run
  `npm audit fix --force`.
- **Notification sounds are files, not code.** The WAVs under
  `web/assets/sounds/<theme>/` are scuq's DAW work; never regenerate, resample
  or "normalize" them. The one exception is `chalk-classic`, which is the
  deleted phase-40 synthesizer rendered offline by
  `tools/render-classic-theme.mjs` — that folder is reproduced by re-running
  the tool and never edited by hand. A theme is ten cues and chalk has
  seventeen categories — the mapping is `CUE_FOR` in
  `web/src/notify/themes.ts`, and `themes.test.ts` holds table and folders to
  each other. Details in `docs/notification-sounds.md`.

## Auth model (v2, complete — full record in `docs/phases/PHASE-31-AUTHV2.md`)

- Password ≥20 chars, 4 classes, client-enforced; server floor Argon2id
  256 MiB/3/1. master = Argon2id(pw, salt); authProof = HKDF(master,
  `chalk/auth`), server stores its SHA-256; KEK = HKDF(master, `chalk/kek`)
  wraps the 32-byte identity entropy.
- **TOTP is mandatory on every login, including the passkey path.** Passkeys
  are a convenience factor, never a bypass.
- Two separate 24-word phrases — recovery (auth reset) and encryption (identity
  seed, never leaves the client). Do not conflate them.
- **Recovery is a reset, not a login**: the phrase plus a live TOTP code sets a
  new password. Phrase-alone login was deleted in 81-7 and must not come back.
  Every failure before the phrase verifies answers `recovery_failed`,
  indistinguishable in body, status and work; only what the phrase proves
  unlocks specific errors.

## What's open

`docs/open-items.md` is the authority on what is **not** done — open phases and
their caveats, next candidates, and deferred cleanup. Read it before proposing
new work. Shipped history is `docs/phase-log.md` (engineering) and
`CHANGELOG.md` (user-facing); the topmost `## vX.Y.Z` heading there is the only
version number in the repo, everything else is stamped from the git tag.

**Before making any claim about chalk's security properties**, read
`docs/threat-model.md` and `docs/open-items.md`. The trust model was revised
2026-08-09: chalkd itself is trusted, the host it runs on is not (stored state
must never yield sent messages), and a MITM toward the registered home server
must be detectable. Under it: every message, edit and reaction is a signed
sealed envelope verified fail-closed against pinned identities (phase 83,
built — caveats in its slice record: guest sends unsigned, no phrase-rotation
UI); membership is server-asserted **by design**, an accepted property, not a
gap, made visible by D.6's observed roster notices; and the phase-81 audit's
C-01 is closed only where `CHALK_WRAP_SIG_REQUIRED` is on, so it is never
"fixed unconditionally".
