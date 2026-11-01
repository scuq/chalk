# Phase 129 — seasonal: a scene for the season

**Status:** built, 129-1 – 129-10. 129-1 – 129-3 shipped in v0.8.27, and 129-4 – 129-6 shipped in v0.9.0. 129-7 to 129-10 are not yet in a release. 129-8 to 129-10 land together.
**Tags:** `#seasonal` → `tools/where.sh -g seasonal`

## The problem

chalk had nothing that marked a season. The brief: on special days a small
visitor sits in the chat. The visitor appears and disappears on its own. It is
on by default. An administrator can turn it off for the whole server.

The visitor began as a ghost for Halloween (129-1) and grew into a set of
figures for two seasons (129-4, 129-5). 129-8 and 129-9 replaced the figures
with an animated pixel scene for each of eight seasons. 129-10 left gaps
between the seasons, so chalk is not in a season all year, and it added
always-on hours for two evenings.

## The design

### The calendar decides which season it is

`web/src/season/seasons.ts` holds `SEASONS`, a table of 10 rows for eight
seasons. Each row has an `id`, a `label`, and a window of 1-based month and day
pairs.
The rows do not cover the whole year (129-10):

- New Year: 31 December, and 1 to 7 January
- Winterfest: 29 January to 7 February, and 22 to 30 December
- Spring Bloom: 1 March to 9 April
- Green Season: 1 to 30 May
- Midsummer: 21 June to 10 August
- Harvest Festival: 1 to 23 September
- Spooky Season: 15 October to 5 November
- Late Autumn: 27 to 30 November

Between two seasons is a gap of 21 days in a common year. The gaps are:

- 8 to 28 January
- 8 to 28 February
- 10 to 30 April
- 31 May to 20 June
- 11 to 31 August
- 24 September to 14 October
- 6 to 26 November
- 1 to 21 December

A date in a gap has no season, and chalk shows no scene on it. The user asked
for this, so that chalk is not always in a season.
29 February falls in the gap from 8 February to 28 February, so it has no
season.

Winterfest has two rows because it comes twice in the year. New Year has two
rows because it crosses the year boundary. Two rows can share an `id`.
`inWindow` compares month and day keys, so the rows work in all years.

`seasonFor(now)` is a pure function. It takes the clock as a parameter and
reads the local calendar date of the reader. It ignores the year. It returns
null for a date in no row. With the default `SEASONS` that is a normal result,
and `App.tsx` mounts no scene and spends no visit.
`inWindow(now, window)` is the shared window test. It still handles a window
whose end comes before its start, which wraps the year boundary.
`label` is the name of the season for a person. The scene also uses it as the
label for a screen reader.

The calendar is written for the Northern Hemisphere. chalk reads only the
local date, so a reader in the Southern Hemisphere gets the same calendar.

Before 129-8 the registry had two windows: Halloween from 24 October to
1 November, and winter from 1 December to 6 January. Winter also had an `aura`
window. 129-8 replaced both windows with a calendar of rows, and 129-9 removed
the `aura` window. 129-10 shortened the rows and left the gaps.

### The always-on hours (129-10)

`ALWAYS_ON` in `seasons.ts` is a list of two `HourWindow` values, by the local
clock:

- 20:00 on 24 December until 05:00 on 25 December
- 20:00 on 31 December until 05:00 on 1 January

`alwaysOn(now, windows)` reports whether `now` lies inside one of them. The
`from` hour is inside and the `to` hour is outside.

During these hours the scene stays up without a break. `App.tsx` passes
`always={alwaysOn(seasonNow)}` to `SeasonScene`. In `SeasonScene`, `live` is
`always || visit.visible`. The schedule claims no visit while `always` is true,
so the daily caps do not count these hours. Outside the hours the visits and the
caps work as before, also on the same day.

The same gates apply. A phone width shows no scene, and the device switch and
the server switch turn it off. With reduced motion the scene holds one frame
for the hours. Both windows fall on dates that have a row, so the calendar gate
is open in them.

The list is separate from the rows on purpose. The second window crosses from
the 31 December row into the 1 January row. A field on a row would need two
copies of the window.

### The scene peeks, it is not furniture

