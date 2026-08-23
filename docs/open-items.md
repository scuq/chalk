# Open items

What is **not** done. Shipped history lives in [phase-log.md](phase-log.md)
(engineering) and [../CHANGELOG.md](../CHANGELOG.md) (user-facing); this file
is the authority on what is still open, and `CLAUDE.md` points here rather than
carrying it.

Latest release: **v0.7.10** — keep this in step with the topmost `## vX.Y.Z`
heading in `CHANGELOG.md`. The `/release` skill updates it as part of cutting a
release. A stale pointer is worse than none, because it still reads as current.

Phase 94 is the newest work. The phase-doc index at the top of
[phase-log.md](phase-log.md) is the complete list of what exists and which
phases are *planned, not started*.

## Phase 82 — signed channel-key wraps: COMPLETE, but conditionally

82-1 … 82-10, record in [phases/PHASE-82-SIGNEDWRAP.md](phases/PHASE-82-SIGNEDWRAP.md).

It closes the phase-81 audit's C-01 **only where `CHALK_WRAP_SIG_REQUIRED` is
on**. Since 82-10 it defaults to true, so new deployments are covered — but
`chalkctl update` preserves an existing `false`, so a deployment predating phase
82 keeps its migration window until its operator runs `chalkctl wrapsig enable`
(after `chalkctl wrapsig status` says READY). Until then a server can still
substitute a key on a channel no current-build member has opened. **Never
describe C-01 as fixed unconditionally.**

Two follow-ups remain open:

- The **end-to-end run against a live stack** (checklist at the end of the phase
  doc) — the only exercise of the real Postgres upsert guard, and worth doing
  before a release carries this.
- The guest path: links minted before 82-7 stay unsigned until they expire.

## Phase 83 — sender signing, redesigned under the revised trust model

**The trust model was revised by scuq on 2026-08-09** — chalkd is
trusted to run the protocol honestly; the *host* it runs on is not (no
stored state may yield already-sent messages); and a client must be
able to detect a MITM toward its registered home server. The
malicious-server claim was dropped: the envelope-fanout design
(twelve revisions, ten internal reads, six external reviews — the
audit series in [audits/](audits/), final text at git `731eac5`)
established that its last gap, membership branch uniqueness against an
equivocating server, is closable only with quorum certificates or
witness infrastructure (P83-A-R15-01). Rather than adopt consensus
machinery or ship a half-claim, the claim went.

The new plan in [phases/PHASE-83-MSGSIG.md](phases/PHASE-83-MSGSIG.md)
(**in progress** — slices 83-1 … 83-6 landed 2026-08-09 after the
R20 review conditioned Gate 0 PASS on four items, all in the sixth
revision; slices 83-7 … 83-8 remain, plus the caveats recorded in
the slice record: guest sends are still unsigned and cannot clear
the rotation gate, edit envelopes re-sign text only, reactions are
not gated, and the user-facing phrase-rotation flow behind 83-4's
rotation primitive is not built) is deliberately small:

- **Signed sealed envelopes** — the phase-81 audit's H-01, still real:
  a canonical Ed25519-signed envelope (messages, edits, reactions)
  inside the existing space-key encryption, verified fail-closed
  against pinned identities, with the fanout series' hard-won lessons
  kept: uniform replay triple in every object type, the signing
  generation sealed in the canonical, append-only edit revisions.
- **First-responder rotation** — on any membership shrink the next
  sender mints the new key with phase 82's signed wraps; no owner
  role, no freeze, works identically for 2-, 3- and 64-member
  channels.
- **The server pin** — server identity pinned at registration, an
  inner sealed channel over the WebSocket so a TLS-terminating MITM
  can neither read nor modify frames against the pin; bundle-serving
  MITM stated as the endpoint-compromise limit it is.

