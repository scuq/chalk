# Phase 106 — channel names: distinct groups, rename, short names

**Status:** shipped, v0.8.6 (2026-08-25). The live-stack checklist under
[Left open](#left-open) was run in part the same evening against the dev
stack (a seeded roster of three users and eleven channels, checked in the
browser and the Electron shell); the unticked items are still open.

**Tag:** `#channelnames` → `tools/where.sh -g channelnames` (106-1 is roster
work and is also listed under `#roster`).

## The problem

Three things scuq brought from the live roster on 2026-08-25:

1. **A group header is indistinguishable from a channel row.** Since 54-3 the
   channels section renders `▾ General (3)` above its channels, but the header
   is the same height, the same indent and nearly the same weight as the rows
   under it. With four groups on screen the list reads as one column of
   twelve items, not four short lists.
2. **A channel cannot be renamed.** `channels.name` is set once by
   `create_channel` and never written again. A typo, a game that got a
   sequel, a `[CORE]` prefix adopted after the fact — all of them meant a
   new channel and a stranded history.
3. **Long names do not fit a narrow sidebar.** `Star Trek – Outposts Un…` is
   what the roster shows for a channel everyone calls "outposts". A channel
   needs a second, deliberately short name, and the *reader* — not the
   creator — decides which one their roster shows.

## Design

### 106-1 — groups that read as headings

CSS only, in `theme.css`. Three cues, none of them colour, so the channel
names stay the loudest text in the column:

- air above each group (`.chalk-sidebar-group { margin-top }`, suppressed on
  the first group, which sits directly under the filter);
- a hairline across the column above every header but the first;
- the section titles' letter-spacing on the header text.

Rows under a header carry `chalk-sidebar-item--grouped` and indent by the
width of the fold arrow plus its gap, so they hang beneath the group name
instead of lining up with it. The flat (ungrouped, or filtered) list keeps
the pre-106 alignment. The hidden shelf (78-2) shares the header class and
therefore the treatment — it is a heading too.

*Rejected:* uppercase headers (chalk's chrome is lowercase throughout);
a brighter header colour (the header must stay quieter than its rows);
a background band (fights the active-row highlight).

### 106-2 — rename

One new frame, `update_channel` `{channel_id, name?, short_name?}`, acked
with the channel summary as it now reads, and pushed to **every member's
every device** as `channel_event{kind:"updated"}` with the same summary.
The requesting tab folds ack and push idempotently (same names → same state
object). Nothing is applied optimistically: a refused rename leaves the row
untouched, which is what a permission error should look like.

**Who may rename:** the channel **owner** (`role='owner'`), on a **non-DM**
channel, in **dictator** mode. This is deliberately the narrowest of the
membership handlers. `add_member` lets any member invite because an invite
only widens the room; a rename rewrites what every member's roster says, so
it stays with the person who named the channel. DMs are refused outright —
their name renders from the other member and is never shown. Democratic
channels answer `unilateral_forbidden`, the same fence `add_member` uses: a
`rename` proposal type is **not built** (see Left open).

**Crypto:** nothing. Envelopes (83) sign bodies and channel IDs, never the
row's metadata; the channel key does not depend on the name. A rename has
no rotation, re-wrap or re-sign consequence, and the phase doc says so
because the question will come up.

The client surface is two rows in the channel context menu (the 50-5
right-click / long-press menu), **name** and **short**, visible only when
the viewer is the owner of a non-DM dictator-mode channel — the server
enforces the same rule; hiding the rows just keeps the menu honest. Both
commit on Enter or blur, and only when the draft differs from what the
channel already has; a blanked name snaps back rather than sending.

### 106-3 — short names, and who sees them

- **Schema** (migration 0054): `channels.short_name text NOT NULL DEFAULT ''`
  with `CHECK (char_length(short_name) <= 10)`. Characters, not bytes — a
  ten-emoji short name is ten. Empty means none; NULL would only be a third
  spelling of the same fact. `store.NormalizeShortName` is the one rule the
  create path, the update path and the handler share.
- **Wire:** `short_name` on `create_channel`, on `update_channel`, and on
  every channel summary (omitempty, so pre-106 servers and clients are
  byte-compatible).
- **Who sees which:** `prefs.roster.nameStyle: "full" | "short"`, an account
  pref on the roster object (resolver-defaulted to `full`, like 54-3's
  `groupingEnabled`), picked in settings → chat → channel list. It governs
  the **sidebar rows and the Zuckermode conversation list**. The **channel
  header always shows the full name**, so the abbreviation is never the
  only place a name is legible; a row showing the short name carries the
  full one as its tooltip. `short` on a channel without a short name falls
  back to the full name — the pref never blanks a row. The roster filter
  matches either name.
- **Where it is set:** the create modal (an optional field under the name,
  with a live `n/10` count) and the context menu's **short** row (106-2's
  path, owner only). The count and the cap are code points, applied in
  `onInput`, because `maxLength` counts UTF-16 units and would let five
  emoji through for the server to refuse.

*Rejected:* a per-device (localStorage) pref like the font size. The
argument for it — the phone wants short names, the desktop does not — is
real, but the roster's other presentation prefs (grouping, Zuckermode) are
account-synced and consumed per-device; a second storage model for one
toggle is not worth the split. If it turns out to be wanted per device, the
`chat.sidebarWidth` precedent (synced, desktop-only) is the shape.

## Slices

- **106-1 — distinct group headers.** `theme.css` (`.chalk-sidebar-group`,
  `.chalk-sidebar-item--grouped`), `Sidebar.tsx` (the `grouped` row flag).
  Client only, no pref.
- **106-2 — rename.** `proto` (`update_channel`, `update_channel_ack`,
  the `updated` event kind), `store.UpdateChannelNames`,
  `server/channel_names_ws.go`, the dispatch case; client `proto.ts`,
  `channel_updated` action + reducer case (`reducer-names.test.ts`), the
  `update_channel_ack` and `channel_event{updated}` handlers in `App.tsx`,
  the menu rows in `Sidebar.tsx`.
- **106-3 — short names.** Migration 0054, `store.NormalizeShortName`
  (`channel_names_test.go`), the column through every channel read
  (`CreateChannel` RETURNING, `GetChannel`, `ListChannelsForUser`, the guest
  summary), `short_name` on the summary and both request frames;
  `chat/channel-names.ts` (`rosterLabel`, `filterText`, the code-point
  length; `channel-names.test.ts`), `prefs.roster.nameStyle`, the settings
  select, the create-modal field, the sidebar and Zuckermode label.

## Left open

- **Rename in democratic mode.** No `rename` proposal type exists, so a
  democratic channel cannot be renamed at all (the owner gets
  `unilateral_forbidden`). Building it means a proposal type, its payload
  and execution in `store/governance.go`, and the proposal row in
  `GovernancePanel.tsx` — its own slice when a democratic channel actually
  needs it.
- **Live-stack checklist** (the store's update path has no DB-backed test;
  `TestNormalizeShortName` covers the rule, not the row):
  - [x] migration 0054 applies on the dev database; existing channels read
        with `short_name = ''` (2026-08-25, `tools/dev.sh` migrate)
  - [ ] owner renames from the context menu; every member's roster and the
        channel header follow without a reload; a second tab of the owner
        follows too
  - [ ] a non-owner does not see the rows; the frame sent by hand answers
        `not_channel_creator`
  - [ ] a democratic channel answers `unilateral_forbidden`; a DM answers
        `invalid_channel`
  - [x] short name set at creation (eleven channels through the real modal,
        one deliberately without); from the menu, and the eleventh
        character, still to check
  - [x] settings → channel list → *short name*: the sidebar switches, and
        the pref reached a second device (the Electron shell) as short
        names; rows without a short name unchanged. Header, phone list and
        tooltip still to eyeball
  - [ ] the filter finds a channel by its short name
  - [x] groups: the first group has no rule, the others do; rows indent
        under their header (browser and Electron screenshots). Flat
        filtered list still to check
