# Phase 76 — shortcuts move to settings (and two landing fixes)

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.6.2.
**Tags:** `#settings`, `#mobile`, `#unread` → `tools/where.sh -g settings`

## Why

- **The shortcut sheet was in the wrong place.** It sat behind a `?` beside the
  send button, taking composer width chalk no longer had on a phone. A cheat
  sheet is something you read once, so it belongs in settings (chat → keyboard
  shortcuts), not next to what you are typing. 70-4 had already had to fight
  Safari over its layout there.
- **Code cards ate the back swipe.** A card scrolls sideways, so any touch that
  started on one was treated as panning the snippet — even when it was already
  at its left edge with nothing to pan, which left the gesture dead over every
  code message.
- **The unread landing was too literal.** Any unread message at all parked you
  at the "new messages" line with the newest message below the fold — on a
  phone, nearly every time you came back from the conversation list. A short run
  of new messages now lands you at the newest one with the line still visible
  above it; a run taller than the screen still lands at the line, where you
  would otherwise have to scroll up to find what you missed.

## What landed

- **76-1** — shortcuts move into settings.
- **76-2** — swipe back works over a code card.
- **76-3** — land at the bottom for a short unread run.

## Where it lives

`web/src/components/ProfilePanel.tsx`, `web/src/components/Composer.tsx`,
`web/src/chat/use-swipe-back.ts`, `web/src/chat/history-paging.ts`,
`web/src/components/MessageList.tsx`.

## Notes

The landing rule kept moving after this: 79-1 (divider below the pinned header),
79-2 (settle the target once so a decrypting photo cannot drag the reader off
the newest message) and 79-3 (flush at the bottom).
