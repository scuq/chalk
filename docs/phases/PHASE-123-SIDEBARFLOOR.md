# Phase 123 — the sidebar on a short window keeps its channel list

**Status:** 123-1 built (2026-09-13). Unit-tested by
`web/src/theme-sidebar.test.ts`, which asserts the CSS declarations against
the stylesheet. The layout itself was driven by a 14-check probe
(`.claude/skills/run-chalk/probes/ui.mjs` at the time) in headless Chromium,
since jsdom has no layout to measure.

**Tags:** `#voice`, `#roster` → `tools/where.sh -g voice`

## The problem

On a 13-inch laptop, join a voice room with the camera on and click another
channel. The voice dock at the bottom of the sidebar shows its call preview,
and the channel list above it disappears.

The preview is the trigger, not the cause. The sidebar is a flex column: an
inner column holding the friends, voice, threads, parking and channels
sections, then the dock as a fixed-height footer. The inner column has no
overflow rule of its own. Each list scrolls inside its section. Before this phase, the
friends, voice, threads and parking sections all declared `flex-shrink: 0`,
and the channels section was the only shrinkable one, with no floor under it. On a
short window the column ran out of room, and channels paid for all of it:
zero height, no rows.

The dock with the preview costs about 166px — a 96px preview box, the status
row and the channel-and-leave row. The preview draws its 96px box in an
audio-only call too, since it shows a monogram there instead of a video
frame, so a camera is not necessary to trigger the squeeze. A long friends
list on its own can do the same thing, with no call running at all.

Measured in the probe, at a 1280x680 viewport with one friend, two text
channels and four voice rooms: before this phase, the channels section
measured 0px and the inner column overflowed, so the dock painted over the
voice list's rows as well. After this phase, channels measured 126px
with both text channels visible as rows, and the dock's bottom stayed inside
the sidebar.

## The design (123-1)

CSS only. No new state, no new UI.

- The friends and voice sections change from `flex-shrink: 0` to
  `flex: 0 1 auto`, with a `min-height` floor of about one header and one
  row, under their existing viewport caps (40vh and 35vh). The lists inside
  them keep scrolling on overflow, as before.
- The channels section keeps `flex: 1`, and gains a `min-height` floor of
  about a header, the filter and two rows. Before this phase it had no
  floor, which was the fault.
- The threads and parking sections are unchanged: one row each, and they
  still do not shrink.
- A new media query, the first and only `max-height` query in the
  stylesheet, caps the call preview at 44px once the window is 820px tall
  or shorter. `width: 100%` with `object-fit: cover` turns the shorter box
  into a center-cropped strip, and the monogram fallback still fits inside
  it. A threshold of 820px covers a 13-inch laptop and a 1440x900 screen
  under browser chrome, and leaves a 1080p desktop untouched.
- The voice dock component keeps its existing rules for when the preview
  shows and when a call keeps the sidebar in focus. Nothing there changed.

The floors are sized so that a typical short window still fits everything.
At their floors, friends and voice cost about 64px each, threads and
parking about 80px together, channels 126px and the slim dock about
130px — near 465px in all, against the roughly 520px a 1280x800 laptop
gives the sidebar after the header and the footer. If the floors ever add
up to more than the column has, the inner column overflows and the dock
paints over it again, the same way it did before this phase. A second scroll container was considered and rejected (see
below), so this remains a known edge rather than a case the CSS defends
against.

Rejected:

- A preview that floats over the bottom-right of the message pane instead
  of sitting in the dock. It needs a new positioning anchor, and it covers
  the last lines of the feed.
- A per-device setting that hides the preview, matching the pattern already
  used for the channel banner. It leaves the dock's text rows in place and
  does nothing about the missing floor.
- A second scroll container on the inner column. The lists already scroll
  inside their own sections, and the dock stays a visible footer below all
  of them. That is the reason the 30-5g comment on the inner column gives.

Related, not closed: a four-tile call does not fit a window under about
850px tall. That is the call stage, not the sidebar, and it is tracked
separately in `docs/open-items.md`. The phone layout, which replaces the
sidebar with a fixed full-height drawer, is not affected.

## Manual checklist

- [ ] Chrome on a real 13-inch laptop at its native size, camera on during
      a call, click another channel. The channel list stays visible.
- [ ] Firefox at 1280x800, same steps.
- [ ] The desktop app at 1280x800, same steps.
- [ ] Settings, display, font scale 1.5, on a short window. The em floors
      grow with the text, and the channel list still shows at least one row.
- [ ] A friends list of 15 or more, on a short window, with no call
      running. The channel list still shows at least one row.
