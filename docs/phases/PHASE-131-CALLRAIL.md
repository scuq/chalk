# Phase 131 — the call rail: every participant in a narrow column

**Status:** built, 131-1 to 131-12 (2026-11-08). Unit-tested by
`web/src/voice/rail-tiles.test.ts`, the `roomCardRows` cases in
`web/src/chat/hovercard.test.ts`, and the rewritten third test in
`web/src/theme-sidebar.test.ts`, which asserts the CSS declarations against the
stylesheet. The live probe `.claude/skills/run-chalk/probes/ui.mjs` ran on
2026-11-07 with two users at 1280x680 and a fake camera. All 20 checks passed
on 131-1 to 131-4. After 131-5 it ran again, with 22 checks, and all passed.
They include no rail on the room page, the rail with video on a text channel,
a tile without video that shows the initial, and a tile click that jumps back
and removes the rail. After 131-6 it ran on 2026-11-08, with 25 checks, and
all passed. The new checks are: on the room page the footer bar has five
controls. On a text channel the rail foot holds two buttons in 57 px, and the
footer bar has three controls with no mute button. A click on the mute button
of the rail flips the muted badge on your own tile. The manual checklist at the
end of this file is still open.
After 131-9 the probe `.claude/skills/run-chalk/probes/rail.mjs` ran on
2026-11-08, with 6 checks, and all passed. The busy room row shows the dot and
LIVE and no speaker glyph. The dot blinks with `chalk-rec-blink` at 1.15 s,
stepped, in the error red. The header shows LIVE for the person in the call
only. On a text channel the header LIVE stays and the rail shows the tile. A
click on the header LIVE goes back to the room, and leave removes it.
After 131-10 the same probe ran again on 2026-11-08, with 7 checks, and all
passed. In the new check, the person in the call sees only the speaker glyph on
the row of that room, with no LIVE, while the header shows LIVE.
Slice 131-11 renamed the word from REC to LIVE. REC claims a recording, and
chalk records nothing. LIVE says what is true. After 131-11 the same probe ran again on
2026-11-08, with 7 checks, and all passed. The word LIVE shows in the row and in
the header.
Slice 131-7 changed the desktop layout again, so the probe checks of 131-5 and
131-6 about the room page and the footer bar are out of date. After 131-7 the
probe ran on 2026-11-08, with 25 checks, and all passed. On the room page the
rail is present with head and foot and no tiles. The grid has three columns,
the foot has six buttons, and the timer shows in the head. There is no footer
bar and no dock box. On a text channel the rail has one tile and six foot
buttons, and there is no footer bar. The mute button of the rail flips the
badge on your own tile. A click on a tile jumps back and the tiles go. At 390 px
there is no rail. After leave the grid has two columns again.
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
of a code editor. On desktop it exists for the whole call (131-7).
Each participant has one 40 px tile in it while the call room is not the
channel on screen (131-5). The dock shrinks to one row, and since 131-7 the
dock box and the footer bar are the phone's. The sidebar drops the names under
the voice rooms.

### The rail (131-1)

The root element gets the class `chalk-app--rail` while you are in a call on
desktop. The class makes the grid three columns wide: `var(--chalk-rail-w)`,
the sidebar width, and the main column. The token `--chalk-rail-w` is 48 px.
The layout with a thread open gets the same extra column. Since 131-7 the rail
and the sidebar both span the main row and the footer row.
The maximum width of the centered shell grows by the width of the rail and one
column gap, so the feed keeps its width.

A tile follows these rules:

- The order is the stage order: you first, then the roster order, then media
  with no roster entry, then one tile for each screen share.
- A tile plays video when the participant has a live camera. The rail draws
  tiles only while the room is off screen, so the stage never plays the same
  stream.
- A tile always draws the first letter of the name. The picture draws over it
  when it resolves, so a tile is never blank (131-5).
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

### The tiles leave the room page (131-5)

The first design kept the tiles on the room page, with pictures. The stage
there already shows everyone, so the column repeated it. A picture that did not
resolve also left a blank box. The rail now draws tiles only while the room is
not the channel on screen. Slice 131-5 also removed the whole column on the
room page. Slice 131-7 brought the column back, with no tiles, so the layout
does not shift between the room and a text channel.

The `showTiles` line in `CallRail.tsx` holds the rule. The initial is
always in the tile, and the `Avatar` draws over it. The rule
`.chalk-call-tile .chalk-avatar--tile` places the picture with `position:
absolute` and `inset: 0`.

### The dock on one row (131-2)

The dock lost the preview and the "voice connected" status row. It is one row
now: the room name, the duration (or "joining…"), the live dot, and the leave
button. The row for the screen-share stop button and the audio nudge stay below
it when they apply. Since 131-7 this box renders on the phone only. On desktop
the call rail carries the duration and leave.
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

