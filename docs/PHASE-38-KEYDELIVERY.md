# Phase 38 — being added to a channel works without a reload

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.3.28.
**Tag:** `#spacekeys` → `tools/where.sh -g spacekeys`

## Why

Two bugs made "you were added to a channel" a broken experience until the next
reconnect:

1. **Members showed as UUID fragments.** The `channel_event` summary carried
   member IDs without handles, so sender names, the roster and mention
   highlighting all showed raw UUIDs until a reconnect refreshed the channel
   list.
2. **A channel could sit on "waiting for key" forever.** There is a race between
   the joiner asking for their space-key wrap and the inviter depositing it: ask
   a moment too early and nothing ever retried.

The fix for (2) is a server push rather than client polling — the server already
knows when a wrap lands, so it tells the waiting device instead of having every
client re-ask on a timer.

## What landed

- **38-1** — fill member handles into `channel_event` summaries.
- **38-2** — read channels through the ref in the `channel_event` handler, so
  the client updates the channel it actually holds instead of a stale copy.
- **38-3** — `key_available` push re-runs the channel key ensure on the
  receiving client.

## Where it lives

`internal/server/ws.go` (`channel_event`, `key_available`),
`web/src/components/App.tsx` (the key-ensure path).

## Notes

Key *provenance* — who signed the wrap you were handed — is not this phase. That
is phase 82; see [PHASE-82-SIGNEDWRAP.md](PHASE-82-SIGNEDWRAP.md).
