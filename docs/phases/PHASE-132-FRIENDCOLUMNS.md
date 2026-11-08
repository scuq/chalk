# Phase 132 — friend columns: compact friend rows and a two-column list

**Status:** built, 132-1 to 132-3 (2026-11-08). Unit-tested by
`web/src/chat/friend-columns.test.ts`, the `132-2` case in
`web/src/display-prefs.test.ts`, and the `132` and `132-3` cases in
`web/src/theme-sidebar.test.ts`, which assert the CSS declarations against
the stylesheet. A live probe on a 1280×800 desktop viewport passed on
2026-11-08. It covered the column count at three sidebar widths, the row
height, the roster avatar width, the check box, and a reload. The probe
logged no page errors. Six items stay open on the manual checklist at the
end of this file. The probe did not cover 132-3.

**Tags:** `#roster`, `#settings` → `tools/where.sh -g roster`

## The problem

A roster of six friends took as much height as the voice section and the
channel header together. Every friend row had the 8px padding of the base
sidebar row on all four sides. A long friends list pushed the channel list
down, and the floors of [phase 123](PHASE-123-SIDEBARFLOOR.md) were the only
protection.

Most friend names are short. A row is mostly empty space to the right of the
name.

## The design

### Compact rows (132-1)

The `.chalk-sidebar-item--friend` rule sets `padding: 3px var(--chalk-s2)`.
The row keeps the 8px of the base row on the left and right. It has 3px above
and below. Two empty rules for the friends list, which held only comments, are
deleted.

### Two columns when the names fit (132-2)

The friends list is a CSS grid with `grid-template-columns:
repeat(auto-fill, minmax(max(var(--chalk-friend-col), 50%), 1fr))`.

- The Sidebar sets `--chalk-friend-col` inline on the list. It is the width of
  the widest row: the longest label in `ch` units, plus the fixed parts of a
  row. The fixed parts are the dot, the gap, the padding, and the active
  border. With roster avatars on, the picture and its margin are also in the
  width.
- The 50% floor in `max()` means a column is never narrower than half the
  list. The grid has two columns at most.
- If two rows of the widest width do not fit the sidebar, `auto-fill` makes one
  column. No code runs for this. A sidebar resize or a new long name changes
  the layout through CSS alone.
- A grid cell has `min-width: 0`, so the name ellipsis still works. The empty
  state spans both columns.

The width calculation is in `web/src/chat/friend-columns.ts`.
`friendLabel` returns the text of a row: the handle, or the last eight
characters of the user ID. `longestFriendName` returns the longest length.
`friendColumnMinWidth` returns the CSS length. The calculation counts
characters because the sidebar font is monospace.

The setting `friendColumns` is a device-local preference. The default
is on, and a device with older stored preferences gets the default.
`App.tsx` reads it and passes it to the Sidebar as a prop. The Sidebar adds
the class `chalk-sidebar-list--columns` when it is on. The check box **show
friends in two columns** is under appearance in the settings, and
`settings-nav.ts` has search keywords for it.

### An envelope for unread (132-3)

The unread marker was a round dot of 7px in the text color. Beside the
online presence dot, which is also a small round dot, it looked like a second
presence light. In the two-column list, an unread friend took
extra width, and a long name was cut off when the envelope appeared.

The marker is now one glyph: a filled, rounded envelope. The operator gave
the design as an SVG. The flap is cut out of the mask, so the flap shows the
row background. A conversation that was read shows nothing, so there is no
glyph for the read state.

- The rule `.chalk-unread-dot::before` draws the glyph with a CSS mask. The
  element itself has no mask, so the glow of a mention (`filter:
  drop-shadow`) is not clipped.
- Unread uses `--chalk-unread`. A mention (`.chalk-unread-dot--mention`) uses
  the same shape in `--chalk-unread-mention`, with a soft glow. A mention
  differs from unread by color and glow, not by shape.
- `:root` sets `--chalk-unread` to `#24f077`, the designed green, for the
  default theme. The default theme has no `data-theme` attribute. Every other
  theme sets `data-theme` on the root element, and the `[data-theme]` rule
  derives `--chalk-unread` from the `--chalk-fg` of that theme.
  `--chalk-unread-mention` derives from `--chalk-accent`. A theme block can
  set the tokens to its own values. The presence colors stay fixed across
  themes.
