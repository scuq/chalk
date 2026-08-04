# Phase 69 — attachment refs on history pages, and the pinned header on desktop

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.5.6.
**Tags:** `#attachments`, `#history` → `tools/where.sh -g attachments`

## Why

**Old pictures rendered as an empty row.** Attachments were backfilled by a
separate windowed query — `GET /api/attachments` over
`CHALK_ATTACH_FETCH_WINDOW_HOURS` — so any image older than that window, or
simply the newest message in a quiet channel, arrived with the message but
without its refs and drew as a sender line with nothing under it. The fix is to
carry attachment refs **on the history page itself**, where they belong: the
page that delivers a message delivers what the message points at.

**The room name scrolled away on desktop.** 60-2 pinned it on phones; the same
argument applies to a scrolled-back desktop feed, plus the search button stays in
reach. The gap under the pinned bar also needed an opaque strip — a clipped line
of text could otherwise show through it while scrolling.

## What landed

- **69-1** — history pages carry attachment refs; images older than the fetch
  window render again.
- **69-2** — pin the channel header on desktop too; opaque strip under the
  pinned bar.

## Where it lives

`internal/store/messages.go` / `internal/store/channels.go` (the history query),
`web/src/components/MessageList.tsx`, `web/src/components/AttachmentView.tsx`,
`web/src/theme.css`.

## Open item

69-1 made the client's windowed attachment backfill **redundant**. The App.tsx
`listAttachments` effect, the `GET /api/attachments` endpoint, the
`ListAttachmentsForChannelWindow` query and `CHALK_ATTACH_FETCH_WINDOW_HOURS`
should be dropped together. Listed in CLAUDE.md under deferred cleanup.
