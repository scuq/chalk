# Phase 68 — settings tabs and the cross-tab filter

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.5.5. Extended by 70-1/70-2 (steady frame, version
footer) and 76-1 (shortcuts move in).
**Tag:** `#settings` → `tools/where.sh -g settings`

## Why

The profile panel had become one long scroll holding account, appearance, chat,
notification and media settings. Finding anything meant knowing roughly how far
down it lived, which is exactly the knowledge a new user does not have.

Tabs alone would make it worse for the *other* failure mode — knowing what you
want ("volume", "passkey") but not which tab owns it. So the panel gets both: a
five-tab split **and** a filter box that searches across all tabs at once and
shows only matching settings, tabs hidden while a query is active. Clearing the
box (or tapping a tab) brings the tabs back.

That requires settings to be enumerable rather than hand-laid-out per tab, which
is what `settings-nav.ts` exists for — it is the registry the filter searches.

## What landed

- **68-1 … 68-3** — five tabs (account, appearance, chat, notifications, media),
  the cross-tab filter box, and the navigation registry behind both. Landed in
  the same change set as 67-1's link shortening.

## Where it lives

`web/src/settings-nav.ts` (and `settings-nav.test.ts`),
`web/src/components/ProfilePanel.tsx`.
