# Phase 86 — ties: answering an older message without quoting it

A way to say "this answers that" across the interleaved middle of a busy
channel, without reprinting the message being answered. Designed against
v0.7.2. **NOT IMPLEMENTED — no code exists.** This document is the plan and
nothing below it has been built.

**Status:** design only, written 4 August 2026 from a design session.
**Tag:** `#ties` → `tools/where.sh -g ties` (which today finds this file and
nothing else, because there is nothing else).

## The problem

In a channel with more than two people awake, several conversations run at
once. Somebody asks a question, the topic moves on, and the answer lands six
messages later — by which point nothing in the feed says which question it
belongs to. The same thing happens the other way round: B thinks a subject is
closed, asks A something new, and A's reply to the *previous* subject arrives
after it. This is the oldest failure mode in group chat; IRC and XMPP have it,
and every client since has tried to paper over it.

The paper is quoting: the reply carries a copy of what it answers. chalk is not
doing that. The duplicated body breaks the reading flow — you read the same
sentence twice, once as itself and once as a quote — and a channel where
quoting catches on is twice as long as the conversation in it.

The alternative is to **not repeat the message and point at it instead**. The
relationship is drawn, not written: a quiet mark in the row's gutter, and a
connector between the two rows when you ask for one.

## What it is

A **tie** is a record saying one message answers an earlier one. A chain of
ties is a **strand**.

Not "link" — that word already means link previews (phase 57) and link labels
(phase 67) in this codebase, and a third meaning would make
`tools/where.sh link` useless for all three.

### Decided in the design session

- **At rest it is one glyph.** A tied row carries a small mark in the left
  gutter and nothing else changes. Hovering or focusing either end draws the
  connector and dims the rows outside the strand. A channel where nobody ties
  anything looks exactly as chalk looks today — the feature costs nothing until
  it is used.

  Two alternatives were put up and rejected. *Always-on strand rails*, a
  `git log --graph` for conversation with a lane per concurrent strand: the
  strongest at a glance, but it draws the gutter permanently and a busy channel
  becomes a diagram. *Strand tint*, a colour stripe shared by tied rows: the
  cheapest to build and immune to reflow, but it cannot show direction or say
  *which* message, which is the entire question being asked.

- **Anyone may tie, and the result is shared and attributed.** The answer
  arrives late precisely because its author was not thinking about the tangle,
  so a reader has to be able to untangle it afterwards. Restricting ties to the
  answering author was considered and rejected on exactly that ground: it
  cannot fix a conversation that has already gone sideways, which is when
  anyone notices. Every tie records who drew it, so a wrong one is traceable.
  Private, device-local ties were also rejected — the work would be repeated by
  every reader and help nobody.

- **Ties can also be armed while writing.** Dropping an older message onto the
  composer arms the next message you send as an answer to it: a chip naming the
  message — sender and time, never its text — with an × to drop it.

### Not threads

Threads (42/47/49) move a conversation *out* of the feed into a side panel, on
a server-visible `parent_id`/`thread_id` relation that drives reply counts,
durable read cursors and a cross-channel inbox. A tie leaves everything in the
feed, adds no panel, no counter and no cursor, and the server never learns what
it points at. They answer different questions — "take this elsewhere" versus
"this belongs with that" — and would coexist unchanged.

## The record

Clone the reactions pattern. `internal/store/reactions.go` and
`migrations/0045_message_reactions.sql` are chalk's reference implementation of
a sealed per-user side record hanging off a message, and a tie is the same
shape in every respect:

- **One row per (message, tie author)**, holding that author's whole tie set.
- **Whole-set replace, no add/remove verb** — the reasoning at
  `internal/proto/frames.go:857` applies unchanged: it makes a double-click and
  a second device converge instead of drifting.
- **Absence == empty.** Clearing DELETEs the row rather than storing a sealed
  empty list.
- **The body is sealed** with `sealJSONForChannel`
  (`web/src/crypto/channel-crypto.ts:891`), so the server learns that user X
  tied *something* to message Y and when — **not what it points at**.

