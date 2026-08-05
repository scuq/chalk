# Phase 42 — durable thread read state and the thread inbox

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.3.45. Extended by 45-3/45-4 (the threads dot), 47
(filter, fade), 48-5, 49 (titles), 62-8, and 42-10 (the pane refetches).
**Tag:** `#threads` → `tools/where.sh -g threads`

## Why

Threads existed but had no memory. Each device kept its own private idea of what
had been read, so reading a thread on the phone left the badge lit on the laptop
forever, and a fresh browser treated every thread ever read as new again. There
was also no way to see threads across channels — a reply in a quiet channel
simply slipped past.

Design decisions:

- **Thread read state is server-side and per user**, like phase 33's channel
  cursors, and forward-only. Clearing a badge anywhere clears it everywhere.
- The inbox has **two groups with different retention rules**: *needs you* (a
  thread you took part in, or one that named you, with an unread reply) is
  listed however long ago it went quiet — nothing is dropped for being old;
  *also active* is anything else replied to recently, where "recently" is
  `CHALK_THREAD_ACTIVE_WINDOW_HOURS` (default two days, also a `chalkctl init`
  flag).
- Previews are decrypted on the device. The server ships ciphertext and a count.

## What landed

- **42-1 … 42-8** — durable cross-device thread read state and the
  active-threads inbox: store primitives, wire frames, the panel with its two
  groups, per-row channel / last replier / reply count / one-line preview, and
  click-through into the thread.
- **42-9** — focus the composer on channel entry and the thread composer on
  thread open (revisited in 62-8 for the inbox's preview freshness).
- **42-10** — the thread pane refetches its replies on open, on reconnect and
  on returning to the tab. See below.

Opening a channel also got faster in this arc: loading a conversation used to
re-count every reply in every thread on the server; it now looks up what it
needs directly.

## Where it lives

`internal/store/messages.go`, `internal/store/channels.go`,
`internal/server/ws.go`, `internal/config/config.go`
(`CHALK_THREAD_ACTIVE_WINDOW_HOURS`), `web/src/chat/threadinbox.ts`,
`web/src/components/ThreadInboxPanel.tsx`. 42-10 adds
`web/src/components/App.tsx` (the fetch effect and its in-flight ref),
`web/src/components/ThreadPanel.tsx` and `web/src/state/reducer.ts`
(`thread_loaded`).

## 42-10 — the pane was the one surface that never refetched

Reported from a phone: *"sometimes the threads are not updated when you reopen
them. You see from the outside that there's something new, but when you open the
thread you don't see the messages."* The screenshots showed the feed's summary
line under the head (`↳ 17 replies` plus the newest reply's text) naming a reply
the open pane did not contain.

`fetch_thread` was gated on `state.threadLoaded[threadID]`, which nothing ever
cleared — not `close_thread`, not a channel switch, not a reconnect. So a
thread's replies were fetched **once per session** and after that only grew by
live `message` pushes. A phone that backgrounds the tab kills the socket, and
replies landing in that window are never pushed either: the pane kept its
pre-disconnect list for the rest of the session, with no loading state, because
`loaded` was still true.

Everything around it already recovered, which is what made the mismatch visible.
The feed's summary comes off the head row, and the reconnect history refetch
(`ensureKeyFor`) overwrites it with the server's `thread_activity` counters. The
inbox refetches once per connect and again on every panel open. Only
`threadMessages` had no path back.

Two things made it worse than a stale list. `open_thread` bumps `threadSeen` to
`max(local max reply seq, head.lastReplySeq)`, so opening the thread cleared its
"new" dot from the head's server pointer even though the replies behind it were
never fetched — the badge went away and the message did not appear. And the
`mark_thread_read` effect derives its seq from the same stale list, so the
durable cross-device cursor was advanced to a stale value.

The fix splits the two things `threadLoaded` was doing. A new
`threadFetchInFlightRef` in App.tsx tracks the *request* (the pattern
`historyRequestedRef` already sets, including being cleared on reconnect —
`fetch_thread` errors come back as a generic `sendError` with no thread id, so a
request lost to a dropped socket would otherwise wedge that thread shut).
`threadLoaded` keeps only its *ack* meaning, driving the panel's "loading
replies…" placeholder. The effect then fires on `openThread`, on `wsState` and
on `tabVisible`.

No loading flash falls out of `thread_loaded` already merging by message id
rather than replacing: the replies on screen stay there for the whole round
trip, and the server's copy of any row wins.

Rejected: clearing `threadLoaded` to force the refetch (it blanks a thread the
user is reading), and a timed poll. The accepted cost is one ≤50-row frame per
user gesture — an alt-tabbing desktop user re-asks on each focus. Bounded by
gestures, no timer. A per-thread cooldown is the next step if phase 85's
slow-request log ever shows it, and would itself have to be cleared on reconnect
or it re-introduces this bug in miniature.

### Open follow-ups from 42-10

- **History's reply rows still never reach the thread they belong to.** The
  initial and reconnect `fetch_history` pages do not set `heads_only` (only the
  "load older" path does), so they carry reply rows — merged into
  `state.messages`, filtered out of the feed by App.tsx's `!m.parentID`, and
  routed nowhere. Fetched, decrypted, rendered nowhere. Routing them into
  `threadMessages` (keyed `threadID ?? parentID`, never setting `threadLoaded`)
  would repair closed threads before the user opens one. Its own slice: a
  different layer, independently revertable, and partial by nature since "load
  older" pages carry no replies at all.
- **A thread past 50 replies is silently truncated.** The client sends
  `fetch_thread` with neither `before_seq` nor `limit`, so the server default of
  50 applies, the ack carries no `has_more`, and the panel has no paging UI.
  Wants a wire field plus a "load older replies" path.

### How 42-10 was verified

The failure is a dropped socket, which no `*.test.ts` can stage, so it has a
kept `run-chalk` script: `.claude/skills/run-chalk/thread-refresh.mjs`. Two
users; A opens the thread and closes it; A's socket is cut; B posts replies; the
socket comes back; A reopens. Both the reopened and the left-open case, on
desktop and under iPhone 14 emulation, plus the mismatch the report was actually
about — the feed's summary preview naming a reply the pane does not contain.

It is a real regression test, not just a smoke run: restoring the old
`threadLoaded` guard takes it from 8/8 to 2/8, and the failure it prints is the
reported one verbatim (`preview=… offline reply four` beside
`paneTail=reply one`).

One finding is worth keeping even if the script is ever rewritten:
**`context.setOffline(true)` does not touch an established WebSocket.** Pushes
flow straight through it, so an offline-based version of this passes 8/8 against
the buggy build — it never stages the failure at all. Cutting the socket takes
`routeWebSocket`: proxy it, close the live one, refuse the reconnects until the
window is over.

## Open item

The threads dot's **server total** is only re-synced on a debounced refetch.
Threads whose inbox rows this client does not hold still lag until then —
`threadsNeedingYouCount` corrects only the rows it holds. Listed in CLAUDE.md
under deferred cleanup.
