# Phase 79 — where opening a conversation puts you

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.6.4 (79-1), v0.7.0 (79-2), v0.7.1 (79-3); 79-4 unreleased.
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
- **79-4** — hold the reader's *own* position through late growth.

## The third state (79-4)

"Let nothing but the user's own scrolling move it" was the rule 79-2 set, and
the feed only enforced it in two of the three states it can be in:

| state | what holds the view |
| --- | --- |
| landing anchor still held | re-applied on every resize (33-5, 79-2) |
| anchor released, reader at the bottom | re-pinned to the end (64-7) |
| anchor released, reader parked mid-feed | **nothing** |

The third state is a reader who opened a conversation and started reading back
through it before the attachments had finished decrypting. `.chalk-main` sets
`overflow-anchor: none` so the scrollback pager can be the only corrector of a
prepend, so the browser will not hold the position either — and a photo above
them resolving from a one-line "decrypting attachment…" strip into a full-size
box shoves their rows down by its whole height. The view ends up on the picture
that grew, which reads as the app scrolling backwards on its own.

The fix is scroll anchoring, by hand, for that state only: on every scroll,
record the row under the top edge of the scrollport (a hit test below the
pinned header, not a sweep over the rows) and its offset; on every resize, put
it back. Growth *below* the held row leaves it where it is and the correction
is 0, so the rule needs no idea of where the growth happened — `keepDrift` in
`history-paging.ts` is the whole of it.

It does not become a second corrector of a prepend: the pager's layout effect
has already run by the time the resize is delivered, so the held row has not
drifted and the correction is 0. Where that restoration is imperfect, this
takes out the residual.

## Where it lives

`web/src/chat/history-paging.ts`, `web/src/components/MessageList.tsx`,
`web/src/theme.css`.

## Note on the numbering

The flush-at-the-bottom fix was committed twice under two labels — `4ea3173`
reads `phase 85-1` and `95bf850` reads `phase 79-3` for the same work. It
belongs to 79; phase 85 is operational logging.
