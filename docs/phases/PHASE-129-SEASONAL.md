# Phase 129 — seasonal: a figure for the season

**Status:** built, 129-1 – 129-6 (2026-10-31). 129-1 – 129-3 shipped in v0.8.27.
**Tags:** `#seasonal` → `tools/where.sh -g seasonal`

## The problem

chalk had nothing that marked a season. The brief: on special days a small
figure sits in the chat. The seasons are Halloween and winter. Other seasons
can follow. The figure appears and disappears on its own. It is on by
default. An administrator can turn it off for the whole server.

## The design

### The calendar decides which season it is

`web/src/season/seasons.ts` holds `SEASONS`, one window per season, as 1-based
month and day pairs. Halloween runs from 24 October to 1 November inclusive.
The extra day is for people who read the night's messages in the morning.

Winter runs from 1 December to 6 January.
Its end comes before its start, so the window wraps the year boundary.
`inWindow(now, window)` is the shared window test.
`seasonFor` and `auraFor` both use it.

A season can carry an `aura` window.
It sets the days on which the window-edge glow runs, and the figures still visit all season.
The winter aura window is 23 to 25 December, the three days of Christmas.
Halloween has no aura window, so its glow runs the whole season.
`auraFor(season, now)` is the check.
`App.tsx` passes `aura` to the component from the same clock that picks the season.

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

### The figure set and the random pick

Each season in `SEASONS` lists ten figures by file name.
Each visit draws one of them at random.
`pickFigure(season, rnd, avoid)` in `seasons.ts` does the draw.
It never returns the figure of the previous visit.
The random source is a parameter, so a test can pin it.

129-1 drew a single inline SVG ghost.
129-5 replaced it with PNG cut-outs under `web/assets/season/<season>/<figure>.png`.
`web/src/season/figures.ts` imports each file.
It exports `FIGURES`, keyed `<season>/<figure>`.
Each entry has the hashed `src` URL and an accessible `label`, for example "a pumpkin".
`web/src/assets.d.ts` declares `*.png`.
`web/test.mjs` has a `.png` file loader, so the tests see a URL for each figure.

`web/src/components/SeasonFigure.tsx` renders `<img class="chalk-season-art">` at 56 px with a drop shadow.
It sets `data-figure` to the figure name.
The component picks the next figure as the figure comes in, never as it goes out.
The fade-out always shows the figure that visited.
The wrapper has `role="img"` and an aria-label.
It has `aria-hidden` while it is hidden.
One component serves every season.

The Halloween figures are pumpkin, ghost, witch-hat, cauldron, black-cat, skull-candle, bat, spider-web, scarecrow, and haunted-lantern.
The winter figures are snowflake, snowman, pine-tree, ice-crystal, arctic-fox, winter-lantern, signpost, icicles, scarf, and mittens.

`web/src/season/figures.test.ts` checks that every registry figure has a file, a URL, and a label.
It also checks that `FIGURES` lists no figure that the registry does not use.

### The cut-out tool

`tools/cut-season-sheet.py` made the PNG files.
It needs Python 3, Pillow, and numpy.
The sheet is an icon sheet that the user supplied.
The sheet is not in the repository.

    python3 -I tools/cut-season-sheet.py SHEET.png web/assets/season

The tool keys the flat dark background of the sheet to alpha.
It splits each row band at the empty columns between the icons.
It trims each piece and writes it on a square canvas.
Three refinements matter:

- The tool closes the outline of a figure across small gaps.
  A region that the outline encloses counts as the figure, unless it is plain background.
  So the body of a black cat stays black, and the open cells of a spider web stay open.
- A pixel brighter than the sheet counts as glow.
  A glow fades out over a longer distance than the figure edge.
  The tool unblends its colour from the sheet.
  So the halo of a pumpkin is a translucent light on a light page and not a dark fog.
- The `ROWS` table sets each row band and its figure ids.
  A new sheet needs its own rows.

### The mount

`App.tsx` mounts `SeasonFigure` in the header, inside `<div class="chalk-brand">`,
after the `VersionLink`. The only gate is the season: the figure is there
whenever the season is on. It does not depend on the active channel, on a
parked channel, or on the phone's zucker list screen.