Sealed payload:

```json
{"v":1,"to":[{"id":"<uuid>","seq":<n>}]}
```

The target's `seq` rides along so the client's backfill crawl knows when to
stop looking (below). It is server-supplied metadata already, so sealing it
costs nothing. Cap at `TIE_MAX_TARGETS = 4`, re-applied **on parse** as well as
on send: the server never saw the payload and cannot enforce a cap, which is
the same reason link previews re-apply theirs
(`web/src/linkpreview/linkpreview.ts:121-123`).

### Rejected: a column beside `parent_id`

A `ties` table of plain `(from_id, to_id)` rows, or a nullable column on
`messages`, would be cheaper, queryable, and would let the server count things.
It also hands the server the entire reply graph of every channel in plaintext —
who answers whom, and how the conversation actually branches — which is a
richer social graph than anything chalk leaks today. The sealed side record
costs one extra round trip per loaded window and keeps the graph off the
server. Given that `parent_id` is *already* a plaintext relation the threat
model calls out, adding a second one voluntarily would be moving backwards.

### Direction is normalised, not chosen

On creation the client compares `seq` and always hangs the tie off the *later*
message, pointing back at the earlier one. So drag direction does not matter —
dropping A on B and B on A produce the same record — and "this answers that" is
the only relation that can exist. There is no forward tie to render, no
ambiguity to explain in the UI, and no cycle a naive graph walk could hit.

Removal follows the reactions rule exactly: the tie's author drops the target
from their own set, and an empty set clears the row. No new authorization
concept is needed.

## Rendering

**The mark.** `button.chalk-tie-mark` in the row's left gutter
(`--chalk-msg-gutter`, `web/src/theme.css:7886`, the strip that already holds
the `⋮` menu marker) — solid on a row that answers something, hollow on a row
that was answered, so a question visibly got picked up. Its `title` and
`aria-label` name both ends and the tie's author: "answers alice, 14:02 — tied
by carol".

**The strand highlight.** Hover or focus on a marked row adds
`.chalk-message--strand` to every row in the strand and one class to the
container; a single CSS rule dims `.chalk-message:not(.chalk-message--strand)`.
One container class plus N row classes, rather than touching every row in the
feed.

**The connector.** One absolutely positioned element inside `.chalk-messages`
(made `position: relative`), measured from the rows'
`offsetTop`/`offsetHeight` — **layout coordinates, not viewport ones**, so
scrolling can never invalidate it. Recomputed when the strand changes and on
the `ResizeObserver` that already exists at
`web/src/components/MessageList.tsx:610`.

It **must** be `pointer-events: none`. `topRowAnchor`
(`MessageList.tsx:284-302`) hit-tests with `document.elementFromPoint`, and a
hit-testable overlay spanning the feed would silently disable 79-4's scroll
correction — the bug would look like "the feed jumps again while images load",
with nothing pointing at the overlay.

**Clicking the mark** jumps to the other end and flashes it, reusing
`flashMessage` and its backfill crawl (`web/src/components/App.tsx:4293-4345`),
which already pages backwards until a target id appears. The sealed `seq` is
what it takes as its stop condition. If the target is not loaded yet, the mark
says so rather than drawing a line into nothing.

**Mobile.** Under `@media (hover: none)` (`theme.css:8794`) the gutter is 0px
and the `⋮` marker is hidden, so the mark moves inline to the head of the body
span. Tap jumps and flashes. There is no hover arc; the connector draws briefly
if both ends happen to be on screen.

## Making a tie — pick mode is the primitive, drag is the shortcut

**Pick mode** works with keyboard, touch, and any distance. The message menu
(`web/src/chat/message-menu.ts:38`) gains "tie to…", which puts the feed into
pick mode: a banner ("pick the message this answers · Esc to cancel"), rows
take a crosshair and a hover outline, and a click commits. Scrolling and
scrollback paging keep working, so a target hundreds of messages up is
reachable. `t` while hovering a row arms it, mirroring the existing `r`
shortcut (`MessageList.tsx:531-548`); `t` on the target commits; Esc cancels.

