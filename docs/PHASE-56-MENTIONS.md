# Phase 56 — composer @mention autocomplete

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.4.7.
**Tag:** `#mentions` → `tools/where.sh -g mentions`

## Why

Mentions already worked — a message naming `@your_handle` highlights it and
marks the channel (phase 33-2, client-side, since the server cannot read
bodies). But you had to know a member's exact handle and type it blind, which
makes the feature useless for anyone you have not just been talking to.

The completion source is the **channel's member list the client already holds**,
not a server query: there is no lookup frame and no round trip, so it works
offline-ish and leaks nothing about who you are about to mention.

## What landed

- **56-1** — composer `@mention` autocomplete: pops on `@`, narrows as you type,
  arrow keys or mouse to pick, Enter or Tab to complete, Escape to dismiss.
  Works in thread replies and while editing a message, not only in the channel
  composer.

## Where it lives

`web/src/chat/mention-complete.ts` (and its test),
`web/src/chat/mentions.ts` (the detection side, from 33-2),
`web/src/components/Composer.tsx`, `web/src/theme.css`.
