# Phase 35 — message deletion, with rules

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.3.20 – v0.3.26.
**Tag:** `#deletion` → `tools/where.sh -g deletion`

## Why

Deleting someone else's words is a moderation act, and chalk already had an
opinion about moderation: per-channel governance (dictator vs democratic). So
deletion was built as a *policy* question routed through the existing governance
engine rather than as an owner override bolted onto the message store.

The resulting rule set:

- Your own message is always yours to delete, in any channel and in threads.
- Someone else's follows the channel's governance mode — the owner deletes
  unilaterally in dictator mode (double-confirmed, since it erases another
  member's words), and in democratic mode any member opens a `delete_message`
  proposal the channel votes on.
- Deletion leaves a **tombstone**, not a hole: history and thread fetches carry
  it, so a deleted message reads as deleted everywhere rather than silently
  vanishing on one device and persisting on another.

Editing deliberately got the opposite treatment (phase 37): no owner override
and no vote, because putting words in someone's mouth is not a thing a channel
should be able to vote for.

## What landed

- **35-1** — carry the delete tombstone on history and thread fetches.
- **35-3** — per-message delete policy (DM own-only, owner, propose).
- **35-4** — delete behind the row menu, double confirm, democratic vote path.
- **35-5** — authors delete their own messages; the same rules apply in threads.

## Where it lives

`web/src/chat/deletepolicy.ts`, `web/src/components/ThreadPanel.tsx`,
the governance engine in `internal/store/governance.go` and
`internal/server/governance_ws.go`.
