# Phase 131 — the call rail: every participant in a narrow column

**Status:** built, 131-1, 131-2 and 131-3 (2026-11-07). Unit-tested by
`web/src/voice/rail-tiles.test.ts`, the `roomCardRows` cases in
`web/src/chat/hovercard.test.ts`, and the rewritten third test in
`web/src/theme-sidebar.test.ts`, which asserts the CSS declarations against the
stylesheet. The live probe on a running stack is pending.
Phase 114 gained slices 114-5 and 114-6 in the same change set. Their record is
in [PHASE-114-ROSTERORDER.md](PHASE-114-ROSTERORDER.md).

**Tags:** `#voice` → `tools/where.sh -g voice`

## The problem

Take a user with many friends, many people in a voice room, and the room not on
screen. The desktop sidebar then has no room left for the text channels.
Three things use the column:

- The friends list.
- The names under the voice room.
- The voice dock at the bottom left.

The dock showed a 96 px preview of one camera, a status row, and a row with the
room name and the leave button. Phase 123 measured it at about 166 px and gave
the channel list a floor. It did not give the space back.
The preview also shows one camera only. In a call with five cameras, four of
them are not visible from another channel.

## The design

A call rail is a 48 px column to the left of the sidebar, like the activity bar
of a code editor. It exists only while you are in a call.
Each participant has one 40 px tile in it. The dock shrinks to one row. The
sidebar drops the names under the voice rooms.

### The rail (131-1)

The root element gets the class `chalk-app--rail` while you are in a call.
The class makes the grid three columns wide, `var(--chalk-rail-w)`, the sidebar
width, and the main column. The token `--chalk-rail-w` is 48 px.
The footer grid and the layout with a thread open get the same extra column.
The maximum width of the centered shell grows by the width of the rail and one
column gap, so the feed keeps its width.

A tile follows these rules:

- The order is the stage order: you first, then the roster order, then media
  with no roster entry, then one tile for each screen share.
- A tile plays video only when the participant has a live camera and the room
  is not the active channel. If the room is on screen, the stage plays the
  video and the tile shows the picture or the monogram. One stream is never
  bound to two video elements.
- A 2 px accent ring shows who speaks.
- A badge shows muted, deafened, or a screen share. The title and the aria
  label carry the name.
- A click on a tile jumps back to the room.
- If the tiles do not fit, the rail scrolls. Its scrollbar is hidden.

The rail is its own grid cell, not a child of the sidebar. The floors of
phase 123 depend on the direct children of the sidebar, and the phone drawer
makes the sidebar fixed.

The rail is for the desktop only. Two guards keep it off the phone layout:
the `!isMobile` gate in `App.tsx`, and a CSS rule in the phone block that hides
the rail and resets the grid. Both are necessary, because the rail rule has
two classes and outranks the one-class phone reset.

The tile order comes from a pure function, `railTiles` in
`web/src/voice/rail-tiles.ts`. The hook `useVoiceRoom()` in `VoiceDock.tsx`
returns the room of the session, or null when idle. It changes state only at a
join, a leave, or a move, so the app shell does not render on every speaking
tick. `CallRail.tsx` reads the full session itself and uses a one-second tick
while in a call. The badge icons moved to `VoiceBadges.tsx`, and `DeafIcon` is
new there.

### The dock on one row (131-2)

The dock lost the preview and the "voice connected" status row. It is one row
now: the room name, the duration (or "joining…"), the live dot, and the leave
button. The row for the screen-share stop button and the audio nudge stay below
it when they apply.
The preview rules of phase 123 went with it: the 44 px strip under 820 px and
the only `max-height` media query in the stylesheet.
The dock does not use its `activeChannelID` prop now, so the prop is gone.

### The names move to a card (131-3)

The list of names under each voice room is gone for every room. The count badge
stays. A rest of the mouse pointer on the row for 500 ms, or keyboard focus on
the row, shows a room card.

The card lists "you" first, then the roster in its own order. Each row can show
icons for muted, deafened, camera, and screen share. The card shows 12 rows at
most, then one row "+N more". `roomCardRows` in `web/src/chat/hovercard.ts`
builds the rows, and `RoomCard` in `web/src/components/HoverCard.tsx` draws
them. `arm` gained an optional height estimate, so a tall card near the bottom
of the window is placed right. The `PersonCard` callers did not change.

The classic phone drawer reuses `Sidebar`, so it loses the list too, and touch
has no hover. Zuckermode keeps its own list. The stage shows the names once you
join.

## What was rejected

- A rail that stays open with friend avatars when you are idle. It takes 48 px
  from every user who is not in a call, to show what the friends list shows.
- A preview that floats over the feed. It needs a new anchor and it covers the
  last lines of the feed. Phase 123 rejected it for the same reasons.
- A switch that brings the old preview back. The rail replaces the preview, and
  a second path to the same picture is more code with no new use.
- Keeping the name list for the rooms you are not in. The list is what takes
  the room in the column, and a room you are not in is not urgent.
- A capped list with "+N more" in the sidebar. A cap makes the height of the
  column depend on the roster. The count badge and the card give the same
  names without it.

## The slices

- **131-1 — the rail column and its tiles.** The token, the root class, the
  grid and the footer, `railTiles` and its tests, `useVoiceRoom`, `CallRail`,
  and `VoiceBadges`. The tests of `railTiles` use fake streams.
  They cover: you first, the roster order kept, orphan media appended, one
  screen tile for each share, a hidden remote share with no live video, and a
  camera that is off.
- **131-2 — the dock on one row.** The preview, its CSS, the 44 px query, and
  the status row are gone. The third test in `theme-sidebar.test.ts` now
  asserts the rail token, the grid rule, the 40 px tile, the scroll rules,
  no `.chalk-voice-pip` selector, and no `max-height` query.
- **131-3 — the names move to a card.** `roomCardRows` and its tests,
  `RoomCard`, the height estimate of `arm`, and a second hover card in
  `Sidebar` for rooms. The card is for the mouse and for keyboard focus.
  The old sublist and its CSS are gone.

## Left open

- The stage memo in `VoiceCallPanel.tsx` still builds the same tile order as
  `railTiles`. It must become one call to `railTiles`. This needs its own
  slice, and the owner of the repository must approve it.
- The phone list has no deafened state. The rail and the room card have it.
- The phone drawer has no name list and no hover. Zuckermode keeps its list.
- While the room is off screen, the rail decodes one video for each remote
  camera. The old preview decoded one. The rule that shows the picture while
  the room is on screen keeps it to one surface for each stream.

## Manual checklist

- [ ] Firefox at 1280x800, in a call with two cameras, in another channel. The
      rail shows both tiles, the camera tiles play video, and the channel list
      shows at least two rows.
- [ ] The desktop app, same steps.
- [ ] Set the font scale to 1.5. The rail, the one-row dock, and the
      channel list all fit.
- [ ] A room with 12 or more participants. The rail scrolls and shows no
      scrollbar. The room card shows 12 rows and "+N more".
- [ ] The centered layout of 1100 px with a thread open. The feed keeps its
      width, and the thread panel sits at its right.
