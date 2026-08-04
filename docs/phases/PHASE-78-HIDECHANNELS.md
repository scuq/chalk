# Phase 78 — hidden channels

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.6.3.
**Tag:** `#roster` → `tools/where.sh -g roster`

## Why

A channel you do not want to look at right now is not a channel you want to
leave — leaving loses your membership, your key and your history, and everyone
else can see you did it.

So hiding is deliberately scoped to **your own list only**: nobody else's view
changes, you stay in the channel, and — importantly — it still notifies you
exactly as before. Hiding is not muting; if you want a channel quiet, that is
what its notification rule (phase 50) is for. Conflating the two would make
"tidy my sidebar" silently swallow a mention.

Two modes, because the two reasons for hiding differ:

- **hide** — until you ask for it back.
- **till new** — until somebody posts in it again, at which point it returns on
  its own.

Safety valves: a "hidden" row with a count sits under the channel list so
nothing is lost behind an invisible state, and a dot on that row means something
unread is inside. The state syncs across devices and zuckermode's conversation
list honours it.

## What landed

- **78-1 … 78-3** — the hide/till-new state and its sync, the context-menu
  entries (right-click / long-press), the "hidden" row with count and unread
  dot, and zuckermode integration.

## Where it lives

`web/src/chat/channel-hide.ts` (and `channel-hide.test.ts`),
`web/src/components/Sidebar.tsx`, `web/src/components/ZuckerList.tsx`,
`web/src/components/App.tsx`, `web/src/state/types.ts`.

## Notes

Related but distinct: phase 54's channel **groups** organise the list;
78 removes things from it.
