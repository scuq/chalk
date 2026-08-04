# Phase 64 — the back swipe that works

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.5.1 – v0.6.3. Extended by 76-2 (code cards).
**Tag:** `#mobile` → `tools/where.sh -g mobile`

## Why

Going back to the conversation list meant reaching for a button. The obvious fix
— an edge swipe — collided with the platform at every step, and each collision
is why the implementation looks the way it does:

- **iOS owns the screen edge.** A left-edge-only gesture never reaches the page
  at all, so the swipe arms *anywhere* in the conversation (64-4) and defers to
  things that genuinely pan sideways — wide code blocks, the call volume slider.
- **The browser's own horizontal drag competes.** Swiping right could drag the
  whole page and snap back instead of navigating, unpredictably.
- **Distance thresholds assume room that may not exist.** A swipe starting near
  the right edge demanded more travel than the remaining screen width, so the
  finger ran off the glass first. The threshold now shrinks to the room the
  finger actually has, with a floor so a wobbly tap never navigates.
- **Images and GIFs are draggable by default**, which ate the gesture and could
  strand you in the full-screen viewer.
- **A redraw mid-gesture kills the touch stream.** A picture finishing decryption
  or a message arriving made the phone drop the rest of the gesture, leaving the
  pane parked half-off screen (64-13).

The end state is a gesture that **follows the finger** — the pane tracks the
touch and settles on release — rather than teleporting once an invisible
distance was crossed, so a swipe you think better of puts everything back.

## What landed

- **64-1 … 64-3** — zuckermode friends row with presence, conversation quick
  filter, edge-swipe back.
- **64-4 / 64-5** — swipe arms anywhere; the zucker filter moves behind a
  magnifier toggle.
- **64-6 … 64-8** — right-edge swipe runway; stay pinned through late image
  growth; the zucker list stops silently marking the last-open conversation
  read.
- **64-9** — feed media made undraggable; the lightbox closes on swipe-right.
- **64-10 … 64-12** — one swipe-back for every screen (threads and the thread
  inbox included, which previously covered the back button entirely), and make
  it follow the finger.
- **64-13** — a touch lost mid-swipe no longer strands the pane.

## Where it lives

`web/src/chat/swipe-back.ts`, `web/src/chat/use-swipe-back.ts`,
`web/src/chat/zucker.ts`, `web/src/components/ThreadPanel.tsx`,
`web/src/components/AttachmentView.tsx`, `web/src/theme.css`.
