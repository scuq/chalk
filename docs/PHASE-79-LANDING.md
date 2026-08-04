# Phase 79 — where opening a conversation puts you

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.6.4 (79-1), v0.7.0 (79-2), v0.7.1 (79-3).
**Tags:** `#unread`, `#history` → `tools/where.sh -g unread`

## Why

The landing target — the scroll position a conversation opens at — had been
fixed repeatedly since 33-4 and kept breaking, because the feed keeps *growing
after* the decision is made. Two sources of late growth:

- **Images finish decrypting.** A photo above the viewport resolves from a
  zero-height placeholder to its real size and shoves everything down under the
  reader.
- **History pages fill in behind.** Backfill above the landing point moves it.

Every earlier fix chased the symptom by re-anchoring after each growth event,
which is what produced the jumping. 79-2 changed the approach: **settle the
target once, when the conversation opens, and let nothing but the user's own
scrolling move it.**

The other two slices are framing errors around the same target. The "new
messages" divider landed *behind* the pinned channel header (69-2 / 60-2), so
with no marker visible and the newest message below the fold the app looked like
it had scrolled somewhere at random. And the bottom landing stopped a few pixels
short of the newest message, so the feed could always be nudged a little
further.

## What landed

- **79-1** — land the unread divider below the pinned channel header, not behind
  it.
- **79-2** — settle the landing target once, so a decrypting photo cannot drag
  the reader off the newest message.
- **79-3** — land the feed flush at the bottom, not a padding short.

## Where it lives

`web/src/chat/history-paging.ts`, `web/src/components/MessageList.tsx`,
`web/src/theme.css`.

## Note on the numbering

The flush-at-the-bottom fix was committed twice under two labels — `4ea3173`
reads `phase 85-1` and `95bf850` reads `phase 79-3` for the same work. It
belongs to 79; phase 85 is operational logging.