**Drag** is the fast path for what is already on screen. The `⋮` marker
(`MessageList.tsx:1096`) becomes `draggable`, using HTML5 drag-and-drop with a
custom `application/x-chalk-message-id` type — the same API the attachment drop
zone uses (`web/src/components/Composer.tsx:849-871`). Deliberately **not** a
pointer-event drag: that would collide with the row's own long-press timer
(`MessageList.tsx:1054`) and with swipe-back
(`web/src/chat/use-swipe-back.ts`), both of which already own the press and the
horizontal drag on touch.

**Composer arming** is a second menu item ("answer this") plus dropping a
message onto the composer. Either sets a pending tie and shows the chip. The
real message id only exists once `send_ack` comes back
(`internal/proto/proto.go:206`), so the `set_ties` call is issued from the
`send_ack` handler, not from `onSend`.

## Slices, if it is ever built

- **86-1 — the rules, pure.** New `web/src/chat/ties.ts` + `ties.test.ts`:
  `TieTarget`/`TieSet`, `orient(a, b)` by `seq`, set-replace helpers mirroring
  `chat/reactions.ts:65`, `TIE_MAX_TARGETS`, `aggregate` across authors
  (first-appearance order, deduped, carrying author ids for attribution — same
  ordering rationale as `chat/reactions.ts:28`), and `strandOf`, the transitive
  closure with a cycle guard and a size cap. No wire, no UI.
- **86-2 — the server vertical.** `migrations/0051_message_ties.sql`
  (`message_ties`, PK `(message_id, message_ts, user_id)`, composite FK
  `(message_ts, message_id) → messages(ts, id) ON DELETE CASCADE`,
  denormalised `channel_id` for the batch read — 0045's header explains why
  both denormalisations are there); `internal/store/ties.go` with `SetTies`,
  `GetTie`, `ListTiesForMessages`, `ScrubTiesForMessageTx`, the last called
  from `DeleteMessage`'s transaction (`internal/store/messages.go:304`); frames
  `set_ties` / `set_ties_ack` / `tie_update` / `fetch_ties` / `fetch_ties_ack`
  plus `TieWire` in `internal/proto/frames.go`; `handleSetTies` and
  `handleFetchTies` in `internal/server/ws.go` following `handleSetReactions`
  (`ws.go:3905`) — membership, key-version gate, `GetMessageAtWireTS` for the
  full-precision ts the FK needs, tombstone refusal, ack, publish with `UserID`
  and no echo suppression — plus the `readLoop` dispatch entries; pubsub kind
  `"tie"` (`internal/pubsub/notifier.go:59`) and `handleTieEvent` beside
  `handleReactionEvent` (`internal/server/server.go:769`). Ties stay **out** of
  the guest allowlist (`internal/server/guest_ws.go:50`), where reactions
  already are not. Watch the three-site rule on every new SELECT/scan pair.
  Ships a store `_test.go` under the `openProbeDB` harness
  (`internal/store/probe_db_test.go:26`) — reactions never got one, and this is
  the cheap moment not to repeat that.
- **86-3 — client transport and state.** `web/src/proto.ts` mirrors;
  `AppState.ties: Record<string, TieSet[]>` beside `reactions`
  (`web/src/state/types.ts:754`); actions `tie_set` (live push) and
  `ties_merged` (batch), modelled on `web/src/state/reducer.ts:1115-1147`;
  sealed and opened with `sealJSONForChannel` / `openJSONForChannel`; the
  backfill `useEffect` keyed on `(activeChannelID, historyLoaded, ccReady)`
  exactly like `App.tsx:1017-1028`. Ties drop on tombstone and on the
  voice-scratch purge wherever reactions already do (`reducer.ts:991`, `:527`).
  New `web/src/state/reducer-ties.test.ts`.
- **86-4 — the mark and the jump.** The gutter mark, its mobile placement, and
  click → `setFlashMessage` with the sealed `seq`. First slice a user can see,
  so the `CHANGELOG.md` bullet lands here.
