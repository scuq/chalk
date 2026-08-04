# Phase 33 — unread tracking and read cursors

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.3.20 – v0.3.26. Extended by 42 (threads), 45, 50, 62,
72, 76, 79.
**Tag:** `#unread` → `tools/where.sh -g unread`

## Why

chalk had no idea what you had read. Every reload showed every channel as
equally new, and with the server unable to read message bodies it could not
compute mentions either.

Two design constraints:

- **Read state is per user, not per device**, and it syncs — reading on the
  phone must clear the badge on the laptop. So the cursor lives server-side, as
  a per-user per-channel `last_read_seq`, and is forward-only.
- **Mentions are detected client-side.** The server never sees plaintext, so it
  cannot know a message names you. The client decrypts, scans for its own
  handle, and raises the mention dot locally.

## What landed

- **33-1** — per-user channel read cursors, synced across devices.
- **33-2** — unread and mention dots in the sidebar; client-side `@mention`
  detection.
- **33-3** — right-aligned channel unread dot; resizable sidebar with a clamped
  width preference.
- **33-4** — the "new messages" divider, unread row highlight, and landing on
  the first unread message when a channel opens.
- **33-5** — keep the landing scroll anchored while images finish loading.
- **33-6** — compact row actions on mobile, narrower roster drawer.
- **33-7** — right gutter under full-width message attachments.

## Where it lives

`internal/store/channels.go` (cursor read/write), `internal/server/ws.go`,
`web/src/state/reducer.ts`, `web/src/components/MessageList.tsx`,
`web/src/components/Sidebar.tsx`.

## Notes

The landing behaviour in 33-4/33-5 has been re-tuned repeatedly since — the
anchor kept losing to late-decrypting images and late-arriving history pages.
See 72, 76-3, 79-1..79-3 and the v0.6.1/v0.6.2/v0.6.4/v0.7.1 changelog entries;
`web/src/chat/history-paging.ts` and the `MessageList` landing logic are the
files that carry it.
