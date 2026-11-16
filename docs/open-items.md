# Open items

What is **not** done. Shipped history lives in [phase-log.md](phase-log.md)
(engineering) and [../CHANGELOG.md](../CHANGELOG.md) (user-facing); this file
is the authority on what is still open, and `CLAUDE.md` points here rather than
carrying it.

Latest release: **v0.12.4** — keep this in step with the topmost `## vX.Y.Z`
heading in `CHANGELOG.md`. The `/release` skill updates it as part of cutting a
release. A stale pointer is worse than none, because it still reads as current.

Phase 137 is the newest work. It is built, with all twelve slices, and the device checks are open.
Phase 135 is built. All ten slices are built. The device checks are open.
Phase 133 is built, with the voice room, and seven points of it are open.
Phase 131 has two small open points.
Phase 130 has two open points. The phase-doc index at the top of
[phase-log.md](phase-log.md) is the complete list of what exists and which
phases are *planned, not started*.

## Phase 137 — phone polish: built, the device checks are open

All twelve slices are built, record in [phases/PHASE-137-POLISH.md](phases/PHASE-137-POLISH.md).
On the phone, the composer is one outlined box. The field is full width and
grows with the draft. The tools and send are in a row below it. Consecutive messages
from one person group on the phone. The conversation rows are taller, an unread name
is bold, and the unread dot sits under the time. The friends, voice, and hidden rows have a chevron
that turns, and an open section fades in. The headers stay on one row, and a long name is cut.
The parking lot mark is small. The chat and the list slide in for a short time, and a swipe back does not slide a second time.
Friend chips fill the top of the list in up to two lines, with a count button at the right.
The filter button opens a filter bar with a name field and kind chips, and the list then shows only conversations.
The Parking Lot and the threads are icon buttons in the list head, with filter, add a friend, and new channel.
A direct conversation shows the name with no "@", and the presence dot marks it.

- **The 137-1 device checks are open.** The live probe used an iPhone 14
  emulation. Not tested on a device: the composer above the keyboard on an
  iPhone and on Android, no jump when the field gets focus, a grown field with
  the keyboard open, and the emoji picker position above the composer.
- **The 137-2 device checks are open.** Not tested on a device: a long press
  on a follow-up row shows its time, grouping with timestamps turned off in
  settings, and the head row of a thread reply.
- **The 137-3 device checks are open.** Not tested on a device: the pressed
  shade shows and clears on a tap, a voice room row with people and an unread
  dot, and the last row of the hidden shelf.
- **The 137-4 device checks are open.** Not tested on a device: the voice row
  with a live room and an unread dot, the hidden row with its count and dot,
  and the fade-in, which must be instant with reduced motion turned on. The
  voice row was not seen in the emulation, because voice rooms are off on the
  dev stack.
- **The 137-5 device checks are open.** Not tested on a device: a long display
  name in the header, the account menu opening and fitting, a voice room header
  with the "call" button, and a direct message header with the "dm" tag.
- **The 137-6 device checks are open.** Not tested on a device: the parking
  lot mark at 96 px after you park and unpark, and the mark in a light theme.
- **The 137-7 device checks are open.** Not tested on a device: the slide on a
  row tap and on the back button, no second slide after a swipe back, no slide
  with reduced motion turned on, and a notification tap that opens a chat. The
  emulation did not check reduced motion.
- **The 137-8 device checks are open.** Not tested on a device: the dot of an
  away friend, a long friend name, the chips measuring again after the phone
  rotates, and a chip tap for a friend with no chat yet. The emulation could not
  stage an away friend. It did not test more than 24 friends or a waving name.
  137-11 changed the layout of the chips, and its own checks cover the cut of a long name.
- **The 137-9 device checks are open.** Not tested on a device: the chip row
  scrolling sideways, a hit in the hidden shelf that opens it, a channel found
  by its full name while short names show, and a live voice room under the
  voice chip. The emulation had no voice room, no hidden hit, and no short name.
- **The 137-10 device checks are open.** Not tested on a device: the five head
  icons are easy to tell apart, the dot on the threads button with an unread
  reply, the head on the narrowest phone, and a renamed parking lot that is
  still found. The emulation did not show the unread dot or the head with no
  parking lot (four buttons).
