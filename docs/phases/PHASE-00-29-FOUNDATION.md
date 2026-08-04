# Phases 00–29 — foundation, the MLS detour, and the encryption rebuild

*Backfilled record.* Reconstructed after the fact from the git history,
migrations 0001–0037 and the code. It covers everything before phase 30 in one
file because the pre-30 numbering is an archaeology problem, not a feature index:
some phases shipped under other names, one shipped and was deleted, and four
never happened at all.

**Status:** all shipped work here is live except where marked removed.
**Companion:** `docs/phase-log.md` keeps the original per-phase bootstrap
entries in their contemporaneous *delivers / tests* shape. This file is the
as-built pass over the same ground, and where the two disagree, this one was
checked against the code.

## Why this record exists

The pre-30 entries in the phase log were written as a **plan** and never fully
reconciled with what happened. Three kinds of drift accumulated:

- **11c shipped and was then deleted.** The log still lists it as planned.
- **12, 13, 14 and 15 never shipped as specified.** Two were superseded by work
  under different names; two are simply open.
- **22–25 landed as unnamed commits.** Their entire commit history is `.`, so
  the migrations and the code are the only evidence of what they were.

Anyone reading the log alone would conclude chalk has account-deletion frames
and a Prometheus endpoint, and does not have channel encryption. None of that
is true.

## The eras

### 00–08 — the bootstrap (migrations 0001–0010)

Repo scaffolding and a working relay, built as numbered bootstrap phases with a
test gate each:

- **00–02** — scaffolding, the Go skeleton (`cmd/chalkd`, `internal/version`,
  `internal/config`), and the container story (multi-stage build, distroless
  final, dev/test/prod compose stacks).
- **03** — Postgres: pgx pool, embedded migration runner, the first schema
  (users, devices, channels, messages).
- **04** — the WebSocket relay: `internal/server/ws.go`, a hub keyed by device,
  ping/pong, and wire protocol v0 (`hello` / `welcome` / `send` / `message`),
  plaintext.
- **05** — `internal/pubsub`: NOTIFY publisher plus a dedicated LISTEN
  connection, so two chalkd instances fan out to each other.
