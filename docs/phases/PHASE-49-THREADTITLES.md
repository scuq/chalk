# Phase 49 — thread titles, jump-to-origin, and composer parity

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.3.54.
**Tag:** `#threads` → `tools/where.sh -g threads`

## Why

Threads were identified by their channel and their last replier, which is not
enough to tell two threads in the same channel apart without opening both. The
obvious fix — a title field — is not available to chalk: the server cannot read
message bodies, so it cannot store or index a title.

So titles are **derived on the client** from the decrypted head message, every
time. An attachment-only head has no text to derive from, so it is titled by
what it is: `[image]`, `[file]`, with a count when there are several, and the
thread panel shows the filename (`image: cat.png`).

The reply composer was also a second-class citizen — its own differently-padded
box with no attach, paste, drag-drop, GIF or emoji, and a failed reply lost its
text. Parity with the channel composer was the point.

## What landed

- **49-1** — threads titled by their head message, plus a "show message" button
  that scrolls the channel to the origin and highlights it, loading older
  history first when it is further back than what is on screen.
- **49-2** — attachment-only thread heads titled `[image]` / `[file]`, filename
  shown in the panel.
- **49-3** — drop the header pop-out button, superseded by PWA install
  (phase 36).
- **49-4** — caption text no longer hidden under a pasted image.
- **49-5** — thread reply composer gets the full tool rail and feed alignment,
  and a threads entry in the sidebar between friends and channels, so everything
  that can show an unread dot is in one column.

## Where it lives

`web/src/chat/threadtitle.ts`, `web/src/components/ThreadPanel.tsx`,
`web/src/components/ThreadInboxPanel.tsx`, `web/src/components/MessageList.tsx`,
`web/src/components/Sidebar.tsx`.