The first schedule (129-1 to 129-6) was a loop of 8 s to 15 s shown and 25 s to
90 s hidden.
It restarted at each page load and had no limit.
It brought the figure and the glow about 1,250 times a day to each open tab.
129-7 replaced it with a cap, and 129-9 changed its numbers.

`web/src/season/peek.ts` sets the bounds and decides if a visit is due.
`web/src/season/visits.ts` keeps the log of visits.

- The cap is `MAX_VISITS_PER_DAY`, which is 16.
- `MAX_DAYTIME_VISITS`, which is 10, is the most visits that can start before
  `EVENING_HOUR`. `EVENING_HOUR` is 18, local time.
  So a tab that stays open all day does not use up the evening.
  The evening has at least 6 visits left.
- After a visit, the next one is due 1 to 2 hours later (`GAP_MS`) if the
  visit started before `EVENING_HOUR`. If it started at `EVENING_HOUR` or
  later, the next one is due 20 to 40 minutes later (`EVENING_GAP_MS`).
  The time counts from the start of the visit.
- The first visit of a day stays prompt: 4 s to 12 s after the page loads
  (`FIRST_PAUSE_MS`). A reload after that does not bring a new visit.
- A visit shows for 45 s to 75 s (`SHOW_MS`).
- While the scene is hidden, each page checks once a minute (`CHECK_MS`).
  This one poll covers midnight, a claim by another tab, and a page that was
  in the background.
- Only a visible page (`document.visibilityState`) claims a visit.
  A background tab does not spend the visits of the day where nobody sees them.
  If two windows are visible, one of them shows the visit.
- A phone width mounts no scene, so it claims no visit (see "The mount").

The log is `{day, count, nextAt}` in localStorage under the key `chalk.season.visits.v1`.
All tabs and reloads of one browser share it.
`claimVisit` in `peek.ts` is a pure function of the log, the clock, and the random source.
It returns the new log, or null if no visit is due.
`takeVisit` in `visits.ts` reads the log, calls `claimVisit`, and writes the result.

If `nextAt` is further away than the longest gap, `GAP_MS[1]`, someone moved
the clock back.
That value counts as due, so a changed system date cannot silence the scene.
If localStorage fails, a module variable holds the log, and the cap holds for that page only.
The night frame on video tiles is not a visit.
It is continuous for the whole night and has no cap.

Each duration is random inside its bounds. The random source is a parameter,
so a test can pin it. The component owns one `setTimeout` per step and clears
it on unmount.

### The scene

`web/src/season/scene.ts` draws the scene. It is a port of a reference scene
that the user supplied.
It exports `THEMES`, one entry for each `SeasonId`, and four functions:

- `createScene(season, W, H)` returns a new scene of W by H scene pixels.
- `resizeScene(scene, W, H)` moves the ground and the obstacles to fit a new size.
- `stepScene(scene, elapsed)` moves the scene forward by `elapsed` seconds.
  It counts at most 0.1 s, so a long frame cannot throw a walker across the strip.
- `drawScene(ctx, scene)` paints the scene. It does not clear the canvas.

One scene pixel is `SCALE` CSS pixels, and `SCALE` is 2. The scene runs at
`FPS` frames each second, and `FPS` is 12.

The module is pure apart from the `Painter` it gets. `Painter` is the part of
`CanvasRenderingContext2D` that the code uses: `fillStyle` and `fillRect`. The
module uses no timer, no DOM, and no random source. Each effect takes its
places from a hash of an index and from the time of the scene. So a test uses a
fake `Painter` and gets the same picture each time.

Two walkers enter from the two edges and walk in opposite directions.
Two obstacles stand at 20 percent and 80 percent of the width.
A walker on the ground jumps when an obstacle is 0 to 9 scene pixels ahead, and
it jumps over each obstacle once for each pass.
Each season sets a landscape, two obstacles, two walkers, and one effect:

| Season | Landscape | Obstacles | Walkers | Effect |
|---|---|---|---|---|
| New Year | city | crate, crate | person, cat | fireworks |
| Winterfest | pine | snowball, stump | penguin, fox | snow |
| Spring Bloom | blossom | flowerpot, stone | rabbit, chick | petals |
| Green Season | forest | log, stone | frog, fox | butterflies |
| Midsummer | meadow | stone, flowerpot | person, rabbit | fireflies |
| Harvest Festival | harvest | mushroom, hay | hedgehog, fox | leaves |
| Spooky Season | graveyard | pumpkin, grave | skeleton, cat | ghosts and bats |
| Late Autumn | bare | mushroom, log | fox, hedgehog | leaves |

