# Phase 129 — seasonal: a figure for the season

**Status:** built, 129-1 – 129-3 (2026-10-31). 129-4 (Christmas) is planned, not started.
**Tags:** `#seasonal` → `tools/where.sh -g seasonal`

## The problem

chalk had nothing that marked a season. The brief: on special days a small
figure sits in the chat. Today that is Halloween. Christmas and other days
follow later. The figure appears and disappears on its own. It is on by
default. An administrator can turn it off for the whole server.

## The design

### The calendar decides which season it is

`web/src/season/seasons.ts` holds `SEASONS`, one window per season, as 1-based
month and day pairs. Halloween runs from 24 October to 1 November inclusive.
The extra day is for people who read the night's messages in the morning.

`seasonFor(now)` is a pure function. It takes the clock as a parameter and
reads the local calendar date of the reader. It ignores the year. If the end of
a window comes before its start, the window wraps the year boundary.

### The figure peeks, it is not furniture

`web/src/season/peek.ts` sets the schedule:

1. The figure starts hidden for a first pause of 4 s to 12 s.
2. It shows for 8 s to 15 s.
3. It hides for 25 s to 90 s.
4. The cycle repeats from step 2.

Each duration is random inside its bounds. The random source is a parameter,
so a test can pin it. The component owns one `setTimeout` per step and clears
it on unmount.

### The component

`web/src/components/SeasonFigure.tsx` draws an inline SVG ghost on
`currentColor`. The eyes and the mouth are cut out in the page color. The SVG
has `role="img"` and an aria-label. It has `aria-hidden` while it is hidden.
One component serves every season, and a `switch` on the season id picks the
glyph.

### The mount

`App.tsx` mounts `SeasonFigure` inside `<footer class="chalk-footer">`, before
the `ComposerResizer`. It mounts only when a text channel is active. It does
not mount for a parked channel, a voice channel, or the phone's zucker list
screen.

The anchor is not sticky and it is not inside the scroller. It is a zero-size
element with `position: absolute`, pinned to the top-right corner of the footer
with `bottom: 100%`. The footer is `position: relative` since 91-1. The anchor
has `pointer-events: none`. The glyph floats over the bottom-right corner of the
feed, whatever the length of the feed or its scroll position. It takes no room
from the feed and no clicks.

`App.tsx` reads the date again once an hour with `setInterval`. A tab that
stays open over midnight crosses the edge of a window without a reload.

### The motion is CSS only

The section "Phase 129: seasonal" in `web/src/theme.css` has a 900 ms fade on
opacity and transform, and a 3.2 s bob (`@keyframes chalk-season-bob`). Under
`prefers-reduced-motion: reduce` the transition and the animation are off. The
figure still comes and goes, but it jumps and does not fade.

The section sits above the "Phase 115: flair" section on purpose.
`theme-flair.test.ts` takes the last reduced-motion block of the sheet as the
block of flair. `web/src/theme-season.test.ts` holds every moving selector of
this phase to its own reduced-motion block. It also holds the section above
flair.

### Three gates

The figure shows only if all three hold:

- The calendar says it is a season (`seasonFor`).
- The device switch is on.
- The server switch is on.

### The device switch

`seasonal: boolean` in `web/src/display-prefs.ts` has the default true. An
absent value means true, so an upgrade turns it on. Phase 111-4 did the same
for `showChannelBanner`. Like every pref in that file, it is in localStorage.

The settings section `seasonal` is on the appearance tab in `settings-nav.ts`.
Its keywords are seasonal, season, halloween, christmas, ghost, pumpkin,
holiday, holidays, decoration, decorations, and spooky. `ProfilePanel.tsx` has
a check box row for it after the flair section.

The switch is not a flair sub-switch. Flair is off by default and this switch
is on by default. A reader who has flair off still gets the ghost.

### The server switch (129-2)

Migration `migrations/0062_instance_settings.sql` creates
`instance_settings(key text primary key, value jsonb not null, updated_at
timestamptz)`. The table is generic. The next administrator switch needs a
handler and no schema change.

The migration seeds no row. An absent key means the default, and the handler
owns the default. The key is `seasonal_decorations`. The value is a JSON
boolean with the default true. The value is plaintext by design, like the
avatar frame (0061): it is presentation of the instance, not content.

`internal/store/instance_settings.go` has `GetInstanceSetting` and
`SetInstanceSetting`. The second one is a single-row upsert.

`internal/auth/admin_settings_http.go` has two routes behind `RequireAdmin`:

- `GET /api/admin/settings`
- `PUT /api/admin/settings`

The PUT body is partial (the fields are pointers). The handler refuses unknown
keys with 400. The response is the full settings.

`GET /api/auth/config` is public and answers before sign-in. It now carries
`seasonal_decorations`, read from the database on each call. If the database
returns an error, the handler logs it and answers the default.

The client hides the figure until the config has loaded. An instance with the
switch off never shows the figure for a moment.

### The admin tab (129-3)

