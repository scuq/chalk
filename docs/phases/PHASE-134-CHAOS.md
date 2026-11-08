# Phase 134 — chaos mode: one list, newest activity on top

**Status:** complete (shipped). 134-1 and 134-2 are built (2026-11-08).
**Tags:** `#roster` → `tools/where.sh -g roster`

## The problem

On desktop, the text channels show in groups with headers.
Inside a group, the order is the sort mode or the manual list of 114.
A reader who wants to see where the latest message landed must look through every group.

Chaos mode is one list of all text channels, newest activity on top.
It applies also when "group channels" is on.

## The design

The preference is `prefs.roster.chaos`, a sparse boolean.
An absent key, or any value but `false`, resolves to `true`.
All accounts, also existing ones, have chaos mode on until they turn it off.
No server change is necessary, because the roster preferences are one client-owned object.

On desktop, chaos mode replaces the grouped view and the single-group view with one flat list in activity order:

- The pointer hold from 114-6 still applies.
- The list has no group headers.
- Drag and the "up" and "down" menu items are not available, because no group order is in effect.
- "Move to group" stays.
- The saved manual order and the per-group sorts stay in the preferences. They apply again when chaos mode is off.
- The hidden shelf stays last.

The phone does not change.
`App.tsx` passes `chaos` to the sidebar only when the view is not mobile, and the settings checkbox shows on desktop only.

In settings, the "chaos mode" checkbox is above "group channels".
On desktop, while chaos mode is on, "group channels" and "sort channels by" are disabled.
Their description reads "used when chaos mode is off".

## What was rejected

A new sort mode in `CHANNEL_SORT_CHOICES`.
Chaos mode changes the shape of the list, not only the order.
Also, a new sort mode replaces the saved manual order, and chaos mode must keep it.

## The slices

- **134-1 — the preference, the flat activity list, the settings checkbox.**
  `chaos` joined `RosterPrefs` and `ResolvedRosterPrefs`.
  `Sidebar` takes a `chaos` prop.
  `ProfilePanel` has the checkbox and the disabled controls.
  `settings-nav.ts` has the keywords "chaos" and "chaos mode".
  `roster-order.test.ts` tests the resolver: empty roster, `true`, `false`, and a junk value.
- **134-2 — the group tag.**
  In chaos mode, each text channel row shows its group name as a small tag.
  The tag is at the right end of the row, after the expiry badge and the unread envelope.
  The name is the one that a group header shows.
  `groupTagNames` in `channel-groups.ts` maps each channel ID to it.
  The tag shows only if more than one group exists, the same rule that hides group headers.
  Voice rows and hidden-shelf rows get no tag.
  The tooltip of the tag is the full group name.
  The tag has a very large `flex-shrink`, an ellipsis, and a minimum width of about three letters.
  So the tag shortens first, and the channel name shortens only after that.
  In chaos rows the name rule grows into the free space, so the tag sits at the right edge.
  The tag reuses the `.chalk-sidebar-item-tag` style with a `--group` modifier.
  `theme-sidebar.test.ts` holds the declarations.

## Manual checklist

Open on the dev stack, with one account that has several groups and one long channel name.

- [ ] Desktop, chaos mode on, "group channels" on: the text channels show as one flat list, newest activity on top. No group headers.
- [ ] Settings: "group channels" and "sort channels by" are disabled and read "used when chaos mode is off".
- [ ] Chaos mode off: the grouped view and the manual order are back.
- [ ] A hidden channel still shows on the hidden shelf, last.
- [ ] Several groups, chaos mode on: each text channel row shows its group name as a tag at the right end. The full name shows on hover.
- [ ] One group only: no row shows a tag.
- [ ] Voice rows and hidden-shelf rows show no tag.
- [ ] A long channel name in a narrow sidebar: the tag shortens first, down to about three letters. Then the channel name shortens.
- [ ] Phone: the channel list does not change, and settings has no chaos mode checkbox. Rows show no group tag.
