# Phase 59 — the server user directory and one-click add

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.4.9.
**Tag:** `#friends` → `tools/where.sh -g friends`

## Why

Adding a friend required typing someone's exact username. On a self-hosted
server with a handful of accounts that is absurd — everyone on the server is,
by construction, someone the admin let in.

So chalk exposes a **server-scoped user directory**: the whole member list of
*this* server, with people you have already friended or have a pending request
with marked as such, and an add button on everyone else. It is not a global
lookup and there is nothing to search across instances; the trust boundary is
the server itself.

## What landed

- **59-1** — the friends "+" button beside the friends header, opening the
  friends panel's add tab; the server user-directory endpoint behind it;
  one-click add with pending/friended state reflected per row.

## Where it lives

`internal/friends/`, `web/src/components/FriendsPanel.tsx`,
`web/src/components/Sidebar.tsx`, `web/src/components/App.tsx`.

## Notes

The channels "+" already worked this way; 59 is the same affordance for people.
