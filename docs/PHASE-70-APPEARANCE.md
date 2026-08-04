# Phase 70 — fonts, scrollbars, and settings that hold still

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.5.6 (70-1, 70-2), v0.5.7 (70-3 … 70-5).
**Tags:** `#settings`, `#voice` → `tools/where.sh -g settings`

## Why

A polish phase with one constraint running through it: **nothing is ever fetched
from a CDN**. Fonts ship with chalk (the CSP from 51-1 would block them anyway),
which is why adding three typefaces is a bundle decision rather than a
stylesheet line.

The rest is about surfaces that misbehaved:

- Settings dialogs resized and jumped as you clicked between tabs, because each
  tab sized the frame to its own content. Both the profile and the voice & video
  dialog now keep one fixed frame.
- On phones the profile tabs ran off the right edge and had to be scrolled
  sideways to be discovered; they wrap into rows now.
- The version badge only rendered on wide screens, so on a phone there was no
  version and no route to the changelog at all — hence a version footer on every
  settings tab.
- Browser scrollbars ignored the theme and the message pane's bar sat flush
  against the text, crowding the search button in the channel bar.

## What landed

- **70-1** — settings modal version footer: version + changelog link reachable
  on mobile.
- **70-2** — steady settings modals: fixed frame across tabs, wrapped mobile tab
  pills, and audio / camera / calls tabs for the voice & video dialog.
- **70-3** — themed scrollbars (slim thumb, transparent track) plus a per-device
  hide-scrollbars preference, with the message pane's lane collapsing when they
  are off.
- **70-4** — the composer shortcut sheet lays out as a grid, so Safari stops
  collapsing it to a narrow wrapped column.
- **70-5** — bundle JetBrains Mono, Fira Code and Cascadia Code beside Hack,
  pickable per device. All three are ligature fonts.

## Where it lives

`web/fonts/`, `web/src/theme.css`, `web/src/theme-fonts.test.ts`,
`web/src/components/ProfilePanel.tsx`,
`web/src/components/MicSettingsDialog.tsx`,
`web/src/components/MicSettings.tsx`.

## Notes

The shortcut sheet itself moved out of the composer entirely in 76-1 — a cheat
sheet is something you read once, not a button beside what you are typing.
