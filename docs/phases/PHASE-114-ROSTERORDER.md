# Phase 114 — roster order: your channels, in your order

**Status:** *planned, not started* (designed 2026-09-07).
**Tags:** `#rosterorder` → `tools/where.sh -g rosterorder`

## The problem

The channel list has exactly one order and nobody chose it. Groups render
`General` first and the rest alphabetically (`groupRoster`, 54-3); channels
inside a group render newest-created first, because that is the order
`channels_loaded` stores in `state.channelOrder` and every step since
(`splitVoice`, `groupRoster`, the filter) is careful to leave the input order
"untouched". Creation date is a fact about the channel's birth, not about
whether you care about it today: the channel you live in sits under three you
joined last week and never opened, and the group you read every morning is
wherever the alphabet put it.

Two things are missing, and they are different things:

- **Attention.** A channel that just had a message should be findable without
  remembering when it was created. Zuckermode (62) already answers this on a
  phone with an activity-sorted list; the desktop roster has nothing.
- **Intent.** Some orders are not derivable from any signal — "these three
  groups on top because they are work, that one last because it is noise" —
  and only the reader can state them.

Both have to be *per user*: the server seeds a group name and nothing else
(54's "creator seeds, user owns"), and one member's tidy-up must never reshuffle
another's roster.

## The design

**One pure module decides the order; prefs hold what the reader said; the
sidebar renders whatever comes out.** Nothing goes over the wire, nothing is
added to the schema. The server already stores the roster prefs blob opaquely
and fans `prefs_changed` to the user's other connections, so the order follows
the account the way group overrides and hidden channels already do.

### Two axes, kept separate

**Channels within a group** have a *sort mode*:

| mode | order | source |
| --- | --- | --- |
| `created` | newest-created first | today's order, unchanged |
| `activity` | most recent message first | `state.activity[id].ts`, falling back to `createdAt` for a channel that has never had a message — the exact rule Zuckermode's `buildConversationList` uses, with the same id tie-break so same-millisecond sends do not jitter |
| `manual` | the reader's list | `prefs.roster.channelOrder[groupKey]` |

The mode has an account-wide default (`prefs.roster.channelSort`, **`created`**
— today's behaviour, so nobody's roster moves when this ships) and a per-group
override. Reordering a channel by hand switches that group to `manual`; picking
a mode from the group's menu switches it back and leaves the manual list in
place, so "sort by activity for a while, then back to my order" costs nothing.

**Groups** have only one question — *your order or the default one* — so they
get a single list, `prefs.roster.groupOrder: string[]` of group keys (the
lower-cased names collapse state is already keyed by, so `Dev` and `dev` stay
one group here too). Groups on the list render first, in list order; groups
off it follow in today's order, `General` first then alphabetical. An empty or
absent list is exactly today.

### Manual order survives the roster changing under it

A manual list is a *preference about* channels, not the set of channels, so it
has to tolerate every way the two can drift:

- **A channel not on the list** (new, moved into this group by a 54-4
  override, un-hidden) appends at the **bottom**, in the automatic order the
  group would otherwise have. Bottom, not top: a manual order is a statement
  about what matters most, and something that just appeared has not earned
  the top of it. The reader drags it up if it has.
- **An id on the list that is no longer in the group** (left, deleted, moved
  out, hidden) is skipped on read and **pruned on the next write**. The read
  side never rejects a stale list; the write side never lets one grow.
- **A group on `groupOrder` that no longer exists** is the same: skipped on
  read, pruned on write. A group that comes back later (someone recreates
  `dev`) lands where it was, which is a small kindness for free.
- **Renaming** is not a thing groups can do — a group *is* its name — so a
  rename is a delete plus a create, and the pruning above covers it.

Reads are pure and total: `orderChannels(channels, mode, manual, activity)`
and `orderGroups(groups, manual)` in `web/src/chat/roster-order.ts` take
whatever the prefs hold and always return a complete permutation of their
input. That is where the tests live.

### The 8 KiB you are spending

`prefs_set` caps the patch at 8 KiB after marshal (`prefsMaxBytes`,
`internal/server/ws.go`), and every roster write already sends the **whole
roster object** — `{ roster: { ...current, channelOrder: next } }` — because the
server's merge is shallow. Channel ids are 36-character UUIDs, so a manual
list costs ~40 bytes per channel, alongside `groupOverrides` (one id + a name
each) and `hidden` (one id + mode + seq each) that are already in there.

That is enough for any roster chalk actually has — a hundred manually ordered
channels is ~4 KiB — but it is not unbounded, and this phase is the first
thing to put *lists* rather than *exceptions* in the blob. So:

- a group holds a list **only while its mode is `manual`**; switching a group
  back to an automatic mode keeps the list (see above), but "reset order" from
  the group menu deletes it;
- writes go through one `pruneRosterOrder(prefs, liveChannels, liveGroups)`
  so stale ids never accumulate;
- the write path checks the marshalled size against the cap **before
  sending** and refuses with a visible hint rather than letting the server
  bounce it silently. If that hint is ever seen in practice, the follow-up is
  a per-key `prefs_set` merge on the server, not a shorter id.

### The gestures — the menu first, drag second

Every reorder is reachable from the context menus the roster already has,
before any dragging exists:

- **Channel menu** (`channel-menu`, the 50-5/54-4 menu) gains an *order* row:
  **to top · up · down · to bottom**. Using any of them puts the group into
  `manual` mode if it was not already. Keyboard-reachable, and it is also the
  touch path on the phone's classic drawer.
- **Group header menu** — new; the header has no menu today, only the
  collapse click. Right-click / long-press opens: **sort channels by**
  (`created` / `activity` / `manual`, with the account default marked), **move
  group up · down · to top · to bottom**, and **reset order** (drops this
  group's manual list, and its entry in `groupOrder`).
- **Settings → chat → channel list** gains *sort channels by* for the account
  default, beside the grouping and short-name switches, findable from the
  settings filter.

**Drag-and-drop is the last slice, desktop only.** Pointer events, hand-rolled
on the `SidebarResizer` precedent, mouse only (`pointerType === "mouse"`):
touch has the long-press menu and a drag would fight the drawer's swipe. A
channel row drags within its group, and across into another group — which is
a 54-4 move plus a placement, and the same `onSetChannelGroup` call. A group
header drags among groups. A 2px insertion line marks the drop, the list
auto-scrolls near its edges, Escape cancels. Nothing about the order depends
on this slice existing: it is a faster way to say what the menus already say.

### What "on desktop" means

The **order** is account state and renders everywhere the classic roster
renders — desktop column and the phone's drawer alike — because a roster that
is in one order on your laptop and another on your phone is a roster you
cannot learn. The **drag gesture** is desktop-only. Zuckermode is untouched:
it is already the activity-sorted view and has no groups.

### Activity sort and the moving target

An activity-sorted group reorders itself when a message lands, which can move
a row out from under the pointer. Zuckermode has lived with this since 62 and
nobody has asked for a fix; the roster gets the same behaviour, and the
`created` default means only readers who chose the sort see it. If it turns
out to matter, the follow-up is to defer re-sorting while the pointer is over
the list — a rendering rule, not a data one — and it belongs in a later slice,
not in the comparator.

## What was rejected

**A rank per channel** (`Record<channelID, number>`) instead of a list per
group. Sparse ranks make "insert between" cheap, but they store one number per
channel *forever*, ordered or not, which is exactly the growth the 8 KiB cap
punishes; and a list is what a drag produces and what a test reads.

**Pinning** (a few channels on top, the rest automatic) as a fourth mode. It is
what `manual` already degrades to: put the ones you care about in the list,
and everything else follows in the automatic order. A separate mode would be a
second way to say the same thing.

**Changing the default to `activity`.** The brief says the default stays as it
is, and the phase honours that literally: an account that never touches a
setting renders in exactly today's order. If that turns out to be the wrong
call — if `activity` is what most readers want and nobody finds the setting —
it is a one-line default flip in `selectRosterPrefs`, and the `created` mode
stays selectable for the readers who liked the old order.

**Drag-and-drop first.** It is the gesture people picture, and it is the most
code, the most browser-specific, and the only part that cannot be tested
without a running stack. Building the order model and the menus first means
the feature is complete and verifiable before the drag exists, and the drag
becomes a slice that can be cut or shipped independently.

**Sorting by unread instead of by activity.** Unread is a *state* (it clears
when you read), so a list sorted by it rearranges itself when you click a row
— the one moment you have just decided where things are. Activity is a
*timestamp*, monotonic per channel, and only moves things when something
happens.

**Server-side ordering.** The server has the activity index (62-1) and could
return channels pre-sorted, but it does not have the reader's manual order and
must not learn it (it is a preference, and the prefs blob is opaque on
purpose). One sort site, on the client, over data it already holds.

## The slices

- **114-1 — the order model.** `web/src/chat/roster-order.ts` (`orderChannels`,
  `orderGroups`, `moveInList`, `pruneRosterOrder`, `rosterOrderBytes`) with
  tests for every drift case above; `prefs.roster.channelSort`,
  `groupSort` (per-group mode overrides), `channelOrder` and `groupOrder` in
  `RosterPrefs` / `ResolvedRosterPrefs` with a resolver that tolerates any
  stored shape; `Sidebar` applies both orderings after `groupRoster` and before
  the row flatten. **No new UI**: with empty prefs this renders today's roster
  byte for byte, which is the slice's own check.
- **114-2 — activity sort and the account default.** The *sort channels by*
  setting under *channel list*, the settings-search keywords, and the
  `activity` comparator wired to `state.activity`. Zuckermode's comparator is
  extracted rather than copied so the two views can never disagree about what
  "most recent" means.
- **114-3 — the menus.** The channel menu's *order* row; the new group-header
  context menu (sort mode, move, reset); the pre-send size check with its
  hint. After this slice the phase is complete on every device.
- **114-4 — drag-and-drop on desktop.** Channel rows within and across groups,
  group headers among groups; insertion line, edge auto-scroll, Escape. Mouse
  only. Verified with a `run-chalk` probe, since none of it can be asserted
  without a browser.

## Left open

- **Whether `activity` should be the default after all.** See "What was
  rejected" — deliberately not, but cheap to flip.
- **Deferring re-sorts under the pointer** for activity-sorted groups, if the
  moving target turns out to bother anyone.
- **The friends list and the voice section** are out of scope. Friends are
  sorted by presence then name (64-1) and voice rooms are "rarely more than a
  handful" (100-1); neither has asked for an order, and neither has groups.
- **Cross-group drag on the phone.** Touch drags are excluded outright here;
  the drawer's long-press menu plus 54-4's *move to group* covers the same
  ground in two steps.