- **The 137-11 device checks are open.** Not tested on a device: full names with
  eight friends or fewer, a count button that is easy to hit, a proportional
  font with no third line of chips, and the chips after the phone rotates. The
  emulation had nine friends and no away friend.
- **The 137-12 device checks are open.** Not tested on a device: a DM row shows
  the presence dot and no "@", and the dot changes when the friend goes away or
  offline.
- **Deferred: the swipe settle ignores reduced motion.** The settle uses a
  hard-coded 160 ms (`theme.css` and `SWIPE_SETTLE_MS` in `use-swipe-back.ts`).
  Reduced motion does not turn it off.

## Phase 135 — phone: built, the device checks are open

135-1 to 135-10, record in [phases/PHASE-135-PHONE.md](phases/PHASE-135-PHONE.md).
The chat list is the only phone layout. The menu button, the slide-in channel
list, the Zuckermode setting, and the `roster.viewMode` preference are gone. The
phone does not mount the sidebar (135-2). `VoiceSinks`, the audio of a call,
mounts once at the top of the app, outside every layout branch. On the phone,
each layer (chat, thread, panel) is a history entry, so the system back closes
it (135-3). The viewport meta asks Chromium to shrink the layout for the keyboard, the
phone document does not scroll, and phone tap targets are 44 px (135-4).
In a call, the phone has a call bar above the composer on every screen except
the call view. A tap on it opens the call view, a full-screen layer with
a history entry of its own (135-5). `ZuckerCallBar` and the footer voice controls
are gone.
On the phone, a call keeps the screen on and shows on the lock screen with
microphone, camera, and hang up where the phone supports them. A flip button
switches between the front and the back camera (135-7). The owner chose to
build 135-7 before 135-6. When the page shows again, the client reconnects at
once or checks the open socket with a ping, and an answer with the same ref
proves it (135-6). A long press or a right-click on a list row opens a sheet
with notifications, hide, group, and, for the owner, rename (135-8). The sheet
is a history layer, and the sidebar and the sheet call the same handlers.

- **Three things are not on the phone.** The order within a group has no
  effect on the phone list, which sorts by newest activity. The channel header
  image has a desktop dialog as its editor. The nick colour of a friend is in
  the friend-row menu of the sidebar.
- **The 135-8 device checks are open.** The live probe used a mouse long press
  with emulation. Not tested on a device: a finger long press on iOS and on
  Android, and the iOS text-selection callout.
- **A tab that did not reload can still show the old drawer.** The update
  banner reloads it.
- **The spec `test/e2e/mobile.spec.ts` is not executed.** Its header says why.
  Only `driver.mjs` ran after 135-1. The other five changed probes were
  checked for syntax only.
- **The 135-3 device checks are open.** A real Android back button, Android
  predictive back, and the iOS edge swipe in an installed app are not tested.
  Chrome can skip history entries that a page adds without a user gesture.
  Every push in 135-3 follows a tap.
- **The 135-4 device checks are open.** The keyboard on Android Chrome and
  Brave with the new meta (a double resize is possible), the iOS keyboard
  close, and pull-to-refresh on Android Chrome and in an installed iOS app are
  not tested.
- **Panels not measured for 44 px.** The probe measured the list, a chat, the
  composer, and one dialog. The settings panel, the friends panel, and other
  panels are not measured.
- **The 135-5 device checks are open.** The drag-down close and the double tap
  on a video are pointer gestures, and the live probe did not drive them. Real
  devices and screen share on an Android phone are not tested. Eight audio
  cards without a scroll were not seen (the probe had four).
- **The 135-7 device checks are open.** The probe did not observe the wake
  lock, and only unit tests cover it. Not tested on a device: that the screen
  stays on, the lock-screen buttons on Android and iOS, a flip without a black
  frame or a failure, and the wake lock in an installed iOS 18.4 app. Interrupted
  calls, audio route changes, and recovery after a microphone permission change
  are also open.
