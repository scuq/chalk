# Phase 89 — the friend-request hint

## The problem

A user on Safari reported a tab title stuck at `(2) chalk`. It survived a full
logout and login, and a reinstall of the PWA. Nothing in the app showed a `2`.

The badge is not the bug. `badgeCount` (`web/src/notify/badge.ts`) sums four
things, and the fourth is open incoming friend requests:

```
+ each DM channel with unread
+ each non-DM channel where you were mentioned
+ threadInboxUnreadTotal
+ pendingIncoming.length
```

All four are server state, which is why re-login and reinstall changed nothing.
The first three all draw something in the sidebar — a DM row dot, a channel row
dot, the threads dot. The fourth drew nothing anywhere. `pendingIncoming`
reached the screen only inside the friends panel, on its "pending" tab, behind
the "you" menu: three clicks, none of them suggested by anything visible.

So the badge was arithmetically right and completely unexplainable. Two friend
requests the user had never looked at pinned a permanent `(2)` to the tab, and
the only way to find them was to already know where they were.

## The design

Put the same number on the path the user would actually walk.

- A count on the `you (name) ▾` trigger in the status bar, which is the one
  always-visible element that owns everything account-shaped.
- The same count on the `friends` item inside that menu.
- Opening friends with requests waiting lands on the **pending** tab rather
  than **add**, so the last click does not need to be guessed either.

**A count, not a dot.** Every other unread marker in chalk is a dot, on the
argument that "something new there" is the whole message (`UnreadDot.tsx`). That
argument does not hold here: this marker exists specifically to explain a
number, and a dot cannot say which part of `(2)` it accounts for. Seeing `2` on
the trigger, `2` on the friends item and 2 rows in the panel is what makes the
tab title legible.

**Gated on `menuEnabled`.** No hint while disconnected or session-less — the
menu will not open, and a marker you cannot click through is a nag.

### Rejected

- **A dot, for consistency with the sidebar.** Consistent and useless: it would
  have told this user that something was somewhere, which they already knew.
- **A banner or toast on arrival.** Requests can arrive while the tab is
  closed; anything transient loses exactly the case that caused the report.
- **Dropping friend requests from `badgeCount`.** They belong in it. An unmet
  request is a thing waiting on you, which is the whole definition the badge
  is built on. The gap was in the UI, not in the count.
- **A sidebar row for pending requests.** The sidebar is the roster — people
  and channels you can open. A request is not either yet, and the "you" menu
  already owns friends.

## Slices

- **89-1** — the count on the "you" trigger and the friends item, and the jump
  to the pending tab on open. `StatusBar.tsx`, `App.tsx`, `theme.css`.

## Not covered by this phase

The same audit turned up a second way the badge can point at nothing, still
open:

- The sidebar builds DM rows by iterating **friends** and resolving each to a
  channel (`findDMWithFriend`, `Sidebar.tsx`), and the channel list drops DMs
  outright. `badgeCount` instead iterates every channel with `isDM`. The two
  sets diverge for a DM whose partner is no longer a friend — `friends.Remove`
  clears the friendship and leaves the channel and its membership — and for any
  DM whose `memberIDs.length !== 2`. Such a DM counts toward the badge, has no
  row to click, and so can never have its read cursor advanced. Not observed in
  this report; the fix is to make the two agree on what a DM is.
