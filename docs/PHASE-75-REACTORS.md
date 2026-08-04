# Phase 75 — who sent a reaction

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.6.1.
**Tag:** `#reactions` → `tools/where.sh -g reactions`

## Why

Phase 37 stored reactions as **encrypted per-user sets**, so the client already
holds who reacted with what — it was only ever rendering the tally. Showing the
names needed no protocol change and no server work; it is purely a surface the
data already supported.

Three input methods because the affordance has to exist on every device:
hover on a pointer, long-press on touch (via `press.ts`, the same handler the
row menu uses), and focus for keyboard/tab users.

## What landed

- **75-1** — reactor list on hover, on long press, and on focus.

## Where it lives

`web/src/chat/reactions.ts`, `web/src/chat/press.ts`,
`web/src/components/ReactionBar.tsx`, `web/src/theme.css`.
