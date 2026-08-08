# Phase 95 — voice, off the phone's home screen

**Status:** 95-1 and 95-2 shipped together, one change set. 95-3 and 95-4
followed as a second, reported against the shelf 95-2 built. The phase is
closed unless the remaining follow-ups under [Left open](#left-open) are taken
up.

**Tag:** `#zucker` and `#voice` → `tools/where.sh -g zucker`. It sits on the
seam between the two: it changes nothing about how a call works, only how much
of the phone's home screen a call you are *not* in gets to occupy.

## The problem

Zuckermode (62) is the phone's home screen: one activity-sorted list of every
conversation, the thing you look at to decide who to talk to. Two pieces of
voice apparatus were sitting on it whether or not voice had anything to say.

- **The controls panel is always mounted.** 44-2 made mute / deafen / camera /
  share / settings permanently visible, and the reasoning was good: the three
  toggles are global, so you set them *before* walking into a room rather than
  scrambling once you are in it. On a desktop that costs a corner of the roster
  column. On a phone the footer stacks (32), so the same panel is a full-width
  band of five icon buttons across the bottom of every screen — including a
  conversation list with no call anywhere near it.
- **Voice rooms are in the conversation list.** They sort by activity like
  everything else, but a room's activity is its scratchpad (45) — a couple of
  links dropped mid-call — so a room nobody has been in for a week can outrank
  the person you were talking to this morning. And the row has nothing to say
  when it gets there: a room is a *place*, so its preview reads "voice room"
  forever while you scroll past it looking for a name.

## The design

Both slices key off `zuckerActive`, which already means "a phone, in
Zuckermode" (it is `isMobile && viewMode === "zucker"`). Nothing here fires on
a desktop, and nothing here fires on the phone's classic drawer layout — the
drawer is a different screen with a different budget, and one of the two
mobile layouts changing under you is confusing enough without both doing it.

### 95-1 — the controls panel stands down until there is a call

`VoiceControls` takes a `hideIdle` prop and renders nothing while
`snap.phase === "idle"`. App passes `zuckerActive`, so the panel is unchanged
everywhere else.

"Joining" counts as joined: the panel comes back with the dock rather than a
beat after it, so the footer moves once on the way into a room instead of
twice.

This does give up 44-2's argument on this one surface, and the trade is
deliberate — the pre-join defaults are still settable, just not from the home
screen. They live in **settings ▸ voice** (the same `MicSettingsDialog` the
panel's gear opens), which is where someone who wants to always join muted goes
once, rather than a control they need under their thumb on every screen.

### 95-2 — rooms behind a pinned `@ voice` row

`splitVoice` (in `chat/zucker.ts`, pure and tested beside the rest of the
list-building) partitions the rows; `ZuckerList` renders the rooms half behind
a pinned row directly under `@ friends`. The two read as a pair: who is around,
and where they are talking.

The row is the 64-1 friends row's shape, deliberately — same class, same
expand-in-place, same right-hand note. The note is `1/4 live`, meaning one of
four rooms has somebody in it, which is the one thing about a room you cannot
get from its name. Occupancy comes from `state.voiceRosters`, already live
state (the sidebar draws its dots from it).

Two things the collapse must not swallow:

- **Unread.** A room's scratchpad can go unread behind a closed row, so the
  pinned row carries an `UnreadDot` when any room does — the same rule the 78-3
  hidden shelf follows, for the same reason: filing something away is not
  muting it.
- **The filter.** While the 64-2 filter has a query, the voice list opens
  itself if it has matches, and the list's "no matches" line only appears when
  *neither* half matched. Otherwise typing a room's name would answer "no
  matches" while the match sat inside a collapsed row.

### 95-3 — the shelf was being squeezed

Reported against 95-2: expanding `@ voice` gave the room a sliver, and its row
was cut off mid-line.

95-2 reused `.chalk-zucker-rows` for the expanded list, which was the right
call for the markup and the wrong one for the sizing. That class is the
*conversation list* — `flex: 1 1 auto`, the child that eats whatever the column
has left. Rendering a second one made two children fight over the same
leftover, so the shelf got a share proportional to nothing in particular:
enough for 48 of the 56px its row asks for, and the row clipped inside its own
scroll container.

The friends roster above it never had this problem because 64-1 gave it its own
class with its own sizing. So the fix is the rule 64-1 already found, written
once for both shelves (`@ voice` and 78-3's `hidden`, which shares the class
and therefore shared the bug): `.chalk-zucker-rows--shelf` is `flex: 0 1 auto`
with a 40vh cap.

The shrink factor is deliberate rather than `0 0 auto` — the shelf should be
content-sized whenever the conversation list has anything left to give, but if
three sections are open at once, something has to yield, and a shelf that
yields *scrolls* while a column that overflows just loses its bottom rows.
Flexbox distributes that shrinkage to the list first, since its content-derived
basis is far larger.

### 95-4 — who is in a live room

The follow-up this phase left open, and half of the same report: the shelf needs
the vertical space *because* a room with people in it has something to say.

`buildVoiceOccupants` (pure, in `chat/zucker.ts`, tested) reshapes
`state.voiceRosters` into per-room name lists; the row spends its preview line
on them when the room is live, and falls back to the preview — "voice room",
forever, for an empty room — when it is not. A room's scratchpad line loses
that contest on purpose: the count on the pinned row above raises the question
"who", and nobody opened the shelf to read a link someone dropped mid-call.

Two decisions the sidebar did not have to make:

- **One row per person, not per device.** 30-5 lists both of someone's devices
  because a desktop column can afford to; two identical handles in a row on a
  phone read as a bug. Merging them means merging their badges, and the safe
  direction is not the obvious one: someone is muted only when *every* device
  of theirs is (one open mic is an open mic), and is sending video or screen
  when *any* is.
- **Names resolve in App, not in the component.** `ZuckerList` is
  presentational — rows arrive pre-built (62-6) — and it has no channel member
  lists to look a userID up in. Same injection `buildConversationList` uses.

The line wraps rather than ellipsising, which is the whole point of 95-3: a full
room is exactly when the names matter, so the row is allowed to be two or three
lines tall and the shelf is allowed to grow with it.

## Also in this change set — 94-4

Two things reported against the 94 composer at the same time, recorded in
[PHASE-94-PHONECOMPOSER.md](PHASE-94-PHONECOMPOSER.md#94-4--the-c-that-was-not-centred-and-the-width-around-it):
the phone's `C` tool button was not centred like `F` `G` `E`, and the composer
had ~24px of spacing around it that a phone cannot spare.

## Verification

`node test.mjs` covers `splitVoice` — the partition, order preservation in both
halves, the all-voice and no-voice edges, and a voice channel landing in the
rooms half of a real `buildConversationList` output.

The rest is layout. `.claude/skills/run-chalk/probes/ui.mjs` (the scratch probe
slot — rewritten per investigation, so this is a description, not a promise it
still exists) ran 23 checks under iPhone 14 emulation: two users, a text
channel and a voice room, both tool styles' worth of composer measurement, the
band's presence on the classic layout and absence on the Zuckermode list, its
return once a room is joined, and the `@ voice` row's split, count, collapse,
expansion and filter behaviour.

`node test.mjs` covers `buildVoiceOccupants` for 95-4 — naming, `you` for the
viewer, per-channel resolution, the device merge in both directions (muted only
when every device is, badges when any is), and the empty-room edge.

95-3 is a measurement, so the probe was rewritten around it: three users, B and
C in a room while A watches from the Zuckermode list, 12 checks under iPhone 14
emulation. The ones that matter are `getBoundingClientRect().height` vs
`scrollHeight` on the shelf (equal means nothing is clipped), `flex-grow` being
`0`, the conversation list still having a usable height, and the same two
measurements again with the friends roster expanded above it — the two-shelf
case a naive fix passes and then fails.

Three things the 95-1/95-2 probe had to learn, all worth keeping if the probe is
rewritten:

- **The 94-4 bug is invisible in the default tool style.** `icons` centres its
  glyph with flex, so the probe has to select `text` in settings ▸ chat before
  measuring, or it proves nothing about the `C`.
- **Headless Chromium has no microphone**, so a join fails with "microphone
  access failed: Not supported" and never reaches `in-call` — the launch needs
  `--use-fake-device-for-media-stream`.
- **Creating or opening a voice room joins it.** Every "idle" assertion has to
  leave first, which is how the open item below turned up.

## Left open

- **Zuckermode has no reachable "leave call" control** — recorded in
  `docs/open-items.md`. Not caused by 95-1 (the band never had a leave button),
  but 95-1 is the change that makes the question obvious: the toggles are now
  on screen exactly when you are in a call, and the exit still is not anywhere.
  The natural home is the band itself, beside the four toggles.
- ~~**The `@ voice` row does not say who is in a room, only how many.**~~ Done
  in 95-4.
- **The classic mobile drawer keeps both behaviours.** Voice rooms stay in its
  channel groups and the controls band stays under its composer. If the drawer
  layout turns out to want the same treatment, the split is already pure and
  the prop is already there.
- **A room you are currently in is still just a row in a collapsed list.** The
  voice dock (30-5c) is what tells you where you are, and it is above the
  footer on every screen, so this has not bitten — but "the room you are in
  sorts to the top, or pins itself open" is the cheap fix if it does.