New Year, Winterfest, and Spooky Season have stars. The first two have a pale
moon, and Spooky Season has an orange moon. Late Autumn has a pale moon and no
stars. The other four seasons have a sun.

The scene differs from the reference on purpose:

- It has no sky fill, no haze, and no ground block. The canvas is transparent,
  so the scene blends with all 15 themes.
- It has no title panel and no pixel font. They do not blend.
- The ground is the bottom line of the header: `ground = H - 1`.

`web/src/season/scene.test.ts` uses a fake `Painter`.
It checks that `THEMES` and `SEASONS` list the same ids, that every season
draws whole pixels with no rectangle as wide as the strip, that the walkers
enter from the edges and jump, and that a resize and a very narrow strip do not
break a scene.

### The component

`web/src/components/SeasonScene.tsx` replaces `SeasonFigure.tsx`.
It keeps the one-timer schedule and the visible-page rule of 129-7: a
`setTimeout` for each step, and `takeVisit` only for a visible page.
One component serves every season.

`runScene` starts a visit. It sets the size of the canvas from its CSS size
divided by `SCALE`, makes a new scene, and paints it once. Each visit makes a
new scene, so no state passes from one visit to the next.
Unless the system asks for reduced motion, it then starts a
`requestAnimationFrame` loop. The loop steps and paints the scene at `FPS`.
A `ResizeObserver` resizes the scene when the canvas changes size.

The loop runs only while the canvas is up: during a visit, and in the always-on
hours. When the visit ends, it stops `FADE_MS`
later, and `FADE_MS` is 1200. This is the time of the CSS fade-out. If the loop
stopped first, the scene would freeze in the picture while it fades.

With `prefers-reduced-motion: reduce`, a visit paints one frame and holds it,
and the CSS fade is off. So the promise in the profile panel, that the scene
holds still, stays true.

The canvas has `role="img"` and the aria-label "<label>, an animated pixel
scene". It has `aria-hidden` while it is hidden. It sets `data-season` to the
season id and `data-visible` while the canvas is up, in a visit or in the
always-on hours.

### The mount

`App.tsx` mounts `SeasonScene` in the header, between `.chalk-header-left` and
`StatusBar`. Three gates and one width rule decide if it mounts:

- The calendar says it is a season (`seasonFor` does not return null).
- The device switch is on.
- The server switch is on.
- The window is wider than 767 px (`!isMobile`).

It does not depend on the active channel, on a parked channel, or on the
phone's list screen.

`.chalk-season` is the strip. It has `flex: 1 1 0`, `min-width: 0`,
`align-self: stretch`, and `position: relative`. It takes the empty middle of
the header, and it cannot widen the header. It has `pointer-events: none`.
`.chalk-season-canvas` is out of flow: `position: absolute`, 100 percent wide,
and 44 px high. It sits on the bottom line of the header. The header has
padding of `--chalk-s3` below its content, so `bottom` is
`calc(-1 * var(--chalk-s3))`. The scene draws its ground on the last row of the
canvas, and the walkers stand on the line. `image-rendering: pixelated` keeps
the pixels sharp. A `mask-image` fades both ends, so the scene has no hard edge
against the brand and the status bar. The canvas has opacity 0.9 while a visit
shows.

The header has the same height with and without the scene. A check in a
browser found no change.

At 390 px only about 30 px of the middle remains, so the scene would be a
sliver. So a phone shows no scene and spends no visit. The old figure did show
on a phone. This is a recorded trade-off.

`App.tsx` reads the date again once a minute with `setInterval`. A tab that
stays open over midnight crosses the edge of a season without a reload.
The same minute clock has three uses: the season, the night frame, and the
always-on hours. The always-on hours start within a minute of 20:00.

### The motion

The motion is a JavaScript loop. The only CSS motion is a 1200 ms fade on the
opacity of the canvas. Under `prefers-reduced-motion: reduce` the transition is
off. The scene still comes and goes, but it jumps and does not fade.

The section "Phase 129: seasonal" in `web/src/theme.css` sits above the
"Phase 115: flair" section on purpose.
`theme-flair.test.ts` takes the last reduced-motion block of the sheet as the
block of flair. `web/src/theme-season.test.ts` holds every moving selector of
this phase to its own reduced-motion block. It also holds the section above
flair, and it checks the rules of the strip and the canvas.