### The record light (131-4)

A voice room that has people in it shows the live indicator in the glyph box, in
place of the speaker glyph (131-9). The indicator is a red dot and the word LIVE
in bold, spaced type. The dot is as the viewfinder of a VHS camcorder drew it. The dot
blinks hard like the record light of a camera, with a 1.15 s cycle. It is fully on for the first half and fully off for the second
half, with `steps(1, end)` and no fade (131-8). The word does not blink. It says "live" at a glance, where a count alone does
not. The count badge at the end of the row stays and gives the number.
The indicator keeps its red on the active row. If the user sets
`prefers-reduced-motion: reduce`, the dot does not blink.
An empty room keeps the speaker glyph.
The glyph box grew to hold the word, so a voice row with people in it is a few
pixels wider than an empty one. This is the accepted cost.

### The live indicator in the header (131-9)

While you are in a voice room, the header shows the same indicator beside the
version badge. It shows on desktop only, like the version badge, because the
phone header is tight. A click on it goes back to the room, and its title names
the room. `RecIndicator.tsx` holds the indicator, and the sidebar and the header
share it. The color is the `--chalk-error` token.

While the header shows the light, the row of the room you are in keeps the
speaker glyph (131-10). Two lights a few centimeters apart say the same thing.
The rule holds on desktop while you are in a voice room. Other busy rooms keep
the light in their row.

### Buttons at the foot of the rail (131-6)

Slice 131-6 put two buttons for mute and deafen at the foot of the rail. Each
was 40 px wide and 24 px tall, with a 14 px glyph, and one was above the other.
Slice 131-12 made each button 40 px square with a 22 px glyph, the size of a
tile.
The tiles scroll in `.chalk-call-rail-tiles`. The foot,
`.chalk-call-rail-foot`, does not scroll, so the buttons are always in view,
also in a call with many people. `.chalk-call-rail-btn` shares the color,
hover, and `is-off` rules of `.chalk-voice-ctlbtn`.

Slice 131-6 also cut the footer bar under the sidebar to three controls while
the rail showed. Slice 131-7 removed that: the rail foot carries all the
controls, and the footer bar renders on the phone only.

The live probe ran on 131-6. The result is in the status header.

### The rail is the call column (131-7)

The rail is now the one call surface on desktop. It is present for the whole
call. It has three parts:

- The head, `.chalk-call-rail-head`. It holds the call duration as a button,
  and a small amber icon when audio is blocked. Slice 131-12 removed the green
  live dot that showed while the microphone transmitted. The button shows "…" while joining. Its title has the room name,
  and a click goes back to the room.
- The tiles, drawn only while the call room is not the channel on screen. On
  the room page the box stays empty and keeps the foot at the bottom.
- The foot. It holds microphone, headphones, camera, screen share, settings,
  and last a leave button. The leave button has a filled handset icon. Since
  131-12 it is a solid button in the error color with a white glyph.

Why:

- The call has one surface. The old design split it between the rail, the dock
  box, and the footer bar.
- The roster gains the footer corner. The sidebar and the rail span the footer
  row, `.chalk-footer` is a one-column grid, and the roster runs to the bottom
  of the window.
- Only one set of controls is on screen.
- The layout no longer shifts between the room and a text channel. The room
  page shows the head and the foot and no tiles, because the stage shows
  everyone.

The footer bar (`VoiceControls`) and the dock box (`VoiceDock`, prop `bar`)
render on the phone only. The audio sinks, the Ctrl+Shift+V shortcut, the
pop-out cleanup, and the autoplay-resume listener run on both. The `compact`
prop and `.chalk-voice-controls--rail` are removed. `IconCamera`, `IconScreen`,
and `IconGear` gained a `size` prop and are exported. `IconLeave` and
`toggleCamOrEnable()` are new. The pre-join defaults stay in settings, voice.
The phone keeps its footer bar, its dock box in the drawer, and the zuckermode
call bar.

Risks:

- The shell widens by 60 px when you join, on every page, also the room page.
  At 1280 px and wider this does not matter.
- Past one hour the duration has seven characters. At font scale 1.5 it clips
  in 46 px. The title has the full value.
- A window that goes from desktop to phone width during a call mounts the
  footer bar and the dock box. Both are stateless views of the session.

The live probe ran on 131-7. The result is in the status header.

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
- **131-4 — the record light.** `RecordIcon` in `VoiceBadges.tsx` (removed in
  131-9), the glyph branch in the channel row of `Sidebar`, the `chalk-chglyph--live` rule with
  the `chalk-rec-blink` keyframes, and one test in `theme-sidebar.test.ts`
  that asserts the color, the cycle time, the keyframes, and the
  reduced-motion rule.