- **The 135-6 device checks are open.** The live probe used emulation and a
  switch that drops frames. Not tested on a device: a real iPhone or Android
  phone that returns from the background, an installed iOS app with WebKit bug
  308073, and a laptop that wakes from sleep.
- **The 135-10 device check is open.** Not tested on a real iPhone, in Safari
  and in the iOS shell: that the keyboard does not cover the fields of sign-up
  and login, and that a tap on the next field scrolls it into view. The probe
  used Chromium with an iPhone 13 profile.
- **The 135-9 device checks are open.** Not tested on a device: an installed
  iOS app that returns from the background keeps the microphone and camera
  without a prompt (5 s and 60 s), the camera returns without a prompt, the
  microphone indicator goes off 30 s after a drop that does not recover, and a
  desktop rejoin keeps the same microphone. Unknown: how often iOS stops the
  capture tracks in the background.
- **135-6 has three plan items not built.** There is no HTTP catch-up fallback
  and no forced reload for a stuck iOS socket beyond the 5 s connect timeout.
  There is no detection of a frozen page by timer drift. There is no new header
  element, because the header status already shows the connection state.
- **The `--phone` voice shots of `ui-sweep.mjs` changed.** They now land in the
  call view and not in the old room page. Its step that clicks `voice-cam`
  finds nothing. That step was already inside a catch.
- **The manual checklist in the phase doc is open.**

## Phase 133 — polish: built, with seven open points

133-1 … 133-15 are built, record in
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
on screen. On the phone, the call bar and the call view of 135-5 take the
place of the footer bar, and the sidebar runs to the bottom of the window. The sidebar lists no names under
the voice rooms, and a hover card on the row shows them. A voice room with
people in it shows a red record light. Every change is in the client. The live
probe ran on 2026-11-08 after 131-7, and all 25 checks passed. The manual
checklist in the phase doc is still open.

- **The phone list has no deafened state.** The rail and the room card show it.
  Since 135-5 the deafen button of the call view shows it in a call.
- **The phone list has no name list and no hover.** Touch has no hover. Since
  135-5 the call view of a room, before you join, shows how many people are
  there and a picture or initial for up to eight of them. The names show once
  you join. The phone drawer that reused the sidebar is gone since 135-1.

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

## Phase 129 — seasonal: IN PROGRESS, with recorded trade-offs

129-1 … 129-24 are built. 129-25 onward is open. Record in [phases/PHASE-129-SEASONAL.md](phases/PHASE-129-SEASONAL.md).
An animated pixel scene peeks into the middle of the top header. Each of
six season keys has five scenes, and the `christmas` key shows seven scripted
scenes, which are nods to films and series (129-19). The `new-year` key also
shows seven scripted scenes: six nods to films, series, and a game, and a plain
fireworks show (129-20). The `winterfest` key shows eight scripted scenes, which
are nods to films and series (129-21). The `black-week` key shows nine scripted
scenes about money and sales, which are nods to films, series, and a game
(129-22). A visit holds one of them,
and it is never the scene of the last visit of the same key (129-15). The
always-on hours rotate through the scenes of the key every 35 s. The calendar
is: Christmas from 1 to 26 December, no season from 27 to 30 December, New Year
on 31 December and 1 January, and Winterfest from 2 January to 7 February
(129-19). Late Autumn runs from 16 to 22 November, and no season runs from 6 to
15 November (129-22). Black Week runs from the Monday before Black Friday to
Cyber Monday, and its dates move with the year. On its days it comes before the
fixed seasons, so in some years it takes 22 November from Late Autumn and
1 December or 2 December from Christmas (129-22). The bar scene of Black Week
shows twice as often as the other eight (129-22). A gap of 21 days in a common
year separates two of the other seasons.
A date in a gap shows one of ten scripted neutral scenes, which are also nods
to films and series (129-12, 129-18). On the evening of 24 December and on New
Year's Eve, the scene stays up from 20:00 to 05:00. There is a switch per device and a server
switch on the admin settings tab. A visit of a season scene comes at most 16
times in a local day on one device, and at most 10 of them start before 18:00
(129-7, 129-9). The neutral scene has its own rule: at most two visits from
08:00 to 12:00 and two from 16:00 to 24:00, at least 20 minutes apart, and only
while the chalk window has focus (129-16, 129-24).
A phone in zuckermode shows the scene in a row above the conversation list
(129-11). The classic phone layout and the header of a phone show no scene.
A headed season demo in the ui-sweep skill shows one scene on a fake date (129-17).
Open: 129-25 and later, which tune the five keys that have rows, one key in
each slice, in this order: spring-bloom, green-season, midsummer,
harvest-festival, spooky-season. Late Autumn runs seven scripted nods to films,
series, and games (129-23).
Open cleanup: the scene engine in `web/src/season/scene.ts` still has branches
for snow roofs, snow on pines, frozen lakes, and chimney smoke. They key on
`winterfest` and `new-year`, and no row reaches them now. The `late-autumn`
entries of `PALETTES` and `CANOPY` and the `late-autumn` case of `isLeafless`
are in the same state (129-23). Thirteen props (`barrel`,
`boat`, `bridge`, `cabin`, `clock`, `flag`, `gift`, `house`, `ice`, `lamp`,
`snowball`, `snowman`, and `tower`) are in no row. The branches and the props stay for the
tuning slices. After the last of them, remove what no row uses, or use it.

