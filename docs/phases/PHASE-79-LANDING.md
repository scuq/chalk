# Phase 79 — where opening a conversation puts you

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.6.4 (79-1), v0.7.0 (79-2), v0.7.1 (79-3),
v0.7.4 (79-4, 79-5), v0.8.26 (79-6, 79-7), v0.9.0 (79-8), v0.9.1 (79-9). Built, not yet released: 79-10.
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
- **79-5** — hold the landing against the whole scrollport, not just the feed.
- **79-6** — hold a row from the first touch after a landing, so a tap without
  a scroll cannot let growth above the reader move the view.
- **79-7** — clear the "show message" jump target when the phone returns to the
  list, so re-entry does not jump to the old row.
- **79-8** — land again when rows arrive after the landing, until the reader
  touches the screen, so a re-entry after a spell in the background does not
  stay on the old window.
- **79-9** — clear the landing record when a channel has no rows, so a quick
  switch to a channel and back lands on the new rows.
- **79-10** — look at the landing again after the write, so a phone that
  applied the write late or not at all still lands on the anchor.

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

## The whole scrollport (79-5)

Every corrector above is driven by one `ResizeObserver`, and it watched only
`MessageList`'s own root. So it saw a message row growing and nothing else —
while "the end of the feed" is a function of the whole scrollport:

- the **scrollport's own height** — the composer growing underneath it (a
  wrapped draft, a link preview card with a thumbnail, attachment chips)
  shortens it without touching the feed at all;
- the **sticky channel header**, a sibling of the feed inside the scroller;
- in the thread panel, the **parent head** — a second `MessageList` in the same
  scroller, and usually the message carrying the photo that was replied to.

Any of those settling after the landing left the view short by exactly that
much, permanently: no resize of the observed root, so nothing put it back. The
thread case is the one users reported.

`anchorWatchTargets` (`history-paging.ts`) is the rule — feed, scroller, and
the scroller's children, deduplicated. It takes the children as an array rather
than reaching into the DOM so it can be tested. Observation is border-box:
what moves the end of the feed is the space a box occupies, not the space
inside it. The gate is unchanged — the view moves only while the landing anchor
is held or the reader is following the end; a reader parked mid-feed is handled
by 79-4's `keepDrift` and is otherwise untouched.

## The release gap (79-6)

On a phone (Zuckermode, installed app), a channel opened at the "new messages"
divider ended up showing older history.
A browser probe confirmed the cause.
The landing holds the view only while its anchor is held, and the first touch
releases the anchor.
The mid-feed corrector from 79-4 (`keepRef`, the row under the top edge) was
set only in the scroll handler.
That handler used one hit test, one pixel below the pinned header.
A tap without a scroll never set it.
A hit test that landed in the 12 px gap between the header and the divider, on
a day mark, or between rows found no row and also set nothing.

With no row held, growth above the reader moved the view.
Reactions for the loaded window arrive after the landing.
Link previews, GIF embeds, and decrypted bodies also grow after the landing.
Each of them pushed older rows into the viewport.

The probe numbers before the fix:

- The divider was at 63 px after the landing.
- After a tap and then ten reactions above the divider, it was at 402 px.
- The top row was a backlog message six rows above the first unread one.

The fix has two parts:

- The release step in `MessageList.tsx` now sets `keepRef` from `topRowAnchor`
  at the moment the anchor goes, if the reader is not pinned to the end.
  The next scroll event replaces it as before.
- When the hit test finds no row, `topRowAnchor` scans the rows and holds the
  first row that ends below the probe line.
  `firstRowBelow` in `history-paging.ts` does the choice.
  The scan runs only after a miss, so the scroll path stays one hit test.

The same probe on the fixed bundle gave these numbers:

- The divider was at 63 px after the landing.
- After a tap and the arrival of ten reactions above the divider, it was still
  at 63 px.
- The `scrollTop` of the scroller moved from 1810 px to 2149 px, which is the
  339 px that the rows above grew.
- The top row was still the first unread message.

A second pass, with a drag instead of a tap, also held.
The divider was at 115 px before and after the reactions.
The probe reported no page errors.

## The armed jump target (79-7)

A 1600 ms timer inside the feed clears the "show message" jump target (`flashMessage` in `App.tsx`).
On the phone, the feed unmounts on the way back to the list, and its cleanup
cancels the timer.
The channel stays active under the list, so the effect that clears the target
on a channel change does not fire.
The target stayed armed, and re-entry centered the old row.
A new effect in `App.tsx` clears the target when `zuckerScreen` becomes
`"list"`.

## The stale window (79-8)