### The night frame on video tiles

129-6 adds a green frame on the playback of video tiles on Halloween night.
The night runs from 18:00 on 31 October until 03:00 on 1 November, by the clock of each viewer.

`seasons.ts` has a `HourWindow` type.
Its `from` and `to` are `[month, day, hour]` triples.
The `from` hour is inside the window and the `to` hour is outside it.
A window whose end precedes its start wraps the year boundary.
`inHours(now, window)` is the test.
A season can carry an optional `night` window, and `nightFor(season, now)` is the check.
The night is on the Spooky Season row: `{ from: [10, 31, 18], to: [11, 1, 3] }`.
No other row has a night.
The night uses the same three gates as the rest of the phase. It does not
depend on the width rule, so a phone shows the frame on video tiles.

`App.tsx` writes `data-season-night="<season id>"` on `<html>` while the night is on.
The value is `spooky-season`. Before 129-8 it was `halloween`.
It also calls `setNightFrame(colours | null)`.

Tiles in the main document get the frame from CSS.
`VideoSurface` in `VoiceCallPanel.tsx` renders `<span class="chalk-voice-night">` after every `<video>`.
The tiles, the big spotlight tile, and the expanded stage are positioned boxes.
In `theme.css`, `.chalk-voice-night` is `display: none`, `position: absolute`, `inset: 0`, and click-through, with `z-index: 3`.
The rule `html[data-season-night="spooky-season"] .chalk-voice-night` shows it.
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

The scene shows only if all three hold, on a screen wider than a phone:

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
snowman, xmas, advent, scene, animation, fireworks, new year, spring, summer,
harvest, and autumn. `ProfilePanel.tsx` has
a check box row for it after the flair section.

The switch is not a flair sub-switch. Flair is off by default and this switch
is on by default. A reader who has flair off still gets the scene.

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

The client hides the scene until the config has loaded. An instance with the
switch off never shows the scene for a moment.

### The admin tab (129-3)

`AdminPanel.tsx` has a third tab, settings. The tab component is
`AdminSettingsTab.tsx`, with one switch row in the phase 124 row markup. The
API functions `getSettings` and `putSettings` are in `web/src/auth/admin.ts`.

The reducer state is `adminPanel.settings`, with load and save actions in
`web/src/state/types.ts` and `reducer.ts`. `reducer-admin-settings.test.ts`
covers them. The tab reads the switches again each time it opens.

After a successful save, the client of the administrator folds the value into
its loaded config (`auth_config_loaded`). The scene on the screen of the
administrator follows at once.

`web/src/whats-new.ts` has an entry for phase 129. 129-9 rewrote its lines in
place, because the entry is keyed by the phase number. A person who already
marked the entry as read does not see the new text.

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

A longer pause in `peek.ts` alone (129-7). It cannot give a maximum, because
each reload and each tab starts its own count.

A server-side count of visits (129-7). The scene is client presentation, and
a limit for each device is enough for a decoration.

The scene always on (129-9). The 12 fps loop runs only during a visit. 129-10
made two exceptions, the always-on hours.

A field on a `Season` row for the always-on hours (129-10). The second window
crosses from the 31 December row into the 1 January row, so the field would
need two copies of it.

The always-on hours as a visit (129-10). A visit has a length of 45 s to 75 s
and spends the daily caps. A span of nine hours would use up the caps, and the
other visits of the day would not come.

The title and the solid panel of the reference scene (129-9). They do not
blend with all 15 themes.

A phone layout with the scene on a second header row (129-9). It changes the
height of the header.

History: 129-1 to 129-8 showed a figure beside the wordmark. 129-1 drew an SVG
ghost, and 129-5 replaced it with 20 PNG cut-outs, ten for each of two seasons.
A tool cut them from an icon sheet. A glow along the inner edge of the window,
the aura, ran with the figure. 129-9 removed the figure, the cut-outs, the
tool, the aura, and their code and tests: `SeasonFigure.tsx`,
`season/figures.ts` and its test, `web/assets/season/`,
`tools/cut-season-sheet.py`, the `*.png` declaration in `web/src/assets.d.ts`,
and the `.png` loader in `web/test.mjs`. `pickFigure`, `auraFor`, and the
`figures` and `aura` fields left `seasons.ts`. The aura rules and colours left
`theme.css`.

