# Phase 113 — day marks: which day am I reading?

**Status:** built, 113-1 – 113-3 (2026-09-07). Verified against a running
stack: a channel of twenty messages backdated across four calendar days, 13
checks on the real DOM (labels, the suppression rule, the measured inset, the
stacking order and 79-4's keep-anchor probe).
**Tags:** `#daymarks` → `tools/where.sh -g daymarks`

## The problem

Scroll back through a channel and the feed tells you the time and nothing else.
A row says `22:53:01`; it does not say whether that was tonight, last Tuesday,
or in March. The full date does exist — it has always been on the `title`
attribute of the time span, and on the whole row when timestamps are switched
off — but a native browser tooltip is the wrong instrument for this:

- it takes about a second of holding still to appear, so it cannot answer the
  question *while you are scrolling*, which is exactly when the question is
  asked;
- it is undiscoverable — nothing suggests the timestamp is hoverable;
- it does not exist at all on touch, and chalk has a phone layout.

The `relative` timestamp format makes it worse rather than better: past a week
`fmtRelative` degrades to `Sep 3` with no year, and between one and seven days
it says `3d ago`, which is a fact about now rather than a place in the
conversation.

## The design

**A day mark in the flow, one per calendar day, pinned while you read it.**

Two decisions carry the phase.

### The boundary is derived, never stored

`web/src/chat/daymarks.ts` is pure: it takes the timestamps the list is about
to render and `now`, and returns a map of row index → label. Nothing is added
to the wire, the schema, the store or the client cache. A day mark is a fact
about two adjacent rows, so it survives paging, filtering (thread replies are
already excluded from the main feed's array), edits and deletions for free —
the map is recomputed from whatever the list is holding this render.

Local time is the only frame of reference. A message's day is the day it was
*for the reader*, not for the sender and not UTC, so the key is
`YYYY-MM-DD` off `getFullYear`/`getMonth`/`getDate` and a reader who flies to
another timezone sees their history re-cut around their new midnight. That is
the right answer even though it means two readers of the same channel can
disagree about where a boundary falls.

### The leading mark is suppressed when it is today's

The rule that keeps this from being clutter. A boundary between two rows always
gets a mark. The *first* loaded row gets one too — otherwise the top of the
window is the one place with no answer, which is where the question is loudest —
**except when that day is today**, in which case there is nothing to say and the
mark is omitted.

The consequence is that a channel you are reading live, where everything loaded
is from today, renders exactly as it did before phase 113: no marks, no extra
rows, nothing moved. Marks appear only once history reaches back past midnight,
which is the only time they carry information. It also keeps the thread panel
and a quiet DM clean, since both are usually a handful of same-day rows.

### The label

Hand-rolled and lowercase, matching `fmtRelative` and the rest of chalk's UI
text (`new messages`, `loading older…`, `— beginning of channel —`), rather than
`toLocaleDateString`:

| distance | label |
| --- | --- |
| today | `today` |
| yesterday | `yesterday` |
| 2–6 days back | `thursday` |
| older, this year | `thu 3 sep` |
| older, another year | `thu 3 sep 2025` |
| in the future (clock skew) | full form |

Day-before-month throughout. The weekday is kept on the older forms because in
a conversation "which Thursday" is usually the question, and the calendar date
alone does not answer it.

### Sticky, at the header's own inset

The mark is `position: sticky` inside the feed, so while you scroll back the
current day's label stays at the top of the scrollport and swaps as you cross
a boundary. This is what actually answers the complaint — the in-flow marks
alone tell you where the boundaries *are*, but a reader parked in the middle of
a long day still sees no date.

Two things make that work:

**The inset is measured, not guessed.** The sticky channel header
(`.chalk-channel-headwrap`) is a sibling of the feed inside the same scroller,
and its height is not a constant — phase 111 put a banner image inside it. So
an effect measures the scroller's sticky children (computed `top` plus border-box
height, which is exactly where a stuck box's bottom edge lands) and writes the
maximum to `--chalk-daymark-top` on the feed root. `pinnedBottom` in
`daymarks.ts` is that arithmetic, extracted so it can be tested; the same
ResizeObserver contract as 79-5 keeps it current when the banner or the header
changes size. Where nothing is pinned — the thread panel, the voice scratchpad
— it measures 0 and the mark sticks to the top of the pane.

**The stuck mark is `pointer-events: none`.** Not cosmetic: 79-4's `topRowAnchor`
finds the row the reader is holding by probing `elementFromPoint` at
`pinnedTopInset + 1`, and a sticky mark sitting at exactly that point would
swallow the probe and return `null` — the keep-anchor would quietly stop
correcting for late-loading images. A label with nothing to click loses nothing
by being transparent to hit-testing, and the probe passes through it.

**And it sits at a HIGHER z-index than the header it tucks under** (6 against
the header's 5), which looks backwards and is not. The two boxes never overlap
— the mark's top edge *is* the header's bottom edge, by measurement. But the
header paints a background-coloured strip `--chalk-s3` tall *below* itself
(`box-shadow: 0 var(--chalk-s3) var(--chalk-bg)`) to hide the feed showing
through its own transparent margin, and that strip is 12 of the mark's 17
pixels. Built at z-index 4, the mark measured and positioned perfectly and was
painted out — label included — so it read as no mark at all. This is the one
thing here no unit test could have caught, and the probe now guards it by
asserting the stacking order rather than by hit-testing (which
`pointer-events: none` makes useless on purpose).

**Marks stack rather than push.** Every mark is a direct child of the same
flex container, so sticky siblings all stop at the same offset and pile up
instead of shouldering each other out the way section headers do. Harmless as
built: the mark painted on top is the last in DOM order among those stuck —
which is the most recent boundary the reader has scrolled past, i.e. the day
they are reading — and each is fully opaque, so the ones underneath never show.
Making them push would mean wrapping each day's rows in a section, and the flat
row list is load-bearing for the unread divider and for the `display: contents`
groups.

Ordering where a day boundary and the unread divider land on the same row: the
day mark first, then `new messages`, then the row. The unread divider must stay
immediately above the first unread message, because 79-1's landing scroll aims
at it and the reader reads it as "everything below this is new".

## What was rejected

**A floating date pill that fades in only while scrolling** (WhatsApp, Telegram).
Less clutter still, but it needs a scroll handler and a dismissal timer, it
gives nothing when the feed is idle, and it puts a second floating element over
a feed that already has a sticky header and a row menu.

**Upgrading the tooltip to chalk's own `HoverCard`.** The cheapest change and
the one the complaint literally asked about, but it keeps every weakness of the
native tooltip except the delay: still per-message, still mouse-only, still
one answer at a time, and still nothing while scrolling.

**A date column beside the time.** A second column in every row, carrying
information that is identical for hundreds of consecutive rows. This is the
clutter the request was about.

**Marking the boundary on the row itself** (a hairline plus a date on the first
message of each day). Fewer DOM nodes than a divider row, but it cannot be
sticky — the row scrolls away with its message — so it solves half the problem.

## The slices

- **113-1 — the mark in the flow.** `web/src/chat/daymarks.ts` (`dayKey`,
  `dayLabel`, `dayMarkIndices`, `pinnedBottom`) plus `daymarks.test.ts`;
  `MessageList` renders `.chalk-day-divider` at each marked index, above the
  unread divider; theme rules modelled on `.chalk-unread-divider` but muted.
  Suppressed entirely in the voice scratchpad (`ephemeral`), which is one
  session's worth of rows and has no history to scroll back through.
- **113-2 — sticky, at the measured inset.** `--chalk-daymark-top` written by a
  ResizeObserver-backed effect from `pinnedBottom` over the scroller's sticky
  children; `position: sticky` and `pointer-events: none` on the mark.
- **113-3 — the reader's switch.** `chat.dayMarks` in `ChatPrefs` /
  `ResolvedChatPrefs`, defaulted **on** in `selectChatPrefs`, surfaced as
  **settings → chat → show the date between days** and reachable from the
  settings search. Account-synced like the rest of the chat prefs rather than
  per-device: which time signals a conversation carries is a decision about
  your chalk, not about this browser.

## Left open

- **The label is English and hand-rolled.** Deliberate — it matches
  `fmtRelative`, which has the same property, and chalk has no i18n layer for
  either to plug into. A future i18n phase takes both at once or neither.
- **Timestamps switched off still get day marks**, and 113-3's switch is
  deliberately *not* disabled when `showTimestamps` is off (the way the
  timestamp-format select is). With no time on the rows the day line is the
  only answer left to "when was this?", so chaining it to the timestamp switch
  would take away the one signal a reader who wants quiet rows is most likely
  to still want.