On a phone (Zuckermode, phase 62), the conversation list and the feed share the
scroller `.chalk-main`, and `MessageList` mounts again on each entry.
A conversation opened again after the app was in the background landed on the
last message that the phone showed before.
The rows that arrived in the meantime were below the screen.
The reader saw older history.

The cause was confirmed in the code and by a probe:

- `state.messages[cid]` survives a visit.
  On re-entry the feed mounts with the window of the last visit.
- The activation fetch in `App.tsx` returns early when the history is already
  loaded.
- The rows that arrived while the socket was down come only through the
  key-ready refetch in `ensureKeyFor` (the 23g backstop), which runs after the
  mount.
  On a phone the socket is down in the background, so every re-entry after a
  background spell is this case.
- The landing effect landed once per channel, on the first commit with rows.
  That commit held the old window.
- The late append then went through the follow branch, a smooth `scrollToEnd`.
  On the phone the view did not move.
- If unread rows were among the late rows, the divider was not in the old
  window at the time of the landing.
  The landing went to the end and the divider was lost.

The fix has three parts:

- `touchedRef` is false at the mount.
  The release step sets it to true on the first wheel, touch, mouse, or key
  gesture.
  A landing that moves to a new channel sets it to false.
- The landing effect lands again on every row change while `touchedRef` is
  false and `anchorRef` is still held.
  A gesture, or a dropped anchor (the flash target of 49-1), ends the landing
  phase.
  A new landing is instant (`behavior: "auto"`), on the rows that exist now.
- `landingTarget` in `history-paging.ts` chooses the target.
  `landedWithDividerRef` carries between landings whether the last landing saw
  a divider.

The rules of `landingTarget`, in this order:

| Previous landing | Divider in the feed now | Target |
|---|---|---|
| None (first landing) | Yes, and the run earns the scroll | Divider |
| None (first landing) | No, or the run does not earn the scroll | End |
| On the divider | Yes | Divider |
| On the divider | No | End |
| At the end, and it saw a divider | Any | End |
| At the end, and it saw no divider | Yes, and the run earns the scroll | Divider |
| At the end, and it saw no divider | No, or the run does not earn the scroll | End |

The row "at the end, and it saw a divider" keeps the 79-2 rule: the run did not
earn the scroll then, so the new landing does not move the reader.
The row "at the end, and it saw no divider" decides again because the unread
rows were not loaded at the time.
Six tests in `history-paging.test.ts` hold the table.

The probe ran in Chromium with iPhone 14 emulation.
It proxied the websocket of the reader.
It dropped the `message` frames for one channel during the background spell and
held the `fetch_history_ack` for 2.5 s.
It advanced the cursor of the reader by SQL in place of a second device.
It had three passes: the active channel after a socket cut with the rows read
elsewhere, the same with unread rows, and a different channel with the socket
alive.

The numbers before the fix:

- Pass 1 landed at `scrollTop` 628 of 1124, which is the old end.
  The append grew the feed to 1987 at 2.5 s.
  The view followed to 1491 one frame (16 ms) later, through the
  `ResizeObserver`.
  Chromium does not show the stall of the phone.
- Pass 2 (16 unread late rows) landed at the end.
  The divider was 692 px above the viewport.
- Pass 3 followed to the end.
- 15 of 19 checks passed.
  Four failed: the probe's own bookkeeping and pass 2.

The numbers after the fix:

- Pass 1 went from 628 to 1491 in the same frame as the growth to 1987.
- Pass 2 stopped at `scrollTop` 1057 of 2308.
  The divider was 63 px below the top of the scroller, under the header (the
  bottom of the header is at 51 px).
- Pass 3 went from 1491 to 2211 at the append.
- First visits landed on the divider at 63 px.
- 19 of 19 checks passed, with no page errors.

A visible consequence: until the first gesture, each row that arrives lands the
view again at once, in place of the smooth follow.
After the first gesture the follow branch is as before.

Caveat: the probe did not reproduce the failure of the phone to carry out the
smooth follow.
The fix removes the smooth follow from the phase before the first gesture.
A reader who touched the screen before the append still depends on the follow
branch.
A later slice can apply the follow again when a touch ends.

## The empty visit (79-9)

`landedRef` holds the channel where the component last landed.
`relanding = landedRef.current === channelID` chooses between a fresh landing and the re-landing branches.
A fresh landing resets `touchedRef`.
The list stays mounted when the reader switches channels. Only `channelID` changes.

Before 79-9, the landing effect returned early when the feed was empty.
The feed is empty when the history has not loaded, when the channel has no rows, and in an ephemeral channel.
The early return did not change `landedRef`.
The sequence was: a direct message, a group whose rows had not arrived, and then the direct message again.
`landedRef` still named the direct message, so the return looked like a re-landing of the same visit.
If the reader touched the direct message in the first visit, `touchedRef` was still true.
The landing block did not run, and the view stayed where the old window left it.
The rows that arrived during the group visit were below the screen.
The failure happened only when the middle channel was empty at its first commit.
Fast switching showed it. Slow switching did not.