## The slices

- **129-1 — the figure on the client.** `season/seasons.ts`, `season/peek.ts`,
  `SeasonFigure.tsx`, the mount and the date check in `App.tsx` (once a minute
  since 129-6), the CSS section, the device switch in `display-prefs.ts`,
  `settings-nav.ts`, and `ProfilePanel.tsx`, and `theme-season.test.ts`.
  129-9 replaced `SeasonFigure.tsx`.
- **129-2 — the server switch.** Migration 0062, `instance_settings.go`,
  `admin_settings_http.go`, and `seasonal_decorations` on
  `GET /api/auth/config`. Tests in `admin_settings_http_test.go`:
  `TestAdminSettingsRoundTrip` needs a database and skips without
  `CHALK_TEST_DATABASE_URL`. `TestConfigSeasonalDefaultsOnWithoutStore` does
  not need one.
- **129-3 — the admin tab.** `AdminSettingsTab.tsx`, the third tab in
  `AdminPanel.tsx`, `getSettings` and `putSettings`, and the reducer state.
- **129-4 — winter.** The second season in `seasons.ts`, with ten figures, an
  `aura` window, and ice-blue aura colours in `theme.css`. The winter keywords
  in `settings-nav.ts`. 129-8 and 129-9 replaced the winter window, the
  figures, and the aura.
- **129-5 — the figure set.** The PNG cut-outs, `season/figures.ts`,
  `pickFigure`, the `<img>` in `SeasonFigure.tsx`, `assets.d.ts`, the `.png`
  loader in `test.mjs`, `tools/cut-season-sheet.py`, and `figures.test.ts`.
  129-9 removed all of them.
- **129-6 — the night frame on video tiles.** `HourWindow`, `night`, `inHours`,
  and `nightFor` in `seasons.ts`. The minute clock and the `data-season-night`
  attribute in `App.tsx`. The span in `VideoSurface` and the rules in
  `theme.css`. `voice/night-frame.ts`, with its use in `pip.ts` and `board.ts`.
  Tests in `seasons.test.ts`, `voice/night-frame.test.ts`, and
  `theme-season.test.ts`.
- **129-7 — a cap on visits.** `claimVisit`, `GAP_MS`, `CHECK_MS`,
  `MAX_VISITS_PER_DAY`, and `VisitLog` in `season/peek.ts`. The new
  `season/visits.ts`. The visibility check and the claim in
  `SeasonFigure.tsx`. Tests in `peek.test.ts` and `visits.test.ts`.
  129-7 set the cap to 10 visits a day and the show time to 8 s to 15 s.
  129-9 changed both numbers.
- **129-8 — the calendar of eight seasons.** `SEASONS` in `season/seasons.ts`
  now has 10 rows for eight seasons that cover every day of the year, each with
  a `label`. The night frame moved to the Spooky Season row, so
  `data-season-night` is `spooky-season`. Tests in `seasons.test.ts`. 129-10
  shortened the rows and left the gaps.
- **129-9 — the scene.** `season/scene.ts` and `scene.test.ts`. The new
  `SeasonScene.tsx`, which replaces `SeasonFigure.tsx`, and its mount in
  `App.tsx` for a wide screen only. The strip and the canvas in `theme.css`.
  In `peek.ts`: `SHOW_MS` of 45 s to 75 s, `MAX_VISITS_PER_DAY` of 16,
  `MAX_DAYTIME_VISITS`, `EVENING_HOUR`, and `EVENING_GAP_MS`. New keywords in
  `settings-nav.ts`. New text in `ProfilePanel.tsx`, `AdminSettingsTab.tsx`,
  and `whats-new.ts`. The removals are in "What was rejected".

- **129-10 — gaps and always-on hours.** The rows of `SEASONS` now leave gaps
  of 21 days, so a date can have no season. `ALWAYS_ON` and `alwaysOn` in
  `season/seasons.ts`. The `always` prop and `live` in `SeasonScene.tsx`, and
  the `alwaysOn` call in `App.tsx`. Text in `whats-new.ts`. Tests in
  `seasons.test.ts`.

## Trade-offs

