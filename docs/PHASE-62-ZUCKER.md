# Phase 62 — zuckermode: a conversation list as the phone home screen

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.5.0 (62-1…62-7), v0.5.1 (62-8, 62-9).
**Tags:** `#unread`, `#roster` → `tools/where.sh -g unread`

## Why

chalk's desktop model — a sidebar of channels beside a message pane — does not
translate to a phone, where the natural shape is one list of every conversation,
newest first, tapped to open full screen. Phase 32 made the desktop layout fit a
phone; phase 62 offers a different layout instead, opt-in, phone-only, with
desktop keeping the classic sidebar either way.

The hard part is not the list, it is **sorting and previewing it without a
server that can read messages**:

- The server keeps a `channel_activity` index — *when* each channel last had a
  message, never *what* — so the list can be ordered without a full history
  fetch per row.
- The channel listing carries the **newest message's ciphertext**, decrypted on
  the device for the preview line. The server still never reads a message.

## What landed

- **62-1 / 62-2** — `channel_activity` index and newest-message ciphertext in
  the channel listing.
- **62-3 … 62-5** — client activity state, the conversation-list module, and the
  zuckermode preference.
- **62-6 / 62-7** — zuckermode itself: one list of people and channels, unread
  dots, parking lot and thread inbox pinned above it, the friends and channels
  "+" buttons moved into its header, full-screen conversation with a back arrow.
- **62-8** — ping-timeout closes use app code 4008 so the client auto-reconnects
  instead of stranding on a "ping timeout" error; and keep the conversation
  list's newest-message pointer honest across send, history load and receive.
- **62-9** — auto-rejoin the voice room after a socket drop, without stealing
  focus from whatever channel you were reading.

## Where it lives

`internal/store/channels.go`, `internal/store/messages.go`,
`internal/proto/frames.go`, `internal/server/ws.go`,
`web/src/chat/zucker.ts` (and `zucker.test.ts`),
`web/src/components/ZuckerList.tsx`, `web/src/state/reducer.ts`
(and `reducer-activity.test.ts`).

## Notes

64 (mobile swipe-back and the friends row), 78 (hidden channels honoured in the
list) and 79 (landing) all extend this surface.
