# Phase 77 — nano markdown

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.6.2.
**Tag:** `#nanomd` → `tools/where.sh -g nanomd`

## Why

Markdown in a chat app is normally a *sender-side* transformation: you type
asterisks, everyone receives emphasis, and the plain characters are gone. chalk
does the opposite, for three reasons.

- **What you typed is never touched.** The composer does not rewrite anything
  and does not preview anything; the message on the wire is exactly the
  characters you entered. Copying a message gives back what was typed.
- **It is your setting and nobody else's.** Rendering happens on the receive
  side, so turning it on affects only your reading. People you write to see the
  plain characters unless they turned it on themselves. A sender cannot impose
  formatting on a reader, and a reader cannot be surprised by it.
- **Three markers and nothing more** — `*bold*`, `_italic_`-style emphasis and
  backtick code. No headings, lists, quotes or link syntax, because each of
  those is a way for a message to restructure someone else's screen, and because
  the escape-hatch problem grows with every construct.

Off by default; enabled under settings → chat.

## What landed

- **77-1 … 77-3** — the `nanomd` parser, the receive-side renderer, and the
  preference.

## Where it lives

`web/src/chat/nanomd.ts` (and `nanomd.test.ts`),
`web/src/components/MessageList.tsx`, `web/src/components/ProfilePanel.tsx`,
`web/src/state/types.ts`, `web/src/theme.css`.

## Notes

Block code is not nanomd's job — that is a first-class message kind, phase 74.
