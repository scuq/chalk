# Phase 132 — friend columns: compact friend rows and a two-column list

**Status:** built, 132-1 and 132-2 (2026-11-08). Unit-tested by
`web/src/chat/friend-columns.test.ts`, the `132-2` case in
`web/src/display-prefs.test.ts`, and the `132` case in
`web/src/theme-sidebar.test.ts`, which asserts the CSS declarations against
the stylesheet. A live probe on a 1280×800 desktop viewport passed on
2026-11-08. It covered the column count at three sidebar widths, the row
height, the roster avatar width, the check box, and a reload. The probe
logged no page errors. Three items stay open on the manual checklist at the
end of this file.

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

## What was rejected

- A name-length threshold in code. CSS measures the real width, so a sidebar
  resize or a long new name changes the layout with no code path. A threshold
  in code needs a guess of the width and a listener for each change.
- A preference that syncs to the server. If two columns fit depends on the
  width of the sidebar on each device, so one stored value is wrong on one of
  them. The preference stays on the device, like the font and the layout
  width.

## The slices

- **132-1 — compact rows.** The padding rule in `theme.css`, the two deleted
  empty rules, and the padding assertion in `theme-sidebar.test.ts`.
- **132-2 — two columns.** `friend-columns.ts` and its tests. The grid rules
  in `theme.css`. The inline variable and the class in `Sidebar.tsx`. The
  `friendColumns` preference in `display-prefs.ts` and its test. The prop in
  `App.tsx`. The check box in `ProfilePanel.tsx`. The keywords in
  `settings-nav.ts`. The grid assertions in `theme-sidebar.test.ts`.

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
