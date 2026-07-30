# Phase 54 — roster filter + channel grouping

Two roster features: a filter for long lists, and per-user channel grouping
seeded by a creator suggestion. Decided 2026-07-30.

## Concept

- **Filter**: when the friends or channels list grows past a threshold, a
  text input appears above it. Case-insensitive substring match, client-side
  only. (The friends half already shipped in May; phase 54 extends it to
  channels.)
- **Grouping**: every non-DM channel carries a `group_name`, set once at
  creation by the creator (existing channels backfill to `General`). It is a
  *suggestion*: each user can override the group of any channel for
  themselves, and can turn grouping on or off entirely. When grouping is on,
  the channels section renders one collapsible tree layer of groups.

The split is deliberate: *creator seeds, user owns*. The group name is set
only at creation and never changes server-side, so nobody can reshuffle
another user's roster after the fact; all later movement is per-user
override. The server stores a hint, the client owns the view.

## Data model

- Server: `channels.group_name text NOT NULL DEFAULT 'General'` (migration),
  a `group_name` field on `create_channel`, and the field on the channel
  summary. Same privacy class as the channel name, which is already
  server-side plaintext — no E2E implications.
- Account prefs (synced via `prefs_get`/`prefs_set`, resolver-pattern like
  `selectChatPrefs`):
  - `prefs.roster.groupingEnabled: boolean` (default **on**)
  - `prefs.roster.groupOverrides: Record<channelID, string>`
- Per-machine (localStorage, like device prefs): which groups are collapsed.
  Collapse is ephemeral posture; syncing it across a desktop and a phone
  would feel wrong. The toggle and overrides sync, the collapse doesn't.

## Rules

- Effective group = override if present, else the channel's `group_name`.
- While a filter is active, collapse state is ignored and matches render
  flat — a filter that hides hits inside collapsed groups feels broken.
- A collapsed group shows a rolled-up unread dot (mention variant wins)
  aggregated from its children, respecting the voice-channel
  `countsAsUnread` rule — collapsing must not become an accidental mute.
- Anti-fragmentation: the create modal and the override UI offer a datalist
  of group names already visible in the user's roster; input is trimmed and
  matched case-insensitively against existing names before creating a new
  group. Otherwise "General"/"general"/"Genral" proliferate.
- Groups sort alphabetically, `General` first. DMs are untouched — grouping
  applies to the channels section only.

## Slices

- **54-1 — channels filter** (client only). Extend the friends-filter
  pattern to the channels list: shared threshold, same look, own input and
  empty state. Pure matching logic in `web/src/chat/roster-filter.ts` with
  tests; `Sidebar.tsx` uses it for both sections. *Done: input appears at ≥7
  channels, filters by name, "no matches" empty state, friends behaviour
  unchanged.*
- **54-2 — `group_name` server-side.** Migration + backfill `'General'`,
  `create_channel` accepts it (default `General`, trimmed, length-capped),
  channel summary carries it, create modal gets the field with the datalist.
  No rendering change yet.
- **54-3 — grouped rendering.** The channels section renders group headers
  (collapsible, localStorage-persisted) when `groupingEnabled`; rolled-up
  unread dots; filter flattens; settings toggle in the profile panel.
- **54-4 — per-user override.** "Move to group…" in the channel context
  menu (the 50-5 menu), writing `prefs.roster.groupOverrides`; datalist of
  known groups; "reset to suggested" clears the entry.

Each slice is independently verifiable; 54-1 ships value before any
grouping exists.
