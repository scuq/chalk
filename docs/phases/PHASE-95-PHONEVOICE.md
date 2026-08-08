# Phase 95 — voice, off the phone's home screen

**Status:** 95-1 and 95-2 shipped together, one change set. The phase is closed
unless the follow-ups under [Left open](#left-open) are taken up.

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

Three things it had to learn, all worth keeping if the probe is rewritten:

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
- **The `@ voice` row does not say who is in a room, only how many.** The
  roster is right there in `state.voiceRosters`; a line of handles under the
  room name is the obvious next thing, and was left out because the row is
  already carrying a count, an unread dot and a preview.
- **The classic mobile drawer keeps both behaviours.** Voice rooms stay in its
  channel groups and the controls band stays under its composer. If the drawer
  layout turns out to want the same treatment, the split is already pure and
  the prop is already there.
- **A room you are currently in is still just a row in a collapsed list.** The
  voice dock (30-5c) is what tells you where you are, and it is above the
  footer on every screen, so this has not bitten — but "the room you are in
  sorts to the top, or pins itself open" is the cheap fix if it does.
