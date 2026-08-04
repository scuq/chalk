# Phase 74 — paste a code block, send it as a card

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.6.1.
**Tag:** `#code` → `tools/where.sh -g code`

## Why

Pasting a snippet into a chat composer destroys it: indentation collapses, long
lines wrap into nonsense, and the proportional font makes columns meaningless.
The usual answer is markdown fences, which chalk deliberately did not have (and
still only has in the narrow form of phase 77).

So code is a **first-class message kind**, not a formatting convention:

- A dedicated composer (the CODE button beside emoji / file / GIF), so nothing
  has to be parsed out of ordinary text and nobody's triple-backtick prose gets
  swallowed.
- Rendered as a card that keeps indentation and line breaks, stays fixed-width
  whatever font the reader chose, and **scrolls sideways instead of wrapping**.
- Optional language label and an accompanying message.
- One-click copy of the snippet alone, without the surrounding chatter.
- Long snippets fold so they do not bury the conversation.
- **Search sees inside it** — the code body joins the search haystack, not just
  the message around it.

## What landed

- **74-1 … 74-4** — the code payload and its sentinel, the paste modal, the card
  renderer with copy and fold, and the search/preview integration.

## Where it lives

`web/src/code/code.ts`, `web/src/components/CodeModal.tsx`,
`web/src/components/CodeBlockView.tsx`, `web/src/components/Composer.tsx`,
`web/src/chat/bodytext.ts`, `web/src/chat/search.ts`, `web/src/chat/zucker.ts`.

## Notes

A code card scrolls horizontally, which ate the mobile back swipe over every
code message — fixed in 76-2, which only treats the touch as panning when the
card actually has somewhere to pan.