- **A change by an administrator reaches other clients on their next page
  load.** `GET /api/auth/config` is cached with `max-age=60`, so the delay is
  one minute at most. A `welcome` payload field or a WebSocket broadcast is the
  fix if it grates.
- **The cap on visits is for a device and a local day.** A person with two
  devices gets 16 visits on each. Clearing `chalk.season.visits.v1` from
  localStorage gives visits again.
- **A neutral window is lost if no visible tab checks inside it, at or after the
  target time.** The neutral scene has no cap and no gap. It has one random
  target time in each window, and a missed window does not move. The log is
  `chalk.season.neutral.v1`.
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

## Phase 65 — web push: IN PROGRESS, 65-1 to 65-9 and 65-11 to 65-13 built

65-1 is built: migration 0063 and `internal/store/push.go`. 65-2 is built:
the `internal/webpush` package. 65-3 is built: the push config, the VAPID key
pair in `chalkctl`, and `chalkctl push`. 65-4 is built: the three push frames
on the sealed WebSocket and migration 0064. 65-5 is built: the dispatcher
sends a push for each new message that the instance published, and the threat
model has its section on third parties. 65-6 is built: the service worker, its
build, and the `no-cache` header for `sw.js`. 65-7 is built: the page registers the
worker and reconciles the browser subscription at every welcome. 65-8 is built: the push
part in Settings > notifications calls `enablePush` and `disablePush`. 65-9 is built: a click on a notification opens the chat, also from a closed app and on the phone. 65-11 is built: the switch `CHALK_OUTBOUND_IPV4_ONLY`. 65-12 is built: the log shows the reason that a push service gives for a rejected push. 65-13 is built: the Topic header of the message push is `chalkmsg`, not `chalk`, because Apple answered BadWebPushTopic. The manual device checks and the optional 65-10 (a "hide details" lock-screen mode) are open. Record in [phases/PHASE-65-PUSH.md](phases/PHASE-65-PUSH.md). The plan
was revised on 14 November 2026 after a review against the threat model. A
subscription belongs to a login session and goes with it. The VAPID key and
all subscription frames travel only over the WebSocket. Guests cannot
subscribe.

- **Accepted property:** there is no per-channel mute for push. Notification
  rules are sealed, so the server cannot read them, and the service worker
  cannot drop a push without risking a revoked subscription on iOS. A channel
  muted in chalk still pushes under scope `all`.
- **Open:** all real-device checks (an iPhone on a deployed HTTPS instance,
  Android Chrome, desktop Chrome or Firefox). The list is in the phase doc
  under "Decisions from 65-9". The `notificationclick` handler of the worker has no automated test. The probe covers the page side only.
  No automated test covers the path from a real NOTIFY to a real push service,
  because the sender refuses loopback addresses.
  The iPhone check includes this: chalk shows under Settings > Notifications
  only after the permission prompt. It is not in the main list of apps.
