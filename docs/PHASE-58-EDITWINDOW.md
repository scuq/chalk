# Phase 58 — edit any of your recent messages

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.4.9.
**Tag:** `#reactions` (edit/react surface) → `tools/where.sh -g reactions`

## Why

Phase 37 shipped editing with a 15-minute author-only window, but the only entry
points were cursor-up (which targets your *latest* message) and a row-menu
"Edit" that was gated on being the latest message too. So a typo two messages
back was unfixable even though the policy plainly allowed it — the UI was
stricter than the rule.

No policy change: the window, the author-only restriction and the
no-owner-override stance from phase 37 all stand. This is the menu catching up
with `editpolicy.ts`.

## What landed

- **58-1** — the row menu offers Edit on every message of yours still inside the
  edit window. Cursor-up in an empty composer still jumps to the latest.

## Where it lives

`web/src/chat/editpolicy.ts` (unchanged rule),
`web/src/chat/message-menu.ts`, `web/src/components/MessageList.tsx`.