The anchor `.chalk-season` is an `inline-flex` box in the flow of the brand.
It is 1.9em wide and 1.15em high, the height of the logo. It has
`pointer-events: none` and no `position`. The art `.chalk-season-art` is 1.9em
square and overflows the box above and below on purpose.

Three reasons set this design:

- The user asked for the figure beside the wordmark.
- The box has a fixed size, so the header has the same height with and
  without the figure and does not reflow when the figure comes and goes.
- The sizes are in em, so the figure scales with the title on a phone.

`App.tsx` reads the date again once a minute with `setInterval`. A tab that
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

### The aura

While the figure is visible, a second element shows beside it. It mounts only on the days that `auraFor` allows.
`SeasonFigure.tsx` renders it with the class `chalk-season-aura`,
`data-testid="season-aura"`, and `data-season` set to the season id.
It is a fixed sheet over the whole viewport, at z-index 1000, and it takes no clicks.
It paints only an inset box-shadow: a 1 px inner line and a 90 px glow.
It has no background, so the middle of the window is not changed.

Each season sets the colour in `--chalk-season-aura` and `--chalk-season-aura-line`.
Halloween uses a pale ghost green.
Winter uses an ice blue: `rgba(150, 210, 255, 0.42)` for the glow with a paler line on dark themes.
On the five light themes winter uses `rgba(28, 96, 170, 0.38)` for the glow and `rgba(28, 96, 170, 0.55)` for the line.
On a light theme a pale glow is invisible, so a second rule for each season gives the aura a darker, denser colour.
For Halloween it sets `rgba(18, 122, 66, 0.4)` for the glow and `rgba(18, 122, 66, 0.55)` for the line.
The rules list the five themes that declare `color-scheme: light`: `light`, `snazzy-light`, `warmwhite`, `vscode-light`, and `catppuccin-latte`.
The opacity fades over 1200 ms with the visibility of the figure.
The reduced-motion block of the same section sets `transition: none` on the aura.
`web/src/theme-season.test.ts` holds the sheet fixed, with `inset: 0`, click-through, inset-shadow only, and no fill.
It also loops over the registry and requires that every season sets its aura colour.
A second test reads every `[data-theme]` block and collects the themes that declare a light scheme.
For each season in the registry, it requires that the light rule lists exactly those themes.
So a new light theme cannot ship without an aura colour.

### The night frame on video tiles

129-6 adds a green frame on the playback of video tiles on Halloween night.
The night runs from 18:00 on 31 October until 03:00 on 1 November, by the clock of each viewer.

`seasons.ts` has a `HourWindow` type.
Its `from` and `to` are `[month, day, hour]` triples.
The `from` hour is inside the window and the `to` hour is outside it.
A window whose end precedes its start wraps the year boundary.
`inHours(now, window)` is the test.
A season can carry an optional `night` window, and `nightFor(season, now)` is the check.
The Halloween night is `{ from: [10, 31, 18], to: [11, 1, 3] }`.
Winter has no night.
The night uses the same three gates as the rest of the phase.

`App.tsx` writes `data-season-night="<season id>"` on `<html>` while the night is on.
It also calls `setNightFrame(colours | null)`.

Tiles in the main document get the frame from CSS.
`VideoSurface` in `VoiceCallPanel.tsx` renders `<span class="chalk-voice-night">` after every `<video>`.
The tiles, the big spotlight tile, and the expanded stage are positioned boxes.
In `theme.css`, `.chalk-voice-night` is `display: none`, `position: absolute`, `inset: 0`, and click-through, with `z-index: 3`.
The rule `html[data-season-night="halloween"] .chalk-voice-night` shows it.
It paints an inset box-shadow: a 2 px pale green line and a 28 px glow.
The rule sits in the "Phase 129: seasonal" section, before the reduced-motion block.