- **06** — presence and friendships (migrations 0006–0008): multi-device
  presence aggregation with TTL and a janitor, friend request/accept, and the
  account-lifecycle **schema**. The lifecycle *write paths* were deferred to
  phase 12 — see [never shipped](#what-never-shipped).
- **07** — the SPA shell: Preact + TypeScript on esbuild, the green-on-black
  theme, bundled Hack, and `embed.go` serving the built bundle from the binary.
- **08 / 08b / 08c** — channels: per-channel pubsub topics with dynamic LISTEN
  refcounting, the DM cardinality trigger, `fetch_history` with a `before_seq`
  cursor, echo suppression, then the SPA side (sidebar, friend picker,
  optimistic append) and handles everywhere.

### 09 — auth, invites, admin (migrations 0011–0019)

Shipped as 09a–09d: multi-tab connections keyed by user rather than device;
WebAuthn passkeys with 24-word recovery codes and server-side sessions;
invite-based registration, profile and email-change; then admin moderation —
block / unblock / soft-delete / purge, an email blacklist, and migration 0019's
`admin_delete_guard` triggers that refuse role changes and direct deletes on
admin rows.

Phases **9.5** and **9.7f–9.7m** follow as UI work under their own numbering:
per-user nick colours (hue-based, so they survive theme switches), the emoji
picker, composer tool rows, message-row alignment, and the first extra themes.
This is where chalk's message layout took its current shape.

### 11a–11c — the MLS detour, built and removed (migrations 0021–0025)

chalk's first attempt at end-to-end encryption used **MLS** via
`@wireapp/core-crypto` (WASM, in a worker).

- **11a** — KeyPackage infrastructure: publish/fetch frames, consumption under
  `FOR UPDATE SKIP LOCKED`, refill thresholds. **This is why chalk relicensed
  from MIT to GPL-3.0-or-later** — core-crypto's terms.
- **11b** — MLS DM encryption, send then receive, with six documented
  stabilization hotfixes about CoreCrypto's API and observer ordering.
- **11c** — multi-member channel encryption, which the phase log still lists as
  planned. It **shipped**, across 11c-1 … 11c-10: `mls_commits`, buffered
  Welcomes for offline recipients with TTL eviction, a catch-up-on-reconnect
  dispatcher, member-management UI, split-brain group guards, an
  encrypted-at-rest plaintext cache for reload survival, and an orphaned-
  KeyPackage sweep.
- **11d** — multi-device and history transfer: designed across seven documents
  and never implemented. The docs were pruned during the rip-out.

The detour ended because the complexity was not paying for itself at chalk's
scale: group state that could split-brain, a creator who could not recover from
lost local state (recorded as a known limitation at 11c-6), a WASM dependency
pinned to an exact version, and a licence change forced by it.

### 21 — the rip-out (migrations 0026–0030)

MLS removed wholesale, in seven slices, returning the codebase to a plaintext
baseline **on purpose** before rebuilding: the client module and the
core-crypto dependency, the server handlers and sweeps, the wire types on both
sides, and the tables. Then the *concept* went too — 21-7 dropped
`messages.content_type`, `messages.mls_epoch` and `channels.is_mls`, and renamed
`messages.ciphertext` → `messages.body`, because a dormant encryption seam that
encrypts nothing is worse than an honest plaintext relay.

Housekeeping in the same arc: stale design docs pruned, and Go filenames
de-phased (`*_phaseNN.go` merged into `frames.go` / `ws.go` / `hub.go`).

With core-crypto gone the GPL obligation went with it, and chalk relicensed
again — **GPL-3.0-or-later → BSD-3-Clause**, where it remains.

### 22–25 — the encryption rebuild (migrations 0031–0035)

The current crypto design, and the one everything since builds on. These landed
as unnamed commits, so the migrations and `web/src/crypto/` are the record:

- **22 — identity keys** (0031). X25519 + Ed25519 derived client-side from a
  24-word BIP-39 phrase using native WebCrypto, one active `identity_keys` row
  per user with a `generation` column and a self-signature. No WASM, no
  dependency.
- **23 — space keys and real message encryption** (0032). Per-channel keys,
  AES-256-GCM message encryption, suite-tagged wrap and message formats for
  crypto agility (`web/src/crypto/spacekey.ts`), and the server returned to
  being a blind relay. **chalk is end-to-end encrypted from here on.**
- **24 — picture-word verification.** Safety numbers rendered as word/picture
  pairs, so two people can compare identities out of band. Client-only — it has
  no migration, which is why it leaves no schema trace.
- **25 — key rotation and membership lifecycle** (0033, 0034). Creator-minted
  space-key rotation with monotonic versions and a pending-rotation table; add,
  remove (rotate-on-removal plus wrap scrub), leave and re-add, all forward-only.

Migration 0035 adds message deletion — owner-only at first, the prerequisite
that governance then generalised.

### Governance, attachments, multi-device (migrations 0036–0037)

Three arcs with their own slice letters rather than phase numbers:

- **gov-1a … gov-2-2** — per-channel `governance_mode` (dictator | democratic)
  and a generic proposal → vote → resolve → action engine. Proposal types:
  `remove_member`, `add_member`, `delete_message`, `set_mode`. The tally is
  deliberately hard to game: frozen eligibility snapshot, turnout quorum plus
  majority-of-voters, target exclusion, a supermajority requirement for
  `set_mode → dictator` that reverts to the original creator, re-propose
  cooldown, mandatory expiry, and resolve-on-certainty.
- **att-1 … att-4c** — attachments: a partitioned table, chunked HTTP upload and
  download (the 1 MiB WS frame cap forces it off the socket), encrypted blobs
  *and* encrypted metadata so the server sees only sizes, client-side downscaled
  encrypted previews, and an LRU ciphertext cache in IndexedDB cleared on
  logout. Giphy arrives by URL reference with tri-state per-user consent, a host
  allowlist and a server-proxied search.
- **md-1 … md-7** — multi-device by **shared identity key**: a second device
  re-enters the phrase, derives the same keypair, and verifies the derived key
  matches the published one before persisting, so a divergent-identity fork is
  impossible. Plus self-echo to a user's other devices, passkey enrollment after
  a recovery login, and passkey deletion behind a last-passkey guard. There is
  no per-device revocation; the remedy is identity rotation.

### ops-1 / ops-3+7 — where chalkctl comes from

Before phase 72 gave it backup and restore, `chalkctl` was born here: two
release trains (`v*` for the image, `ctl-v*` for the binary, both cosign-signed,
later unified into one tag), then a self-installing `init` with embedded
templates, key=value config, a cosign verify seam and rootful podman bring-up —
followed by the run of deployment fixes that Quadlet and PG18 forced (env-var
composition collapsing, the PGDATA path move, coturn reading a config file
rather than Exec args).

## What never shipped

Corrections to the phase log's forward-looking entries, each verified against
the code:

| Phase | Log says | Actually |
| --- | --- | --- |
| 11c | planned | **Shipped** (11c-1 … 11c-10), then removed by 21 |
| 11d | designed | Correct — designed only; docs pruned in 21 |
| 12 — lifecycle | will deliver deactivate/delete/reactivate | **Never built.** No such frames exist. Phase 06's lifecycle schema is still read-only |
| 13 — blobs | will deliver a blobs table and upload endpoint | **Superseded** by the attachments arc (att-1 … att-4, migration 0037), which solved it differently |
| 14 — hardening | rate limits, quotas, `/metrics` | **Partly, elsewhere.** Rate limiting arrived in phase 81 (`internal/ratelimit`); server metrics became `chalkctl metrics` in 73, reading Postgres' own statistics views. There is no `/metrics` endpoint and no Prometheus |
| 15 — cross-browser | Playwright matrix | **Partly.** `test/e2e/` exists with a Playwright config and five specs (smoke, channels, multitab, admin, mobile); the full engine × viewport matrix was never stood up. `docs/browser-support.md` carries the support statement |

## Migration map

The fastest way to date any pre-30 change:

| Migrations | Arc |
| --- | --- |
| 0001–0005 | bootstrap schema (03/04) |
| 0006–0008 | presence, friendships, lifecycle schema (06) |
| 0009–0010 | channels and members (08) |
| 0011–0014 | passkeys, sessions, recovery codes (09b) |
| 0015–0018 | devices link, invites, admin bootstrap, blacklist (09c) |
| 0019 | admin lifecycle columns and guard triggers (09d) |
| 0020 | user preferences |
| 0021–0025 | MLS (11a–11c) |
| 0026–0030 | the MLS rip-out (21) |
| 0031–0034 | identity keys, space keys, key version, rotation (22–25) |
| 0035 | message deletion |
| 0036 | governance |
| 0037 | attachments |
| 0038–0039 | voice and the signal spool (30) |

## Licence history

MIT → **GPL-3.0-or-later** at 11a (forced by `@wireapp/core-crypto`) →
**BSD-3-Clause** after 21 removed it. Commits keep the terms they were made
under.

## Notes

- Phases 10, 16–20 and 26–29 do not exist. The 11-series absorbed "10 MLS",
  and the rest are gaps left by renumbering — `docs/phase-log.md`'s numbering
  note has the detail.
- 9.5 and 9.7f–9.7m are UI phases under a decimal scheme that was abandoned
  afterwards; nothing later uses it.
- The unnamed `.` commits covering 22–25 are why this era has no slice list.
  If precision is ever needed, `git log --stat` around migrations 0031–0035 is
  the way in.