- **Open:** SMTP mail does not obey `CHALK_OUTBOUND_IPV4_ONLY`.
- **Open:** with the switch on, the connection to the push service of Apple
  works on the production host. The service answered 400 (BadWebPushTopic) to
  a message push. 65-13 changes the topic. The device check is open: after
  the deploy, a chat message pushed to a locked iPhone must arrive, and the
  log must have no `push: send to subscription` line.
- **Accepted property:** the badge in a push counts unread DM channels and
  pending friend requests only, at most 99. The app also counts mentions and
  threads and corrects the number when it opens.
- **Accepted property:** the push cooldown is in the memory of each process.
  A restart resets it, and messages that different instances publish are
  counted apart.
- **Resolved in 65-4:** each subscription row holds the VAPID public key it
  was made with, and the dispatcher lists only rows that match the current
  key. 65-5 must pass the current key to `ListPushSubscriptionsForUsers`.

## Phase 87 — message reminders: built, open items remain

Slices 87-1 to 87-9 are built. [phase-log.md](phase-log.md) has the summary.
Without push on, nothing fires while chalk is closed. The reminder plays the
cue of a new message. A cue of its own for a reminder is open. It needs a new
sound file in each theme, which only the project owner makes, so it is not code
work. The browser checks of 87-3 to 87-6 passed in part on a desktop viewport. These
manual checks stay open:

- 87-3: the phone viewport (the inline mark and the long-press menu).
- 87-3: the cap message at 25.
- 87-3: a reminded message that is gone.
- 87-4: the head button and the panel on a phone viewport, with swipe back.
- 87-4: a jump to a message that is not loaded (the crawl).
- 87-4: a reminder whose channel is gone.
- 87-5: the app badge of an installed chalk, and the dot on the phone head button.
- 87-6: the sound at the due time, the banner close from another device, the settings row, do-not-disturb, and the privacy screen.
- 87-8: a real push through a push service to a closed browser and to a phone.
- 87-8: a real click on the notification (the focus-or-open branch of the worker).
- 87-8: the online case end to end. Only the unit test covers it.
- 87-8: a phone.

These limits of 87-7 stay open:

- The wake set of a user is not created when another device subscribes to push,
  until one device sends the frame again at the next welcome or change.
- The rows of a user in the soft-delete state stay until the purge. The sweep of 87-8
  skips them.
- The due times are visible to the server and in the database for a user with
  push on. `docs/threat-model.md` records this, in the section "Reminder wake
  records".

These limits of 87-8 stay open:

- A reminder that fires by push stays pending in the sealed set until a device
  opens chalk. It then fires as overdue, with the sound and the banner, unless
  the user came in through the click on the notification.
- An open device that is idle or hidden counts as not online after presence
  demotes it. The server then pushes while the page also fires the reminder.
  The shared tag makes one notification replace the other on that device.
- If the operator turns push off later, the sweep does not run. Old wake
  records stay until the subscriptions of the user go.
- The push service sees a high-urgency push at the due time.
- A push that fails is not sent again, because the claim deletes the record.

Record in
[phases/PHASE-87-REMINDERS.md](phases/PHASE-87-REMINDERS.md).

- **Observation:** the rules sync, the peer-audio sync, and the pin sync keep
  their first instance across an account change in one page load. They also
  lose a send that is made on a closed socket. The reminders sync does neither.

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

- **Ties** (86, [phases/PHASE-86-TIES.md](phases/PHASE-86-TIES.md)): say "this
  answers that" across an interleaved channel without quoting — a sealed
  per-user side record on the reactions pattern, drawn as a gutter mark plus a
  hover connector. Still open, but read its 9 August 2026 note first: phase 107
  shipped quoting, so the document's framing as *the alternative to* quoting is
  out of date. What a tie does that a quote cannot — point at a message too far
  back to reprint — is unchanged, and is the reason it is still on this list.
