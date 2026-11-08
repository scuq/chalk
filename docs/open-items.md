# Open items

What is **not** done. Shipped history lives in [phase-log.md](phase-log.md)
(engineering) and [../CHANGELOG.md](../CHANGELOG.md) (user-facing); this file
is the authority on what is still open, and `CLAUDE.md` points here rather than
carrying it.

Latest release: **v0.10.3** — keep this in step with the topmost `## vX.Y.Z`
heading in `CHANGELOG.md`. The `/release` skill updates it as part of cutting a
release. A stale pointer is worse than none, because it still reads as current.

Phase 133 is the newest work. It is built, with the voice room, and seven
points of it are open.
Phase 131 has two small open points.
Phase 130 has two open points. The phase-doc index at the top of
[phase-log.md](phase-log.md) is the complete list of what exists and which
phases are *planned, not started*.

## Phase 133 — polish: built, with seven open points

133-1 … 133-12 are built, record in
[phases/PHASE-133-POLISH.md](phases/PHASE-133-POLISH.md). The phase closed at
133-7 and reopened for the voice room. The voice room slices are built: an
adaptive stage, the scratchpad, a scenario sweep, and a measured height for
the camera grid, so that every participant stays visible. This closed the
deferred item about a four-tile call in a short window. 133-8 merged the tile list of the
stage into `railTiles`, which closed the stage-memo point of phase 131.
The shell has semantic tokens, a raised sidebar and channel header, one look
for hover, selected, unread, and focus, a one-row composer with a filled send
button, and a themed empty state. The sweep of 133-7 checked 15 themes on a
desktop and the green theme on a phone. Every change is in the client.

- **The "no channel open" screen was not seen in a browser.** A new account
  opens in the Parking Lot.
- **The composer of the thread pane was not seen in a browser.** It is
  narrower than the main one, and it must fit all four tools.
- **After a live resize from a phone width to a desktop width, the header
  measures 59px and not 56px.** A reload restores 56px. 133 does not cause it,
  and it is not investigated.
- **The channel header band stops 8px short of the scrollbar lane.**
  133-3 left it as it is.
- **The manual checklist in the phase doc is still open.**
- **The speaking highlight with five people was not seen.** It was seen with
  two people.
- **A voice room of more than five people was not swept.**

## Phase 131 — call rail: built, with two open points

131-1 … 131-11, record in [phases/PHASE-131-CALLRAIL.md](phases/PHASE-131-CALLRAIL.md).
In a call on a desktop, a 48 px column left of the sidebar is present for the
whole call. It carries the duration at its head, and microphone, headphones,
camera, share, settings, and leave at its foot. It shows one tile for each
participant and each screen share only while the call room is not the channel
on screen. The footer bar and the voice dock box render on the phone only, and
the sidebar runs to the bottom of the window. The sidebar lists no names under
the voice rooms, and a hover card on the row shows them. A voice room with
people in it shows a red record light. Every change is in the client. The live
probe ran on 2026-11-08 after 131-7, and all 25 checks passed. The manual
checklist in the phase doc is still open.

- **The phone list has no deafened state.** The rail and the room card show it.
- **The phone drawer has no name list and no hover.** The drawer reuses the
  sidebar and touch has no hover. Zuckermode keeps its own list, and the stage
  shows the names once you join.

## Phase 130 — guest flow: built, with two open points

130-1 … 130-4, record in [phases/PHASE-130-GUESTFLOW.md](phases/PHASE-130-GUESTFLOW.md).
A member can open a temporary room alone from a `+` on the voice section of
the sidebar, and the guest links are one click away in the header of the room.
Every change is in the client.

- **The phone list has no quick-create `+` yet.** Its voice rooms sit behind a
  collapsed row, and the list has no section header to carry the button.
- **A member who is not the creator was not probed for the absence of the
  header button.** The condition is the expression that the members panel used
  before this phase.

## Phase 129 — seasonal: COMPLETE, with recorded trade-offs

129-1 … 129-14, record in [phases/PHASE-129-SEASONAL.md](phases/PHASE-129-SEASONAL.md).
An animated pixel scene peeks into the middle of the top header. Each of
eight seasons has five scenes that change every 35 s. A gap of 21 days in a
common year separates two seasons, and a date in a gap shows five neutral
scenes (129-12). On the evening of 24 December and on New Year's Eve, the
scene stays up from 20:00 to 05:00. There is a switch per device and a server
switch on the admin settings tab. A visit comes at most 16 times in a local day
on one device, and at most 10 of them start before 18:00 (129-7, 129-9).
A phone in zuckermode shows the scene in a row above the conversation list
(129-11). The classic phone layout and the header of a phone show no scene.
No slice is open.

- **A change by an administrator reaches other clients on their next page
  load.** `GET /api/auth/config` is cached with `max-age=60`, so the delay is
  one minute at most. A `welcome` payload field or a WebSocket broadcast is the
  fix if it grates.
- **The cap on visits is for a device and a local day.** A person with two
  devices gets 16 visits on each. Clearing `chalk.season.visits.v1` from
  localStorage gives visits again.
- **The date check runs once a minute.** A tab can show the scene of the old
  season for up to one minute after midnight changes the season.
- **The header of a phone shows no scene, and neither does the classic phone
  layout.** At 390 px only about 30 px of the header middle remains. A second
  header row would change the header height. This holds in the always-on hours
  too. Only zuckermode has a scene on a phone, in the row of 129-11.
- **A phone in zuckermode gets fewer visits.** Only the list screen claims a
  visit, so a user who stays in a conversation gets fewer. A visit that the
  user leaves by opening a conversation still counts.