- **86-5 — the connector.** Strand classes, the measured element, the dim rule,
  `ResizeObserver` recompute, `pointer-events: none`.
- **86-6 — making a tie.** `buildMessageMenu` gains its two items (plus its
  test); pick mode with the banner, the `t` shortcut and Esc; drag from the `⋮`
  marker; rows as drop targets.
- **86-7 — composer arming.** Drop-on-composer (extend `Composer.tsx:849-871`
  with a `dragHasMessage` check, mounted independently of `enableAttachments`),
  the chip, and the `send_ack`-triggered `set_ties`.
- **86-8 — the record.** `docs/threat-model.md` gains ties to its metadata list
  ("that user X tied something to message Y and when — not to what") and to the
  phase-83 caveat.

## What each piece would reuse

| Need | Existing thing to copy or call |
|---|---|
| Sealed per-user side record | `internal/store/reactions.go`, `migrations/0045_message_reactions.sql` |
| Wire frame set (set/ack/push/fetch) | `internal/proto/frames.go:857-916` |
| Server handler shape | `handleSetReactions` `ws.go:3905`, `handleFetchReactions` `:4023` |
| Re-read-and-fan-out broadcast | `handleReactionEvent` `server.go:769` |
| Seal / open a JSON payload | `channel-crypto.ts:891` / `:902` |
| Batch backfill after a history page | `App.tsx:1017-1028` |
| Reducer set/merge pair | `reducer.ts:1115-1147` |
| Jump to a message not yet loaded | `flashMessage` + crawl `App.tsx:4293-4345`, scroll side `MessageList.tsx:708-724` |
| Row identity in the DOM | `data-message-id` (`MessageList.tsx:1045`) |
| Hover-key shortcut | the `r` handler `MessageList.tsx:531-548` |
| HTML5 drag and drop | `Composer.tsx:849-871`, `web/src/attachments/intake.ts:39-60` |
| Long-press constants | `web/src/chat/press.ts` |
| DB-backed store test harness | `internal/store/probe_db_test.go:26` |

## Open items the design leaves

- **Whole chain or just the pair.** Whether the hover highlight follows the
  whole transitive strand or only the directly tied pair is not settled.
  `strandOf` would expose both behind one call; 86-5 picks by eye on real
  traffic and this document records which and why.
- **Phase 83 inheritance.** A tie is unsigned server-supplied metadata, exactly
  like a reaction, so it inherits the sender-authenticity gap
  (`docs/threat-model.md`, "Sender authenticity — NOT met") until the signed
  message envelope lands. A malicious server could fabricate the *existence* of
  a tie by user X on message Y; it still could not say what the tie points at,
  because that is sealed.
- **A tie whose target is deleted.** The server cannot scrub it — it cannot
  read the target id — so the mark resolves to the tombstone row and reads as
  "answers a deleted message". That is the intended behaviour, not a hole, but
  it is worth asserting in a test rather than discovering.

## Verification, when built

The full chain — `go build ./... && go vet ./... && gofmt -l .`, `go test
./...`, and from `web/`: `npx tsc --noEmit`, `node test.mjs`, `node build.mjs`
— plus the store test under `CHALK_TEST_PGURL`, which is the only thing that
would exercise the real Postgres upsert and the composite FK.

Then a two-user live run through the `run-chalk` skill:

1. A asks a question; B and C interleave a second conversation; A answers late.
2. B drags A's answer onto A's question — the mark appears for both users
   without a reload, attributed to B.
3. Hovering either end draws the connector and dims the interleaved rows.
4. Scroll back until the question leaves the DOM, then click the mark on the
   answer: the crawl backfills and the row flashes.
5. Drop a message onto the composer and send: the chip names it, the sent
   message comes back tied, and the body contains no quoted text.
6. Phone viewport: the mark renders inline, tapping it jumps, long-press still
   opens the message menu, and swipe-back still works over a tied row.
7. Delete a tied message and confirm the tie row goes with it; delete a
   *target* and confirm the mark resolves to the tombstone rather than
   dangling.
