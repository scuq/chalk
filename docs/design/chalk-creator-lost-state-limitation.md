# Known limitation: channel creator cannot recover from lost local MLS state

**Status:** documented limitation, not fixed. Surfaced during phase 11c-6
standalone behavioral validation. The proper fix (MLS external-commit
join) is a future feature; this note captures the gap and why the
obvious workarounds are unsafe.

## Summary

A channel **creator** who loses their local CoreCrypto group state
(browser data cleared, device reset, IndexedDB `chalk-mls-<userID>`
deleted) while remaining a server-side member of the channel has **no
in-app recovery path** and is effectively locked out of their own
encrypted channel.

Regular (non-creator) members in the same situation recover fine: the
creator removes and re-adds them, which sends a fresh Welcome rebuilding
their state at the current epoch. The gap is specific to the creator.

## How the dead-end arises

The 11c-6 split-brain guard (`ensureGroupForChannel` →
`channelHasServerCommits`) correctly refuses to let a client with no
local group bootstrap a divergent group when the channel already has a
commit lineage on the server. It throws `MlsLocalStateLostError` and the
UI tells the user to "ask a member to remove and re-add you."

That recovery instruction works for a normal member but is impossible
for the creator, because of two interacting constraints:

1. **The creator cannot be removed by others.** `handleRemoveFromChannel`
   permits removing a member *other than yourself* only if the caller is
   the channel creator (`ch.CreatedBy == callerID`). No other member can
   remove the creator. So "ask a member to remove and re-add you" has no
   one who can perform the removal.

2. **The creator cannot self-remove either.** Self-removal
   (`targetID == callerID`) *is* permitted by the authorization check,
   but producing the Remove commit requires the caller's **local MLS
   group** (`removeMemberFromGroup` calls `listClientIdsForUser` /
   `removeClientsFromConversation` on the local conversation). The
   creator lost exactly that state, so they can't generate the
   self-remove commit.

Net: 11c-6 prevents the corruption (good — no divergent group is
created, the other members are undisturbed), but for a creator who lost
local state there is no path back into the channel.

## Severity

Low probability, creator-specific, recoverable-adjacent:

- Requires the **creator specifically** to lose local CoreCrypto state
  while staying a server-side member. Non-creators are fully recoverable.
- No data loss or corruption: the channel and its other members continue
  working normally. The creator's readable scrollback (phase 11c-4
  plaintext cache, keyed by ciphertext hash) also survives. Only the
  creator's ability to send/decrypt *new* messages in that channel is
  lost.
- The blunt operational escape hatch exists: recreate the channel (a new
  channel id bootstraps a fresh group cleanly), or a manual DB
  intervention by an operator. Neither is in-app self-service.

## Why the obvious quick fixes are unsafe (rejected)

- **Server-side DB-only removal (no MLS commit).** Deleting the creator
  from `channel_members` without an MLS Remove commit would leave the
  *remaining* members' groups still believing the creator is a member —
  reintroducing exactly the membership/MLS divergence 11c-6 exists to
  prevent.
- **Relax creator-protection so any member can remove the creator.**
  Weakens the authorization model and is exploitable: a malicious member
  could claim the creator "lost state" to evict them. "Lost local state"
  is not server-verifiable.
- Both risk re-opening the split-brain class of bug for a narrow,
  low-probability recovery case. Not worth it.

## Proper fix (future feature): MLS external-commit join

MLS defines an **external commit** precisely for this case: a client
that has the group's public information (which the server holds in
`mls_commits`) but no Welcome can join the existing group by producing
an external commit, without needing another member to add them. The
`MlsErrorOrphanWelcome` text even hints at it ("Join this group with an
external commit").

This is the protocol-correct recovery: the creator (or any member who
lost state) re-joins the *existing* group at the current epoch via an
external commit, rather than bootstrapping a divergent group or needing
to be re-added. It requires:

- Client: a `joinByExternalCommit`-style path in `groups.ts`, fed by the
  channel's current group info from the server.
- Server: expose the group's public state / latest epoch sufficient for
  an external-commit join (likely an extension of the existing
  `fetch_mls_commits` surface), and accept the resulting external-commit
  bundle.
- Wiring: when `ensureGroupForChannel` hits the lost-state condition,
  attempt an external-commit join instead of throwing — falling back to
  the current refuse-and-instruct behavior only if that fails.

Until then, 11c-6 remains the correct conservative behavior: prevent the
corruption, and for the non-creator case the remove/re-add recovery
works.

## Interim UX note (optional, not done)

The 11c-6 error message ("ask a member to remove and re-add you") is
misleading for the creator, since no one can remove them. A small, safe
improvement would be to detect the creator case and show a truthful
message instead (e.g. "encryption state for this channel can't be
recovered on this device; the channel may need to be recreated"). This
is a pure messaging change with no protocol/divergence risk, deferred
here only because Option D was to document rather than touch code.