The fix is one line.
The early return now sets `landedRef.current = null`.
The next channel with rows gets a fresh landing on the rows that exist then.
79-8 added the re-landing, and 79-9 closes the path that bypassed it.

There is no component test, because there is no `MessageList` component test.
Check it by hand on a phone:

1. Open a direct message, and scroll or tap in it.
2. Switch to a group that has not loaded.
3. Switch back to the direct message before the group loads.
4. Make sure a message that arrived in the direct message in the meantime is in view, or that the view is on the "new messages" line.

## The dropped landing (79-10)

The maintainer reported this on an iPhone PWA with the zucker layout, after a fresh start:

1. Open a direct message. The view lands at the bottom.
2. Swipe back.
3. Open a group. The view lands at the bottom.
4. Swipe back.
5. Open the same direct message again.

The view sat near the top of the loaded page, with the newest messages below the screen.
It stayed there until the reader touched it.
The same direct message twice, with no group between, landed correctly.

On the zucker layout the message list unmounts on every trip to the list, so each entry is a fresh mount.
On a first visit the rows arrive after the mount, and the landing runs when they arrive.
On a second visit the rows are already in state.
The landing write runs in the mount commit, about 10 ms after the feed is inserted.
It runs in the same frame as the swap from the list to the feed.

The Chromium probe (iPhone 14 emulation, headless) showed this timeline.
The landing `scrollTo` ran 10 ms after the mount, with the right target and the right scroll height.
The scroller still read offset zero for the next 10 ms to 200 ms.
Then it jumped to the bottom, with no further write logged.
The browser applied the one write late.
Chromium applied it in the end, so the view recovered there.
WebKit evidently does not.
Nothing in the code looked at the view again.
The `ResizeObserver` wakes only on a size change, and no size changed.
The probe did not reproduce the final wrong position.
Before the fix, 5 of 5 entries landed at the bottom.
It showed the window in which the write had not taken effect.

The fix follows the phase 79 rule: settle the target once, and let nothing but the reader move it.
The landing phase is the state that 79-8 defined: the anchor is held and no gesture has happened.
In that phase, the view is held on its anchor in three ways.
Each is a no-op if the view is already there.

1. After the landing write, the landing effect schedules one `requestAnimationFrame` and one `setTimeout` of `LANDING_HOLD_MS` (250 ms). Each measures the gap to the anchor and applies the anchor again if the landing phase is still on. The effect cleanup cancels both. A `landedRef` check stops a late callback from landing a stale channel.
2. The scroll listener applies the anchor again if a scroll event finds the view off the anchor in the landing phase. The instant writes of the list land on the anchor, so they cause no write. No smooth scroll runs in the landing phase, so nothing fights the write. The follow branch is reached only after a gesture or a dropped anchor.
3. The rule is the pure function `landingHoldNeeded(anchor, touched, gapPx)` in `history-paging.ts`. `ANCHOR_SLACK_PX` (1 px) leaves sub-pixel drift alone. `anchorGap` in `MessageList.tsx` measures the gap. For the end, it is the distance from the bottom. For the divider, it is `dividerScrollDelta`.

After the fix, the probe shows that the check adds no write in Chromium.
The late write had taken effect by the next frame.

Known cost: a scroll by an assistive tool, or by find-in-page, in the first 250 ms after a landing is reverted.
The `ResizeObserver` already did this on any size change.
A touch cannot be reverted, because `touchstart` releases the anchor before any scroll event.

The probe cannot show the WebKit result.
Check it by hand on a phone with the zucker layout, with both sequences:

1. Open a direct message, swipe back, open a group, swipe back, and open the same direct message again. Make sure the view is at the newest message.
2. Open a direct message, swipe back, and open the same direct message again. Make sure the view is at the newest message.

The kept probe is `.claude/skills/run-chalk/reentry-landing.mjs`.
It records one timeline per entry, including every write to the scroller offset.

## Where it lives

`web/src/chat/history-paging.ts`, `web/src/components/App.tsx`,
`web/src/components/MessageList.tsx`, `web/src/theme.css`.

## Note on the numbering

The flush-at-the-bottom fix was committed twice under two labels — `4ea3173`
reads `phase 85-1` and `95bf850` reads `phase 79-3` for the same work. It
belongs to 79; phase 85 is operational logging.

The scrollport fix was likewise authored as `79-4`, which `3ae5224` had already
taken for the held-row corrector. It is **79-5**; the comments in
`history-paging.ts` and `MessageList.tsx` were renumbered to match on merge.