- **131-5 — the tiles leave the room page.** The `railOn` rule, the initial
  under the picture, and the CSS that places the picture over it. Slice 131-7
  changed the `railOn` rule.
- **131-6 — mute and deafen at the foot of the rail.** The `size` prop of
  `Glyph`, the exports `IconMic` and `IconHeadphones`, the `compact` prop of
  `VoiceControls`, the foot in `CallRail.tsx`, the CSS split of the rail block,
  and the rail test in `theme-sidebar.test.ts`. Slice 131-7 removed the
  `compact` prop.
- **131-7 — the rail is the call column.** `railOn` is true for the whole call.
  The head, the six-button foot, and `showTiles` in `CallRail.tsx`. The grid
  areas and the one-column footer in `theme.css`. The `bar` prop of
  `VoiceDock`, and the phone-only footer bar. The rail test in
  `theme-sidebar.test.ts` asserts the new grid areas, the one-column footer,
  the head, and the leave rule.

- **131-8 — the light blinks hard.** The `chalk-rec-blink` keyframes and the
  `animation` line of `chalk-chglyph--live` in `theme.css`. The first design
  faded the dot over 2.4 s. A user-supplied sketch of the light had the text
  "REC". Slice 131-9 supersedes the decision to leave the text out for lack of
  room: the glyph box grew to hold it.
  The stylesheet test in `theme-sidebar.test.ts` covers the slice. A CSS timing
  change needs no live probe. Built 2026-11-08.
- **131-9 — the live indicator.** `RecIndicator.tsx` is new. The sidebar uses it
  in the glyph branch, and `App.tsx` uses it in a header button. `RecordIcon` is
  removed from `VoiceBadges.tsx`. In `theme.css`, `chalk-chglyph--live` holds
  `.chalk-rec`, and the `animation` line moved to `.chalk-rec-dot`. The
  stylesheet test in `theme-sidebar.test.ts` covers the color, the cycle, the
  stepped blink, the still word, and the reduced-motion rule. The live probe of
  the status header covers the rest. Built 2026-11-08.
- **131-10 — one light for the room you are in.** `Sidebar` has a new prop,
  `recInHeader`. `App.tsx` passes `railChannelID !== null && !isMobile`. The
  glyph branch adds `!(recInHeader && inRoom)`. One check in the live probe
  `rail.mjs` covers it. Built 2026-11-08. The probe passed.
- **131-11 — the word is LIVE.** The text of `RecIndicator.tsx` changes from
  REC to LIVE, and its `aria-label` from "recording" to "live". The dot, the
  blink, the type, the two homes, and the rule of 131-10 stay. REC claims a
  recording, and chalk records nothing. The component and the `chalk-rec*`
  classes keep their names. The title in `theme-sidebar.test.ts` and the probe
  `rail.mjs` say LIVE. Built 2026-11-08. The probe passed.
- **131-12 — larger foot buttons, a red leave button.** The foot buttons in
  `theme.css` are 40 px square, and the glyphs in `CallRail.tsx` are 22 px.
  `Glyph` in `VoiceControls.tsx` has a `filled` prop, and `IconLeave` is a
  filled handset. The leave button has the background `var(--chalk-error)` and
  a white glyph, and it brightens on hover. Its selector has two classes, so it
  wins over the shared hover rule that comes later. The live dot
  (`call-rail-live`) is gone from the head: the green `--speaking` border of a
  tile shows who talks, also for you. `.chalk-voice-live` stays, because
  `VoiceDock` and `ZuckerCallBar` use it. The rail test in
  `theme-sidebar.test.ts` asserts the new sizes and the leave rule. No live
  probe ran. Built 2026-11-08.

## Left open

- The phone list has no deafened state. The rail and the room card have it.
- The phone drawer has no name list and no hover. Zuckermode keeps its list.
- While the room is off screen, the rail decodes one video for each remote
  camera. The old preview decoded one. The rail draws no tiles while the room
  is on screen, so each stream has one surface.

## Manual checklist

- [ ] Firefox at 1280x800, in a call with two cameras, in another channel. The
      rail shows both tiles, the camera tiles play video, and the channel list
      shows at least two rows.
- [ ] The desktop app, same steps.
- [ ] Set the font scale to 1.5. The rail and the channel list fit. Past one
      hour in a call, the duration clips and its title shows the full value.
- [ ] A room with 12 or more participants. The rail scrolls and shows no
      scrollbar. The room card shows 12 rows and "+N more".
- [ ] The centered layout of 1100 px with a thread open. The feed keeps its
      width, and the thread panel sits at its right.
