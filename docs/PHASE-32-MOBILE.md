# Phase 32 — mobile layout

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.3.20 – v0.3.26. Extended by 33-6, 60, 64, 76.
**Tag:** `#mobile` → `tools/where.sh -g mobile`

## Why

chalk was built desktop-first: a fixed sidebar beside a message pane, hover
affordances, and rows laid out in columns. On a phone that gave a squeezed
two-column layout with a roster too narrow to read and message rows that wrapped
into nonsense. Phase 32 made the same app usable on a phone without forking the
component tree.

The decision was to keep **one component tree** and switch layout with CSS and a
single width breakpoint, rather than ship a separate mobile UI. Everything since
— zuckermode (62), swipe-back (64), the 16px control floor (60) — builds on that
choice.

## What landed

- **32-1** — mobile layout: the roster becomes a drawer over the message pane
  instead of a fixed column, message rows stack (sender above body) instead of
  laying out in columns, and safe-area insets are honoured so notched screens do
  not eat the composer or the status bar.

## Where it lives

`web/src/mobile.ts`, `web/src/theme.css` (the mobile media block),
`web/src/components/Sidebar.tsx`, `web/src/components/MessageList.tsx`.

## Notes

- Compact row actions and a narrower drawer landed a slice later, as 33-6.
- The e2e spec for the drawer width and mobile row actions was written but
  blocked on the auth fixture at the time (see `ee081aa`).