- **The row moves the list.** When the row opens or closes, the rows below it
  move by 48 px over 1.2 s. A tap in that moment can land on a different row.
  This is the accepted cost of a row that goes away.
- **The always-on hours run a 12 fps loop for nine hours** while the tab is
  visible. `requestAnimationFrame` pauses in a hidden tab.
- **The what's-new entry of phase 129 was rewritten in place.** A person who
  already marked it as read does not see the new text.
- **The calendar and the always-on hours are for the Northern Hemisphere.**
  chalk reads only the local date.

## Phase 116 — what's new: COMPLETE, with one hand step at release time

116-1 … 116-2, record in [phases/PHASE-116-WHATSNEW.md](phases/PHASE-116-WHATSNEW.md).
The picture ask's timer fix, and the per-phase what's-new note with its
stored "read" tick. Verified on a live stack (12 checks).

- **`WHATS_NEW` in `web/src/whats-new.ts` is pruned by hand.** It should hold
  the last release or two; when cutting a release, drop entries older than
  that. The `/release` skill does not remind you yet.

## Phase 115 — flair: COMPLETE, with two recorded trade-offs

115-1 … 115-6, record in [phases/PHASE-115-FLAIR.md](phases/PHASE-115-FLAIR.md).
The animated mode, off by default: flame, wave, avatar frames, banner drift.
Unit-tested per slice, the server slice end to end against a database, and
the whole thing verified on a live stack (31 checks, including reduced
motion).

- **A changed frame reaches other people on their next reconnect or reload,
  not live.** It rides the user directory, like a display name, and there is
  no push for it. Recorded as accepted in the phase doc; a `profile_changed`
  push is the fix if it ever grates.
- **Frames are drawn on the `<img>` itself** (outline and box-shadow), so a
  call tile's circular picture gets a circular ring for free but the feed's
  one-line avatar gets none by rule. Also recorded there.
- **The animated avatar frames run without end.** With flair on, the frames
  ember, aurora, gold, matrix, frost, and pulse animate on your own avatar in
  the header on every screen, and on the avatars of online friends in the
  sidebar. The rules are the `html[data-flair*]` frame selectors in
  `web/src/theme.css`. Several animate `box-shadow`, `outline`, or `filter`,
  and these repaint at every frame. This is the same cost class as the 53-6
  parking drift. The cost is not measured yet.

## Phase 114 — roster order: COMPLETE, with two recorded trade-offs

114-1 … 114-6, record in [phases/PHASE-114-ROSTERORDER.md](phases/PHASE-114-ROSTERORDER.md).
Channels within a group by creation, by activity or by hand; groups by hand;
the menus on every device and drag-and-drop on the desktop. All of it lives in
`prefs.roster`, with no wire or schema change. Since 114-5 the default sort is
the newest message first, and an account that stored `created` keeps it.
Since 114-6 the channel list holds its order while the mouse pointer is over it.

- **A keyboard action that hides or moves a channel keeps the held order.**
  If the pointer stays in the list, the order stays until the next pointer
  leave (114-6).

- **Hiding a channel drops it from its group's hand-written order** on the next
  write, and un-hiding appends it at the bottom. That is the phase's own rule
  ("the write side never lets a list grow") costing the reader something; the
  fix, if it grates, is to prune against membership rather than visibility.
- **Read the phase's 8 KiB note before adding anything else to
  `prefs.roster`.** `prefs_set` caps a patch at 8 KiB, every roster write
  ships the whole roster object, and this phase is what put *lists* in there.
  The write path prunes and size-checks; a new key should not assume room.

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

- **Guest sends are unsigned** (render `(unsigned)`; since 80-17 a guest
  opens signed envelopes on receive), and a guest cannot
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
- **122-2 is conditional on a Windows report.** 122-1 makes a mic that will
  not open a visible, retried, logged failure (`mic capture (...)` lines in
  the voice diagnostics). If the desktop app on Windows *still* needs a
  restart before a hot-plugged mic opens, and the report shows
  `OverconstrainedError` or `landed=<old>` on every try for a device the
  picker lists, the renderer has done what it can and the cause is the
  Electron audio service; the candidate is a win32-only
  `disable-features=AudioServiceSandbox` switch in `desktop/src/main.ts`,
  to be tried on that machine, not assumed. Record in
  [phases/PHASE-122-MICSWAP.md](phases/PHASE-122-MICSWAP.md).
- The client's windowed attachment backfill (App.tsx `listAttachments` effect,
  `GET /api/attachments`, `CHALK_ATTACH_FETCH_WINDOW_HOURS`) is redundant since
  fetch_history started carrying attachment refs on the page itself; drop the
  effect, the endpoint, the `ListAttachmentsForChannelWindow` query and the env
  knob together.
- `docker/Dockerfile`'s frontend stage runs `npm run build` without
  `NODE_ENV=production`, so released images ship unminified bundles with inline
  sourcemaps. Costlier since 52-2 (the MediaPipe chunk is 153 KB minified vs
  737 KB as shipped).
- Phase 128 left five items open on purpose:
  - Preact 10.29.8 to 11.1.1 (major release, its own phase).
  - `gcr.io/distroless/static-debian13` (no security driver).
  - Node 26 as the build image (wait for patch releases).
  - The `test/e2e` suite (its specs predate auth v2).
  - Five moderate `npm audit` findings in `desktop/` under `@electron/packager` (old `glob` and `minimatch`).

  Reasons are in the Deferred section of
  [phases/PHASE-128-TOOLCHAIN.md](phases/PHASE-128-TOOLCHAIN.md).