1. A change by an administrator reaches other clients on their next page load.
   `GET /api/auth/config` is cached with `max-age=60`, so the delay is one
   minute at most. A `welcome` payload field or a WebSocket broadcast is a
   later slice if it is wanted.
2. The date check runs once a minute, so the 18:00 edge of the night frame is
   met within the minute. It costs one render a minute. A tab can show the
   scene of the old season for up to one minute after midnight changes the
   season.
3. A pop-out opened during the night has its frame at once. A pop-out that
   stays open across 18:00 is repainted by `setNightFrame`.
4. The cap is for a device (a browser profile) and for a local calendar day.
   It is not for an account. A person with two devices gets 16 visits on each.
   A new day starts at local midnight, and the next check, one minute at most
   later, notices it.
5. The count in localStorage is not a secret and not a guard. A person who
   clears the key gets visits again. This is an accepted property for a decoration.
6. A window of 767 px or less shows no scene. The old figure did show on a
   phone. A phone now shows no seasonal art, and a visit is not spent there.
   The scene does not fit: at 390 px only about 30 px of the middle remains.
7. The calendar is for the Northern Hemisphere. A reader in the Southern
   Hemisphere sees the same season on the same date.
8. The loop of the scene runs at 12 fps during a visit and for 1.2 s after it.
   This costs CPU for about a minute each visit, and nothing between visits.
9. 129-9 and 129-10 rewrote the what's-new entry of phase 129 in place. A person
   who already marked it as read does not see the new text.
10. In the always-on hours the 12 fps loop runs for nine hours while the tab is
    visible. `requestAnimationFrame` pauses in a hidden tab. This costs CPU
    for nine hours on two evenings of the year.
11. The always-on hours follow the Northern Hemisphere calendar, like the rows. A reader in the Southern Hemisphere sees the scene in summer on those
    evenings.
12. A phone width shows no scene in the always-on hours either.

## Verification

Done on 2026-10-31: `go build`, `go vet`, `gofmt -l` (empty), and
`go test ./...` pass. `npx tsc --noEmit` is clean. `node test.mjs` passes
1656 tests. `node build.mjs` succeeds. After 129-4 and 129-5, the client suite
passes 1664 tests. The database-backed tests pass against
the dev Postgres. These counts date from before 129-7 to 129-9.

A Playwright probe drives the real UI. It lives in the scratch slot
`.claude/skills/run-chalk/probes/ui.mjs` and is not committed. The probe ran
against the dev stack on 2026-11-01. It made one set of checks for each of the
eight seasons:

- The season id on the canvas is the season of the date
- The scene paints
- The scene moves between two frames
- The header height is the same as without the scene

It also made these checks:

- No sideways overflow at phone width
- Reduced motion holds one frame
- No page errors

A second probe ran on 2026-11-02. It checked a neutral date, a season date,
the four sides of the always-on hours, and a date just before them. It passed.

### Manual checklist for the live stack

Use two users, Alice and Bob, and a date inside a season. A date in a gap has
no season (see item 13).

1. Clear the key `chalk.season.visits.v1` from localStorage and reload.
   Check that the scene is absent for the first 4 s after a text channel
   opens, and that it shows at some point in the next 12 s.
2. Check that the scene sits in the middle of the header, between the brand and
   the status bar. Check that the walkers stand on the bottom line of the
   header, that both ends of the scene fade out, and that the header has the
   same height with and without the scene.
3. Check that the scene stays in the header in a voice channel and in a
   parked channel.
4. Emulate reduced motion. Check that the scene comes and goes without a fade,
   and that it holds one frame and does not move.
5. Clear the check box under settings, appearance, seasonal. Check that the
   scene does not mount on this device. Check that it stays off after a
   reload.
6. Check that a device with flair off still shows the scene.
7. Check the phone layout (400 px wide). Check that no scene shows, that the
   header looks as before, and that there is no sideways overflow. Check that
   the count in `chalk.season.visits.v1` does not change.
8. As an administrator, open the settings tab in the admin panel and turn the
   switch off. Check that the scene on the screen of the administrator goes
   away at once.
9. Check that Bob loses the scene on his next page load, one minute at most
   after the save.
10. Check that a signed-out client of an instance with the switch off never
    shows the scene.