The pop-outs and the board need another path.
`pip.ts` and `board.ts` build separate documents with no stylesheet.
The CSP of the opener refuses an injected `<style>`.
So `web/src/voice/night-frame.ts` paints the same frame as a `div` through the CSSOM.
`mountNightFrame(doc, container)` adds a click-through frame over a positioned container and returns its remover.
The container is the body of a pop-out, or the root of a board tile.
`setNightFrame(colours | null)` repaints every live frame.
The pop-out and board records have an `unframe` field, and the frame goes with its window or tile.
The frame sets a `className` and not an attribute, and it guards `remove`.
The pop-out and board tests use a minimal fake element that has neither `setAttribute` nor `remove`.

The frame is static on purpose.
A call is not the place for motion, so the reduced-motion block has nothing to switch off.

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
holiday, holidays, decoration, decorations, spooky, winter, snow, snowflake,
snowman, xmas, and advent. `ProfilePanel.tsx` has
a check box row for it after the flair section.

The switch is not a flair sub-switch. Flair is off by default and this switch
is on by default. A reader who has flair off still gets the figure.

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

The footer anchor (superseded by the header mount in 129-5). It was a
zero-size element with `position: absolute` and `bottom: 100%` at the top-right
corner of the footer, so the figure floated over the bottom-right corner of
the feed. It existed because the scroller could not host the figure.

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
- **129-4 — winter.** The second season in `seasons.ts`, with ten figures. The
  `aura` window, `inWindow`, and `auraFor`. The winter aura colours in
  `theme.css`. The winter keywords in `settings-nav.ts`. Tests in
  `seasons.test.ts` and `theme-season.test.ts`.
- **129-5 — the figure set.** The PNG cut-outs, `season/figures.ts`,
  `pickFigure`, the `<img>` in `SeasonFigure.tsx`, `assets.d.ts`, the `.png`
  loader in `test.mjs`, `tools/cut-season-sheet.py`, and `figures.test.ts`.
- **129-6 — the night frame on video tiles.** `HourWindow`, `night`, `inHours`,
  and `nightFor` in `seasons.ts`. The minute clock and the `data-season-night`
  attribute in `App.tsx`. The span in `VideoSurface` and the rules in
  `theme.css`. `voice/night-frame.ts`, with its use in `pip.ts` and `board.ts`.
  Tests in `seasons.test.ts`, `voice/night-frame.test.ts`, and
  `theme-season.test.ts`.

## Trade-offs

1. A change by an administrator reaches other clients on their next page load.
   `GET /api/auth/config` is cached with `max-age=60`, so the delay is one
   minute at most. A `welcome` payload field or a WebSocket broadcast is a
   later slice if it is wanted.
2. The date check runs once a minute, so the 18:00 edge of the night frame is
   met within the minute. It costs one render a minute. A tab can show the
   figure up to one minute into 2 November, or into 7 January.
3. A pop-out opened during the night has its frame at once. A pop-out that
   stays open across 18:00 is repainted by `setNightFrame`.

## Verification

Done on 2026-10-31: `go build`, `go vet`, `gofmt -l` (empty), and
`go test ./...` pass. `npx tsc --noEmit` is clean. `node test.mjs` passes
1656 tests. `node build.mjs` succeeds. After 129-4 and 129-5, the client suite
passes 1664 tests. The database-backed tests pass against
the dev Postgres.

A Playwright probe drives the real UI. It lives in the scratch slot
`.claude/skills/run-chalk/probes/ui.mjs` and is not committed. The probe ran
against the dev stack on 2026-10-31 and its 32 checks passed:

- Desktop header geometry: the figure sits right after the wordmark, and the header has the same height with and without it
- A long feed, at the bottom and scrolled to the top: the figure keeps its place
- Reduced motion
- The device switch
- The phone layout, with no sideways overflow
- No page errors
- The what's-new note that names the ghost
- The admin tab, which reads the stored value again
- The admin switch end to end: config false, row stored, own figure gone at once, peer sees none after a cache-cleared reload, back on

The probe has four more checks for the aura.
They test four facts:

- The aura covers the window
- The aura is lit while the ghost is out
- The aura paints an edge and not a fill
- The aura is dark when the ghost hides

The aura checks came after the 32-check run.
Run the probe again to see them pass.

The probe also has two checks for the figure set.
They test two facts:

- The figure is a loaded Halloween cut-out
- The next visit shows a different figure

The probe ran again on 2026-10-31 against the dev stack, with 39 checks.
One check failed, and the cause was a mistake in the probe baseline.
The probe compared the figure of the next visit with a figure it captured before the device switch remounted the component.
The probe now uses a baseline captured after the remount.

### Manual checklist for the live stack

Use two users, Alice and Bob, and a date inside the window.

1. Check that the figure is absent for the first 4 s after a text channel
   opens, and that it shows at some point in the next 12 s.
2. Check that the figure sits in the header beside the wordmark, and that the
   header has the same height with and without the figure.
3. Check that the figure stays in the header in a voice channel and in a
   parked channel.
4. Emulate reduced motion. Check that the figure comes and goes without a fade
   and without a bob.
5. Clear the check box under settings, appearance, seasonal. Check that the
   figure does not mount on this device. Check that it stays off after a
   reload.
6. Check that a device with flair off still shows the figure.
7. Check the phone layout (400 px wide). Check that the figure sits in the header
   after the wordmark and does not cause sideways overflow.
8. As an administrator, open the settings tab in the admin panel and turn the
   switch off. Check that the figure on the screen of the administrator goes
   away at once.
9. Check that Bob loses the figure on his next page load, one minute at most
   after the save.
10. Check that a signed-out client of an instance with the switch off never
    shows the figure.
11. Close and open the settings tab. Check that it shows the saved value.
12. Set the system date outside every window. Check that no figure shows.
13. Check that the edge of the window glows while the figure is out, and that the edge is dark otherwise.
14. On a light theme, for example `warmwhite`, check that the edge glow is a visibly darker green.
15. Wait for two visits. Check that the second visit shows a different figure from the first.
16. Set the system date to 10 December. Check that a winter figure shows and that the window edge does not glow.
17. Set the system date to 22 December. Check that a winter figure shows and that the window edge does not glow.
18. Set the system date to 24 December. Check that the window edge glows ice blue while the figure is out.
19. On a light theme, for example `warmwhite`, check that the ice-blue glow is visibly darker.
20. Watch a whole fade-out. Check that the figure does not change until it is gone.
21. On 31 October after 18:00, join a video call. Check that every tile, the expanded tile, a pop-out window, and the board show the green frame.
22. At 03:00 on 1 November, check that the green frame goes.
23. Before 18:00 on 31 October, check that no green frame shows.

## How to add a season

1. Add an entry to `SEASONS` in `web/src/season/seasons.ts`.
   It has an `id`, a `from` and a `to` date, and the `figures` list.
   Add an `aura` window if the glow must run for only part of the season.
   For example:
   `{ id: "spring", from: [3, 20], to: [4, 5], figures: [...], aura: { from: [3, 20], to: [3, 21] } }`.
2. Put one PNG for each figure in `web/assets/season/<id>/<figure>.png`.
   If you cut the figures from a sheet, add a row to the `ROWS` table in `tools/cut-season-sheet.py` and run the tool.
3. Add one import and one entry for each figure to `FIGURES` in `web/src/season/figures.ts`.
   The key is `<id>/<figure>`. Give each entry a `label`.
4. Add the new id to `SeasonId` in `seasons.ts`.
5. Add two aura colour pairs to `web/src/theme.css`.
   The first pair is for dark themes.
   The second pair is for the rule that lists the five light themes.
   The pale glow of a dark theme is invisible on a light page.
6. Add the keywords of the season to the `seasonal` section in `settings-nav.ts`, if they are not there.
7. Optional: add a `night` window to the season.
   A `night` window needs a rule `html[data-season-night="<id>"] .chalk-voice-night` in `theme.css`.
   It also needs colours in the `setNightFrame` call in `App.tsx`.
   `theme-season.test.ts` fails if a season has a `night` window and no such rule.

`seasons.test.ts`, `figures.test.ts`, and `theme-season.test.ts` loop over the registry.
They fail if a figure file, a `FIGURES` entry, or an aura colour is missing.

The device switch, the server switch, and the schedule need no change.
The component needs no change.