- **A local idle agent** (90, [phases/PHASE-90-IDLEEXT.md](phases/PHASE-90-IDLEEXT.md)).
- **Large rooms** (98, [phases/PHASE-98-BIGROOMS.md](phases/PHASE-98-BIGROOMS.md)):
  per-sender streams for rooms past the 64 cap — **stale since the
  2026-08-09 trust-model revision** (it was sketched against fanout's
  membership layer); needs a re-sketch against the new phase 83, then
  its own review, before any code.
- **An iOS wrapper app** (136, [phases/PHASE-136-IOS.md](phases/PHASE-136-IOS.md)):
  in progress. Slice 136-4a is built (2026-11-16): the APNs sender package in
  `internal/apns/` and its config values. Slice 136-4b is built (2026-11-16):
  a `kind` column on the push rows, the sealed frame `push_subscribe_apns`, the
  fan-out to both senders (reminders included), and the sender that chalkd
  builds. Slice 136-4c is built (2026-11-16): `chalkctl push apns set` and
  `clear`, the `apns` line of `push status`, and the key kept on `init --force`,
  `update`, and restore. Nothing sends the frame yet, so no push goes to Apple. Slice 136-1 is done (2026-11-16): on an iPhone, a call
  continued through an app switch and a screen lock in the shell, so the gate
  passed. The call held for more than 5 min in each case, and
  the shell has no `PushManager` and no `Notification`. Slice 136-2 is built
  (2026-11-16): the server address screen, the navigation rule, child windows,
  downloads, safe areas, and the app icon. The follow-up of 136-2 (the server screen in the look of chalk, and a web view that
  shrinks above the keyboard) is not checked on the device. Open: two 136-2 device checks (the
  Settings toggle that brings back the server screen, and the recovery-phrase
  print window) and one measurement (a passkey sign-in in the shell).
  Slice 136-3 is done and checked on a device (2026-11-16): the page reads the
  mark of the app, hides the call note and the Home Screen push hint there, and
  mutes the microphone and turns the camera off on a phone call. Two points
  are open: if WebKit fires `mute` for a phone call, also in Safari, and if the
  page script runs during the call or only on return. It is unknown which of the
  two signals caused the mute. Slice 136-5a is built (2026-11-16): Web Inspector in Debug builds only, a deployment
  target of 17.0 (not measured on iOS 17 to 27.1), ignore rules for signing files,
  and a manual `ios` CI job for the Swift tests. Slice 136-4d part 1 is built
  (2026-11-16): the receiver side of the push crypto and the payload text, with
  tests. Open: the steps that need the paid Apple Developer account, which the owner
  will buy and which is not active yet (136-5b the first upload, the rest of 136-4d,
  and 136-5c the GitHub release job), the export compliance decision (the facts are
  in the phase doc), the Beta App Review sign-in decision (the reviewer needs a TOTP
  code), and the device checks. Installs that last
  longer than 7 days need it too. Until 136-4d, no push goes to Apple. In the Home
  Screen web app the call still pauses in the background, and the call view
  says so. In the app the call continues, and the view does not say so.
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
- `chalkctl init --force` takes `WRAP_SIG_REQUIRED` from `DefaultConfig`, which
  is `true`. If the chalkctl config file of an updated deployment has no such
  key, `init --force` turns the requirement on. 65-3 handled the same problem for
  push: `update` writes `PUSH_ENABLED=false` to the config file. No such
  backfill exists for `WRAP_SIG_REQUIRED`.
- `TestInnerSealedChannelEndToEnd` in `test/integration/innerchan_test.go`
  fails at HEAD with "no session". It dials without a session cookie, and the
  WebSocket upgrade has required a session since 09b-5. The test in
  `test/integration/push_ws_test.go` shows how to send the cookie.
- `web/build.mjs` never removes old hashed files from `web/dist`. A dev tree
  collects them (933 MB here), and chalkd embeds all of them (a 991 MB dev
  binary). Release builds start from a clean checkout and are not affected.
  Workaround: empty `web/dist` before `node build.mjs`.
- `docs/wire-protocol.md` is stale. It lists `chalk_sid` and `presence_set`,
  and it lacks `ping`, the `inner_*` frames, and the push frames. Do not
  rewrite it from itself. `internal/proto` and `web/src/proto.ts` are the
  authority.