11. Close and open the settings tab. Check that it shows the saved value.
12. Set the system date to each date in the list below. Check that the scene
    shows the landscape and the effect of the season:
    - 3 January: New Year, a city with fireworks
    - 15 January: Winterfest, pines with snow
    - 10 April: Spring Bloom, blossom trees with petals
    - 10 May: Green Season, a forest with butterflies
    - 15 July: Midsummer, a meadow with fireflies
    - 20 September: Harvest Festival, with falling leaves
    - 28 October: Spooky Season, a graveyard with a ghost and bats
    - 10 November: Late Autumn, bare trees with falling leaves
    - 30 December and 31 December: Winterfest, then New Year
13. Set the system date to a date in a gap, for example 15 April, 15 November,
    and 10 December. Check that no scene mounts and that the count in
    `chalk.season.visits.v1` does not change.
    Set the system date to 29 February of a leap year. Check that no scene
    shows, because the date is in the gap from 8 February to 28 February.
14. Switch between a dark theme and a light theme, for example `warmwhite`.
    Check that the scene shows on both with no panel behind it.
15. Check that two visits make a new scene: the walkers enter from the edges
    again. The second visit comes 20 minutes or more after the first, and 1 hour
    or more if the first started before 18:00. To avoid the wait, clear the key `chalk.season.visits.v1` from localStorage after
    the first visit. The next visit then comes within a minute.
16. Watch a whole fade-out. Check that the scene keeps moving until it is gone.
17. Change the width of the window during a visit. Check that the scene
    follows the new width.
18. On 31 October after 18:00, join a video call. Check that every tile, the expanded tile, a pop-out window, and the board show the green frame.
19. At 03:00 on 1 November, check that the green frame goes.
20. Before 18:00 on 31 October, check that no green frame shows.
21. After the first visit of the day, reload the page. Check that no new visit comes after the reload.
22. Open chalk in a background tab, and wait 5 minutes. Check that the tab shows no visit and that the count in `chalk.season.visits.v1` does not change. Then bring the tab to the front and check that a visit can come.
23. Set `chalk.season.visits.v1` to `{"day":"<today>","count":10,"nextAt":0}`,
    where *today* is the local date as `year-month-day` without leading zeros,
    for example `2026-11-2`. Before 18:00 local time, check that no visit
    comes. After 18:00, check that a visit comes within a minute.
24. Clear the key `chalk.season.visits.v1` from localStorage. Check that the next visit comes within a minute. This is the way to check a visit by hand.
25. Set the system clock to 19:59 on 24 December. Check that the scene shows
    only as a visit. Within a minute after 20:00, check that the scene stays up
    without a break.
26. Set the system clock to 04:59 on 25 December. Check that the scene is up.
    After 05:00, check that it goes, and that visits work as before.
27. Repeat items 25 and 26 for 31 December, with 05:00 on 1 January as the end.
    Check that the scene stays up across midnight.
28. In the always-on hours, check that the count in `chalk.season.visits.v1`
    does not change, that a phone width shows no scene, and that a device with
    the switch off shows no scene.

## How to add a season

1. Add a row to `SEASONS` in `web/src/season/seasons.ts`.
   It has an `id`, a `label`, a `from` date, and a `to` date.
   The rows must stay in calendar order with no overlap. Leave a gap of
   21 days between two seasons, or shorten the row of the season whose days you
   take.
   A season can have more than one row. The rows then share the `id`.
2. Add the new id to `SeasonId` in `seasons.ts`.
3. Add an entry to `THEMES` in `web/src/season/scene.ts`, with the same key.
   It sets the landscape, the obstacles, the walkers, the effect, the stars,
   and the moon. A landscape, obstacle, walker, or effect that does not exist
   yet needs drawing code in `scene.ts`.
4. Add the keywords of the season to the `seasonal` section in `settings-nav.ts`, if they are not there.
5. Optional: add a `night` window to the season.
   A `night` window needs a rule `html[data-season-night="<id>"] .chalk-voice-night` in `theme.css`.
   It also needs colours in the `setNightFrame` call in `App.tsx`.
   `theme-season.test.ts` fails if a season has a `night` window and no such rule.

`seasons.test.ts` checks that no day falls in two rows and that each gap is a
date in no row.
`scene.test.ts` checks that `THEMES` and `SEASONS` list the same ids.

The device switch, the server switch, the schedule, the component, and the
stylesheet need no change.
