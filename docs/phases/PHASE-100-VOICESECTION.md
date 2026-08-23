# Phase 100 — the voice section

**Status:** 100-1 shipped. One slice; the phase is closed unless the follow-ups
under [Left open](#left-open) are taken up.

**Tag:** `#roster` → `tools/where.sh -g roster`.

## The problem

Since 30-5 the sidebar has rendered voice rooms and text channels in one
"channels" list, distinguished only by their glyph and (when occupied) the
occupant sublist. On a roster of any size the two kinds blur: a voice room is
something you *join* — a place with live occupancy, its own unread semantics
(45-3: the scratchpad dot is suppressed while you are in the room) and often an
expiry timer — while a text channel is a feed you *read*. Scanning for "the
room people are hanging out in" meant reading glyphs down a mixed, grouped
list, and the 54-3 grouping machinery happily filed a voice room between two
text channels inside "General".

## The design

A separate **"voice" section directly above "channels"** (scuq's suggestion,
taken literally), the same structural move that already separates friends,
parking and threads:

- **Flat, ungrouped, unfiltered.** There are rarely more than a handful of
  voice rooms. The 54-3 groups, the 54-1 filter and their headers stay with
  text channels only; the channels filter input does not reach up into the
  voice section. Group *suggestions/overrides* on voice channels remain stored
  but inert, and the channel context menu hides its "group" row for voice
  rooms rather than offering a move that would not render.
- **The section only exists while there is a voice room to show** — no empty
  "voice" header for servers that never use voice.
- **One row implementation.** The channel-row JSX (glyph, expiry badge,
  occupant count, unread dot, occupant sublist, context menu, long-press) was
  extracted into a `channelRow` closure used by both lists, so the two can
  never drift apart.
- **Hidden channels are untouched.** 78-2's shelf keeps holding both kinds,
  last in the channels section; hiding a voice room removes it from the voice
  section like it removed it from the roster before.
- **Sizing** mirrors the friends section: the voice section shrinks to its
  content under a 35vh cap with internal scroll, and the channels list keeps
  `flex: 1` of what remains.

Rejected: a pinned "voice" pseudo-group inside the grouped roster (still one
list, still one filter — the separation the request was about would be one
collapse-toggle away from disappearing), and per-kind counts in a shared
header (says the split without showing it).

Mobile is untouched: the phone roster is the ZuckerList (62), which has its own
conversation-first shape.

## Slices

- **100-1** — `splitVoice` helper (channel-groups.ts) + the sidebar section,
  row extraction, menu group-row suppression, CSS sizing.

## Left open

- The voice section has no filter input of its own; a server with ≥7 voice
  rooms would get one for free by wiring `showRosterFilter` the way the other
  two sections do.
- Voice rows still honour 54-4 group overrides in storage (inert). If groups
  for voice are ever wanted back — e.g. per-team room clusters — the split
  happens in one place (`splitVoice`) and the grouping machinery below it
  still understands voice rows.
