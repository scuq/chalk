# Open items

What is **not** done. Shipped history lives in [phase-log.md](phase-log.md)
(engineering) and [../CHANGELOG.md](../CHANGELOG.md) (user-facing); this file
is the authority on what is still open, and `CLAUDE.md` points here rather than
carrying it.

Latest release: **v0.8.12** — keep this in step with the topmost `## vX.Y.Z`
heading in `CHANGELOG.md`. The `/release` skill updates it as part of cutting a
release. A stale pointer is worse than none, because it still reads as current.

Phase 110 is the newest work. The phase-doc index at the top of
[phase-log.md](phase-log.md) is the complete list of what exists and which
phases are *planned, not started*.

## Phase 106 — channel names: built, awaiting the live-stack checklist

106-1 … 106-3, record in [phases/PHASE-106-CHANNELNAMES.md](phases/PHASE-106-CHANNELNAMES.md).
Two items stay open there:

- **A democratic channel cannot be renamed.** `update_channel` is owner-only
  and answers `unilateral_forbidden` in democratic mode; the `rename`
  proposal type is not built.
- **The live-stack checklist** at the end of the phase doc — the store's
  rename path has no DB-backed test, so the migration and the push to every
  member are only proven against a running stack.

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

## Phase 83 — signed sealed envelopes: COMPLETE, with recorded caveats

83-1 … 83-8, record in [phases/PHASE-83-MSGSIG.md](phases/PHASE-83-MSGSIG.md)
(the trust-model revision, the six-revision review series with Gate 0 opened
on the R20-conditioned pass, and a per-slice record of every decision).
Under the revised model — chalkd honest, the host untrusted for persistent
storage, MITM-toward-home detectable — the phase delivers: signed sealed
envelopes for messages, edits and reactions with fail-closed typed verdicts;
append-only edit revisions with client-verified chains; identity generations
linked by signed certs; atomic first-responder key rotation with the
`rotation_required` send gate; the server-identity pin with the inner sealed
channel and re-pin wall; and D.6's client-observed roster notices with the
frozen diff-before-reshare ordering. Closed 2026-08-23 after a 16/16
full-stack smoke run.

Caveats that remain open (all in the phase doc's slice record):

- **Guest sends are unsigned** (render `(unsigned)`), and a guest cannot
  clear the rotation gate — a member's next send does.
- **Edit envelopes re-sign text only**; attachment bindings stay anchored in
  the original envelope through the revision chain.
- **Reactions are not rotation-gated** (an emoji re-sealed under the old key
  in the due window is an accepted residual).
- **The user-facing phrase-rotation flow is not built** — 83-4 shipped the
  primitive (`publishRotatedIdentity`) and all verification, but nothing
  calls it in production yet: rotating means a new phrase, re-wrapping every
  channel key and the auth seed. Its own phase when wanted.
- `proto.MinSigningBuild` is pinned to `v0.8.0` — the release that ships
  phase 83 must actually get that tag, or the constant needs the one-line
  fix before cutting it.

Phase 98 (big rooms) stays gated: it was sketched against fanout's
membership layer and needs a re-sketch against this design, then its own
review, before any code.

## Phase 85 — operational logging

Shipped (85-1 … 85-4, record in [phases/PHASE-85-OPLOG.md](phases/PHASE-85-OPLOG.md)),
with two items left at the end of that record: the live-stack run of the
connection snapshot, and the missing off switch for Caddy's access log.

## Phase 104 — the desktop app: released in v0.8.3, Windows in v0.8.5

An Electron shell around the server's own page, record in
[phases/PHASE-104-DESKTOP.md](phases/PHASE-104-DESKTOP.md). All four slices
are in: window + server picker + link routing + permission policy +
screen-share chooser, tray and close-to-tray, the OS idle clock as the
presence source, packaging + the `desktop` release job + the update notice.
Verified on Linux against the dev stack and the packaged binary. v0.8.3
was the first tag to run the desktop job: Linux and macOS archives and the
signed `SHA256SUMS.desktop` published; the Windows job failed on the
runner's GNU tar (fixed for v0.8.4), then on a Unix-only execute-bit
assertion in the tests (fixed for v0.8.5, the first tag whose Windows job
can reach packaging). Open:

- **One-click self-update (phase 105) is built** — signed sums and the
  verifier, the side-by-side updater on all three platforms, preferences,
  check-now, resume after a quit, rollback. The release key is made and
  pinned; the first signed release is the next tag. Not yet exercised on a
  real Mac or Windows box; the phase's own checklist says what to try first.
  The Windows shortcut retarget has not been run by hand.
- Windows needs the signing secrets set once (`tools/make-signing-cert.sh`;
  not set as of 2026-08-25) or the exes ship unsigned; macOS is unsigned/ad-hoc (right-click → Open);
  macOS passkeys need a native module; Linux reports no screen lock; GNOME
  shows no tray without an AppIndicator extension.
- The 104-1…3 manual lists in the phase doc have only been run on Linux.
- 104-5 (2026-08-26) fixed the shell staying *away* after a Mac slept —
  `locked` is derived per read instead of latched — from source reading
  alone; the phase doc's 104-5 checklist is the confirmation on a real
  Mac, and its log lines are what to read if it recurs.
- 104-6 (2026-08-29): the pop-out call window froze the shell (Electron has
  no Document Picture-in-Picture; the feature is now switched off so the
  page takes its plain pop-up path) — reproduced and fixed with the
  Playwright-Electron probe on Linux; the shaped-window part is unverified
  in a real call on macOS/Windows.
- 104-7 (2026-08-29): pop-outs are top-level windows (no `parent`), so a
  Mac can keep one on a second display — the two-screen check in the phase
  doc is still to run.

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
  hover connector. Still open, but read its 9 August 2026 note first: phase 107
  shipped quoting, so the document's framing as *the alternative to* quoting is
  out of date. What a tie does that a quote cannot — point at a message too far
  back to reprint — is unchanged, and is the reason it is still on this list.
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
- **A four-tile call does not fit a window under ~850px tall.** 45-8 stopped
  the scratchpad stealing the call's height and stopped the control bar being
  painted over the video, but the tiles still cannot shrink with the stage —
  `aspect-ratio` sizes them from their width — so what does not fit is now
  cropped: 43px off the bottom at 1440×800, 88px at 1440×700. Fix is to cap
  `.chalk-voice-grid`'s `max-width` from the height the pane can spare, which
  scales all four tiles whole; it needs a hand-measured constant for the rest
  of the pane (~390px), which is why it was deferred. Numbers and the rejected
  alternatives are in `docs/phases/PHASE-45-SCRATCHPAD.md`.
- `docker/Dockerfile`'s frontend stage runs `npm run build` without
  `NODE_ENV=production`, so released images ship unminified bundles with inline
  sourcemaps. Costlier since 52-2 (the MediaPipe chunk is 153 KB minified vs
  737 KB as shipped).