Membership stays server-asserted **by design** — an accepted, visible
property of the trust model, no longer an unmet guarantee
([threat-model.md](threat-model.md) carries the full statement). The
R18 review then caught that claim 2 as first written ("host may modify
persistent data") contradicted exactly that: a database write into a
roster would make honest clients wrap keys to an intruder. The claim
was **lowered** — host compromise is defended for *reads*; writing the
authorization tables is a real, stated, undefended threat — and two
mitigations were commissioned: D.6's client-derived roster-change
notices (a persisted membership change — a pure database insert
included — is surfaced at the next roster observation, before any
auto-reshare wraps to it) and phase 99's credential hardening (below).
The R19 review then caught the last mismatch: claim 2 still allowed
reading chalkd's *process memory*, where the server-identity key
lives — and its holder is the server to every pinned client. Final
form: **claim 2 is a persistent-storage breach claim** (dumps, disks,
backups open nothing); live process compromise, like
authorization-table writes, is a lost trusted endpoint. The R20 final
pass confirmed every protocol area green and conditioned Gate 0 PASS
on four claim/documentation items — all four are applied (the last
two: the "Server-storage disclosure" rename and D.6's guarantee in
the reviewer's exact words). **The gate awaits the reviewer's PASS
confirmation, nothing else.**
Phase 98 (big rooms) was gated on fanout's membership layer and needs
a re-sketch against this design before its own review.

## Phase 85 — operational logging

Shipped (85-1 … 85-4, record in [phases/PHASE-85-OPLOG.md](phases/PHASE-85-OPLOG.md)),
with two items left at the end of that record: the live-stack run of the
connection snapshot, and the missing off switch for Caddy's access log.

## Phase 93-3 — the resizable thread pane: designed, not started

The thread pane's edge as a drag handle, width stored per device in
`display-prefs.ts`, design at the end of the slice section in
[phases/PHASE-93-WIDTH.md](phases/PHASE-93-WIDTH.md). It copies 33-4's
interaction but deliberately not its storage, and the design records a live
hazard it must fix on the way in: a second `useDisplayPrefs` mount in one tab
clobbers the first instance's fields, because `update()` merges onto its own
`prev` and persists the whole object. Read the design before building it; three
questions in it are scuq's to answer.

## Next candidates, none started

Each is fully planned in its own doc; read it before designing anything in the
same space.

- **Web push notifications** (65, [phases/PHASE-65-PUSH.md](phases/PHASE-65-PUSH.md)):
  hand-rolled `internal/webpush`, DMs-only default, content-free payloads.
- **Ties** (86, [phases/PHASE-86-TIES.md](phases/PHASE-86-TIES.md)): say "this
  answers that" across an interleaved channel without quoting — a sealed
  per-user side record on the reactions pattern, drawn as a gutter mark plus a
  hover connector.
- **Message reminders** (87, [phases/PHASE-87-REMINDERS.md](phases/PHASE-87-REMINDERS.md)):
  bring one message back later — 1h/24h/weekend/custom from the row menu, a
  badged Reminders entry above the parking lot, the whole set in a sealed prefs
  blob so the server never learns a reminder exists, and no server code at all.
- **A local idle agent** (90, [phases/PHASE-90-IDLEEXT.md](phases/PHASE-90-IDLEEXT.md)).
- **Large rooms** (98, [phases/PHASE-98-BIGROOMS.md](phases/PHASE-98-BIGROOMS.md)):
  per-sender streams for rooms past the 64 cap — **stale since the
  2026-08-09 trust-model revision** (it was sketched against fanout's
  membership layer); needs a re-sketch against the new phase 83, then
  its own review, before any code.
- **The SFU seam** (voice design Slice I) for rooms too large for a mesh.
- **Governance `set_config` proposals.**
- **Database-credential hardening** (99, [phases/PHASE-99-DBCREDS.md](phases/PHASE-99-DBCREDS.md)):
  move the DB secrets out of the env file and `/proc/environ` into
  encrypted systemd credentials (or eliminate the app password via
  peer auth — the phase's first question), zeroize in-memory copies,
  one-command rotation. Commissioned as the R18 mitigation alongside
  phase 83's D.6 roster notices.

Two deliberate exclusions:

- The hover card's **device line** (92-3) is designed and deliberately
  unbuilt: showing a friend which device you are online from crosses a privacy
  line `AggregateUserState` currently draws for us, so it needs an opt-in before
  it ships. Reasoning in
  [phases/PHASE-92-HOVERCARD.md](phases/PHASE-92-HOVERCARD.md).
- **Federation is not a candidate.** Phase 88
  ([phases/PHASE-88-FEDERATION.md](phases/PHASE-88-FEDERATION.md)) is a declined
  design, not a plan awaiting a builder, gated on 83 if it is ever reconsidered.
  Read it before re-proposing the idea — it also records what already works
  across deployments without any of it.

## Deferred cleanup, all verified still open

- `RegisterFromInviteScreen` still registers passkey-first
  (`navigator.credentials.create()`), out of step with the auth-v2 password +
  TOTP flow every other entry point uses.
- `auth_backup_code` is dormant: migration 0040 creates it and
  `store/auth_v2.go` has `ReplaceBackupCodes` / `ConsumeBackupCode` /
  `CountUnusedBackupCodes`, with no caller anywhere. Drop table + funcs.
- The threads dot's server total is only re-synced on a debounced refetch;
  threads whose inbox rows this client doesn't hold still lag until then
  (`threadsNeedingYouCount` corrects only held rows).
- The camera choice (`device-prefs.ts` cameraId) has the same stale-id weakness
  the mic had before 63-3 (Brave re-randomizes deviceIds per session;
  late-plugged devices unmatched). Fix the same way: persist the label, resolve
  via `voice/device-resolve.ts` at capture time.
- The client's windowed attachment backfill (App.tsx `listAttachments` effect,
  `GET /api/attachments`, `CHALK_ATTACH_FETCH_WINDOW_HOURS`) is redundant since
  fetch_history started carrying attachment refs on the page itself; drop the
  effect, the endpoint, the `ListAttachmentsForChannelWindow` query and the env
  knob together.
- **Zuckermode has no reachable "leave call" control.** The only leave button
  is the voice dock's (`voice-dock-leave`), the dock renders inside the
  sidebar, and Zuckermode hides the sidebar and its nav toggle outright
  (`.chalk-app--zucker .chalk-nav-toggle { display: none }`). So a phone in
  that mode can join a room and has nothing to press to get out — the mic and
  camera toggles are there, the exit is not. Found while probing 95-1, which
  did not cause it: the controls band never carried a leave button either.
  Verified in the running app, and the last check in the 95 probe records it.
- `docker/Dockerfile`'s frontend stage runs `npm run build` without
  `NODE_ENV=production`, so released images ship unminified bundles with inline
  sourcemaps. Costlier since 52-2 (the MediaPipe chunk is 153 KB minified vs
  737 KB as shipped).
