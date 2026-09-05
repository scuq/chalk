# Phase 110 — the gallery lightbox: paging and zoom

**Status:** built, 110-1 and 110-2 (2026-09-05). Unreleased. One manual
checklist under [Left open](#left-open) is not covered by tests.
**Tags:** `#gallery` → `tools/where.sh -g gallery`

## The problem

101-1 taught the feed to show a message's images as a grid, and closed with the
follow-up it deliberately did not take:

> The lightbox is still per-image: no prev/next arrows or swipe between the
> images of one message. A gallery lightbox would lift the expanded state out
> of `AttachmentView` into `AttachmentGroup`.

That is the whole complaint. Someone sends five photos; the grid shows four and
a "+1"; opening one gives you that one picture and a way back to the feed, so
looking at all five is five round trips through a scrolling conversation, and
the fifth needs the grid expanded first. Worse for a screenshot of anything
textual: the expanded view fitted the picture to the viewport and stopped
there, so a phone screenshot of a terminal opened at full screen and was still
unreadable, with nothing to do about it.

Two things were missing and they are the same thing — the expanded view treated
one picture at one size as the entire interaction.

## The design

**A `Lightbox` component that shows a set.** The overlay moved out of
`AttachmentView` into `components/Lightbox.tsx`, and the thing it is handed is
an array plus an index. `AttachmentGroup` owns that index, so:

- prev/next reach **every image of the message**, including the ones still
  behind the "+N" overlay — the group passes its whole `images` array, not the
  visible tiles, so paging forward is how you see the rest without expanding
  the grid;
- files in the same message are not in the set, which is right: they are rows
  with a download button, not pictures;
- a **lone image keeps its own one-image gallery**. `AttachmentView` opens a
  `Lightbox` of `[att]` when no group above it passed `onOpen`. Arrows and the
  counter hide at a count of 1, so that path looks and behaves exactly as it
  did before 110.

**The lightbox loads its own bytes** rather than borrowing the tile's decrypted
object URL. It is the only arrangement that works for a neighbour whose
`AttachmentView` never mounted (an image behind the "+N", or a tile scrolled
out of the feed), and it costs almost nothing: the controller is cache-first
against the ciphertext in IndexedDB, so re-decrypting an image the feed already
painted is a WebCrypto call and no network. Both neighbours are prefetched, so
a page turn shows bytes rather than a spinner. Fail-closed is unchanged — no
key, no bytes, the locked placeholder.

**The scale arbitrates the gestures.** This is the load-bearing decision.
Pinch-to-zoom, pan, and swipe-to-page all want the same axis under the same
finger, and the rule that keeps them apart is that at fit scale a horizontal
drag pages, and zoomed it pans — decided once at `touchstart`, from the finger
count and `isZoomed(view)`, and never re-decided mid-drag.

**Rightward at the first image closes.** 64-9 gave the lightbox the app's
swipe-right-back gesture, and a gallery wants that same axis for "previous".
Rather than pick one, `swipeActionFor` gives rightward its natural meaning at
every position — previous image, and at the first image, where there is nothing
behind it, out. The set's first image is the one place a person expects back to
mean *back out*, so the two gestures turn out to be the same gesture.

**The picture is not a close button any more.** It used to be: click anywhere,
including the image, and the overlay went. That cannot survive zoom, because a
click on the picture is now either the first half of a double-click or the end
of a pan. The backdrop still closes, and there is now an explicit ✕, plus Esc
and the swipe.

**`zoom.ts` is arithmetic, not DOM.** The component measures a `Frame` (viewport
size and centre, plus the image's laid-out box) and asks for numbers back:
`zoomAt` keeps the anchor pixel under the cursor, `clampView` keeps the picture
from escaping the viewport, `panBounds` returns 0 on an axis the scaled image
does not overflow so it stays centred instead of sliding in empty space. Scale
1 is measured from the *fitted* box rather than the image's natural pixels, so
the floor always means "the whole picture on this screen" and zooming out can
never strand you on a corner. `gallery.ts` is the same shape for the swipe
rules. Both are node-tested; the events that drive them are not, which is the
usual split for this codebase.

### Rejected

- **A channel-wide gallery** — arrows walking back through every image in the
  conversation. It needs an index built off the message list, decrypt-on-demand
  for images whose row is outside the virtualized feed, and a story for paging
  history mid-gallery. Materially bigger, and scuq picked the per-message scope.
- **Reusing `useSwipeBack` for the paging gesture.** It is rightward-only by
  design and settles off-screen; a gallery needs both directions and three
  different outcomes. `gallery.ts` re-declares the constants rather than
  importing them, because the two gestures are tuned against different surfaces
  (a photo you are flicking through, a screen you are backing out of) and must
  be free to drift apart.
- **Zoom by buttons only** (+/−/reset in the corner). Safest against the
  existing gesture wiring and rejected as dated.
- **Keeping close-on-image-click by debouncing it** against the double-click.
  It works, but it puts a ~250ms delay on the most common way out of the
  overlay to serve the less common one.
- **Carrying the zoom across a page turn.** Every image opens fitted; the next
  photo is a different shape, so an inherited 3× lands on an arbitrary corner.

## Slices

- **110-1** — `gallery.ts` (paging + swipe rules) and its tests; the `Lightbox`
  component; `onOpen` on `AttachmentView` so a tile reports its index instead
  of opening its own overlay; the gallery state in `AttachmentGroup`; arrows,
  ✕, counter and the stage CSS.
- **110-2** — `zoom.ts` (zoom/pan arithmetic) and its tests; wheel, double-click
  and mouse-drag pan; pinch and one-finger pan on touch, gated on the scale;
  `touch-action: none` on the overlay so the browser's own pinch and scroll
  stay out of it.

## Left open

- **Not covered by tests, and worth a pass by hand on a phone:** pinch-zoom
  and swipe-to-page not fighting each other; a pinch that lifts one finger
  becoming a pan rather than dying; and swipe-right at the first image still
  leaving the overlay the way it did before 110. The pure rules under both are
  tested, but the touch plumbing that feeds them is not.
- No double-tap-to-zoom on touch: `dblclick` is a mouse event and the touch
  path has no tap-timing of its own. Pinch covers it; a tap timer would be the
  slice that adds it.
- The channel-wide gallery above is still a reasonable idea, and this phase is
  the component it would extend rather than replace: it already takes a list
  and an index and loads its own bytes.
- The lightbox does not preload beyond one neighbour in each direction. Fine
  for a message's worth of images; a channel-wide set would want a window.