- The size is 1em square, so the glyph follows the text size preference.
- Every row, friend or channel, pins the glyph to its right edge with
  `margin-left: auto`. No friend-row rule overrides this. In the friend grid
  each row is a grid cell, so the glyph sits at the right edge of the cell.
  The envelopes in a column line up, in the first column too.
- `friendColumnMinWidth` always counts the 1em glyph and its 0.5rem gap in the
  column width. An unread message never changes how many columns the list has.
- The class name `chalk-unread-dot` and the test ids stay as they were, so
  the change is small. `UnreadDot.tsx` renders the marker for the sidebar and
  for the conversation list.

## What was rejected

- A name-length threshold in code. CSS measures the real width, so a sidebar
  resize or a long new name changes the layout with no code path. A threshold
  in code needs a guess of the width and a listener for each change.
- A preference that syncs to the server. If two columns fit depends on the
  width of the sidebar on each device, so one stored value is wrong on one of
  them. The preference stays on the device, like the font and the layout
  width.
- A Unicode envelope character for the unread marker. Some platforms draw it
  as a color emoji, and no theme can recolor an emoji.
- A bold name instead of a glyph. The glyph shows a mention and an unread
  state, and a bold name shows only one state.
- An outline glyph for unread, with the filled one for a mention. One filled
  glyph replaced it, because the read state needs no glyph and one shape is
  simpler to recognize.
- The envelope right after the name. Names of different length put the
  envelopes at different positions, so the envelopes in a column did not line
  up.
- A count. The unread state does not hold a reliable message count.

## The slices

- **132-1 — compact rows.** The padding rule in `theme.css`, the two deleted
  empty rules, and the padding assertion in `theme-sidebar.test.ts`.
- **132-2 — two columns.** `friend-columns.ts` and its tests. The grid rules
  in `theme.css`. The inline variable and the class in `Sidebar.tsx`. The
  `friendColumns` preference in `display-prefs.ts` and its test. The prop in
  `App.tsx`. The check box in `ProfilePanel.tsx`. The keywords in
  `settings-nav.ts`. The grid assertions in `theme-sidebar.test.ts`.
- **132-3 — envelope marker.** The mask rule on `::before` and the two tokens
  in `theme.css`. The `[data-theme]` rule. The right-edge pin for every row. The envelope
  width in `friendColumnMinWidth` in `friend-columns.ts`. The comments in
  `UnreadDot.tsx`. The `132-3` test in `theme-sidebar.test.ts` and the width
  assertions in `friend-columns.test.ts`.

## Manual checklist

The live probe of 2026-11-08 used a user with three friends. Their names had
four to eight characters. The ticked items below are the ones it covered.

- [x] Sidebar at 160px. The list shows one column.
- [x] Sidebar at 220px with short names. The list shows two columns.
- [x] Sidebar at 420px. The list shows two columns, not more.
- [x] Drag the sidebar from 420px to 160px. The list changes from two columns
      to one with no reload. The probe dragged the resizer by mouse.
- [x] Settings, appearance, roster avatars on. The inline column variable
      becomes wider. At 220px the list then shows one column.
- [ ] Settings, appearance, roster avatars off again. The columns still fit
      the widest row.
- [x] Clear **show friends in two columns**. The list shows one column, and it
      stays one column after a reload.
- [ ] Select **show friends in two columns** again. The columns return.
- [x] A friend with a long handle in a sidebar of 220px. The list falls back to
      one column. The first probe run, with names of 12 characters, showed
      this.
- [ ] The phone view. The friends list looks right, and a long name shows an
      ellipsis.
- [ ] A light theme. An unread friend and an unread channel show the filled
      envelope in a readable color. A mention shows the same envelope in the
      accent color, with a glow that the shape does not clip.
- [ ] A dark theme. The same check as for the light theme.
- [ ] The default theme. An unread friend shows the envelope in `#24f077`.
- [ ] The two-column list with an unread friend. The envelope sits at the right
      edge of its cell. The envelopes in a column line up, in the first column
      too. The envelope does not sit between the columns.
- [ ] An unread friend with a long name in a sidebar of 220px. The list keeps
      the same number of columns, and the name keeps its ellipsis.