`AdminPanel.tsx` has a third tab, settings. The tab component is
`AdminSettingsTab.tsx`, with one switch row in the phase 124 row markup. The
API functions `getSettings` and `putSettings` are in `web/src/auth/admin.ts`.

The reducer state is `adminPanel.settings`, with load and save actions in
`web/src/state/types.ts` and `reducer.ts`. `reducer-admin-settings.test.ts`
covers them. The tab reads the switches again each time it opens.

After a successful save, the client of the administrator folds the value into
its loaded config (`auth_config_loaded`). The figure on the screen of the
administrator follows at once.

`web/src/whats-new.ts` has an entry for phase 129.

## What was rejected

A `CHALK_*` environment variable for the administrator switch. It needs a
chalkd restart and the whole chalkctl chain: generate, preserve on `--force`,
and backfill on `update`.

A flair sub-switch. The default is wrong: flair is off and this is on.

The channel header as the place for the figure. The header is tight on a
phone.

An `html` data attribute for the device switch. It is not necessary: when the
switch is off, the component does not mount.

## The slices

- **129-1 — the figure on the client.** `season/seasons.ts`, `season/peek.ts`,
  `SeasonFigure.tsx`, the mount and the hourly date check in `App.tsx`, the
  CSS section, the device switch in `display-prefs.ts`, `settings-nav.ts`, and
  `ProfilePanel.tsx`, and `theme-season.test.ts`.
- **129-2 — the server switch.** Migration 0062, `instance_settings.go`,
  `admin_settings_http.go`, and `seasonal_decorations` on
  `GET /api/auth/config`. Tests in `admin_settings_http_test.go`:
  `TestAdminSettingsRoundTrip` needs a database and skips without
  `CHALK_TEST_DATABASE_URL`. `TestConfigSeasonalDefaultsOnWithoutStore` does
  not need one.
- **129-3 — the admin tab.** `AdminSettingsTab.tsx`, the third tab in
  `AdminPanel.tsx`, `getSettings` and `putSettings`, and the reducer state.
- **129-4 — Christmas.** Planned, not started. See "How to add a season".

## Trade-offs

1. A change by an administrator reaches other clients on their next page load.
   `GET /api/auth/config` is cached with `max-age=60`, so the delay is one
   minute at most. A `welcome` payload field or a WebSocket broadcast is a
   later slice if it is wanted.
2. Only Halloween ships. Christmas is 129-4.
3. The date check runs once an hour. A tab can show the figure up to one hour
   into 2 November.

## Verification

Done on 2026-10-31: `go build`, `go vet`, `gofmt -l` (empty), and
`go test ./...` pass. `npx tsc --noEmit` is clean. `node test.mjs` passes
1656 tests. `node build.mjs` succeeds. The database-backed tests pass against
the dev Postgres.

A Playwright probe drives the real UI. It lives in the scratch slot
`.claude/skills/run-chalk/probes/ui.mjs` and is not committed. The probe ran
against the dev stack on 2026-10-31 and its 32 checks passed:

- Desktop corner geometry with a short feed
- A long feed, at the bottom and scrolled to the top
- Reduced motion
- The device switch
- The phone layout, with no sideways overflow
- No page errors
- The what's-new note that names the ghost
- The admin tab, which reads the stored value again
- The admin switch end to end: config false, row stored, own figure gone at once, peer sees none after a cache-cleared reload, back on

### Manual checklist for the live stack

Use two users, Alice and Bob, and a date inside the window.

1. Check that the ghost is absent for the first 4 s after a text channel
   opens, and that it shows at some point in the next 12 s.
2. Check that the ghost sits in the bottom-right corner of the feed, and that
   a click on its position reaches the message under it.
3. Check that the ghost is not present in a voice channel or in a parked
   channel.
4. Emulate reduced motion. Check that the ghost comes and goes without a fade
   and without a bob.
5. Clear the check box under settings, appearance, seasonal. Check that the
   ghost does not mount on this device. Check that it stays off after a
   reload.
6. Check that a device with flair off still shows the ghost.
7. Check the phone layout (400 px wide). Check that the ghost does not cover
   the composer and does not cause sideways overflow.
8. As an administrator, open the settings tab in the admin panel and turn the
   switch off. Check that the ghost on the screen of the administrator goes
   away at once.
9. Check that Bob loses the ghost on his next page load, one minute at most
   after the save.
10. Check that a signed-out client of an instance with the switch off never
    shows the ghost.
11. Close and open the settings tab. Check that it shows the saved value.
12. Set the system date outside the window. Check that no ghost shows.

## How to add a season

1. Add an entry to `SEASONS` in `web/src/season/seasons.ts`. For example:
   `{ id: "christmas", from: [12, 1], to: [12, 26] }`.
2. Add a case for the new id to the `switch` in `SeasonFigure.tsx` with the
   glyph.
3. Add the new id to a test of `seasonFor` in the season tests.
4. Add the keywords of the season to the `seasonal` section in
   `settings-nav.ts` if they are not there.

The device switch, the server switch, the schedule, and the CSS need no change.
