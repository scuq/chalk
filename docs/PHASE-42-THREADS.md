# Phase 42 — durable thread read state and the thread inbox

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.3.45. Extended by 45-3/45-4 (the threads dot), 47
(filter, fade), 48-5, 49 (titles), 62-8.
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

Opening a channel also got faster in this arc: loading a conversation used to
re-count every reply in every thread on the server; it now looks up what it
needs directly.

## Where it lives

`internal/store/messages.go`, `internal/store/channels.go`,
`internal/server/ws.go`, `internal/config/config.go`
(`CHALK_THREAD_ACTIVE_WINDOW_HOURS`), `web/src/chat/threadinbox.ts`,
`web/src/components/ThreadInboxPanel.tsx`.

## Open item

The threads dot's **server total** is only re-synced on a debounced refetch.
Threads whose inbox rows this client does not hold still lag until then —
`threadsNeedingYouCount` corrects only the rows it holds. Listed in CLAUDE.md
under deferred cleanup.
