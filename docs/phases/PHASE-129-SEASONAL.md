# Phase 129 — seasonal: a scene for the season

**Status:** in progress. Built: 129-1 – 129-23. Open: 129-24 and later. They tune the five keys that have rows, one key in each slice, in this order: spring-bloom, green-season, midsummer, harvest-festival, spooky-season. One cleanup item is open: the dead snow branches of the scene engine (see "The winterfest scripts"). 129-1 – 129-3 shipped in v0.8.27, and 129-4 – 129-6 shipped in v0.9.0. 129-7 to 129-14 shipped in v0.10.0. 129-15 and later are not yet in a release. 129-8 to 129-10 land together.
**Tags:** `#seasonal` → `tools/where.sh -g seasonal`

## The problem

chalk had nothing that marked a season. The brief: on special days a small
visitor sits in the chat. The visitor appears and disappears on its own. It is
on by default. An administrator can turn it off for the whole server.

The visitor began as a ghost for Halloween (129-1) and grew into a set of
figures for two seasons (129-4, 129-5). 129-8 and 129-9 replaced the figures
with an animated pixel scene for each of eight seasons. 129-10 left gaps
between the seasons, so chalk is not in a season all year, and it added
always-on hours for two evenings. 129-12 replaced the scene engine with one
that has 45 scenes, and it gave the dates in the gaps scenes of their own.
129-13 added the title of the season on a small sign. 129-14 moved the sign up
so the walkers run under it, gave each scene a sky, and added the details of
each season. 129-15 made a visit hold one scene. 129-16 gave the neutral scene
its own windows in the day. 129-18 replaced the five neutral rows with ten
scripted scenes that are nods to films and series. 129-19 added the
`christmas` key: it shows seven scripted scenes from 1 to 26 December, and it
changed the calendar around the turn of the year. 129-20 replaced the five
New Year rows with seven scripted scenes: six nods to films, series, and a
game, and one plain fireworks show. 129-21 replaced the five Winterfest rows
with eight scripted scenes that are nods to films and series. 129-22 added
the `black-week` key: nine scripted scenes about money and sales, from the
Monday before Black Friday to Cyber Monday. It is the first season whose dates
move with the year, and the first whose scenes show sign words and prices.
129-23 replaced the five Late Autumn rows with seven scripted scenes: five nods
to films and series, and two nods to games.

## The design

### The calendar decides which season it is

`web/src/season/seasons.ts` holds `SEASONS`, a table of 11 rows for ten
season ids. Each row has an `id`, a `label`, and a window of 1-based month and day
pairs.
The rows do not cover the whole year (129-10):

- New Year: 31 December, and 1 January
- Winterfest: 2 January to 7 February
- Spring Bloom: 1 March to 9 April
- Green Season: 1 to 30 May
- Midsummer: 21 June to 10 August
- Harvest Festival: 1 to 23 September
- Spooky Season: 15 October to 5 November
- Late Autumn: 16 to 22 November (129-22)
- Black Week: 23 to 30 November in 2026. The dates move with the year (129-22).
- Christmas: 1 to 26 December (129-19)

Between two seasons is a gap. A gap lasts 21 days in a common year, except two
gaps. The gap from 6 to 15 November lasts ten days (129-22). The gap from 27 to
30 December lasts four days (129-19). The gaps are:

- 8 to 28 February
- 10 to 30 April
- 31 May to 20 June
- 11 to 31 August
- 24 September to 14 October
- 6 to 15 November
- 27 to 30 December

A date in a gap has no season. 129-10 showed no scene on such a date, because
the user wanted chalk not to be in a season all year. 129-12 changed this: a
date in a gap shows the neutral scenes (see "Neutral dates"). 129-19 changed
the calendar at the turn of the year: the gaps from 8 to 28 January and from
1 to 21 December are gone, and the gap from 27 to 30 December is new.
29 February falls in the gap from 8 February to 28 February, so it has no
season. It is a neutral date.

New Year has two rows because it crosses the year boundary. Two rows can share
an `id`. Before 129-19, Winterfest also had two rows, one in January and
February and one in December.
`inWindow` compares month and day keys, so the rows work in all years.

`seasonFor(now)` is a pure function. It takes the clock as a parameter and
reads the local calendar date of the reader. It ignores the year, except for a
season that has `moving` (see "Black Week moves with the year"). It returns
null for a date in no row. With the default `SEASONS` that is a normal result,
and `App.tsx` passes `season={null}` to `SeasonScene`, which shows the neutral
scenes.
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

#### Black Week moves with the year (129-22)

Black Week is the first season whose dates move. It runs from the Monday before
Black Friday to Cyber Monday. Black Friday is the day after the fourth Thursday
of November. The window starts four days before Black Friday and ends three days
after it.

| Year | Window |
|---|---|
| 2025 | 24 November to 1 December |
| 2026 | 23 to 30 November |
| 2027 | 22 to 29 November |
| 2030 | 25 November to 2 December |

`Season` has the optional field `moving(year)`. It returns the window of the
season in that year. `blackWeek(year)` is the function for `black-week`.
`seasonFor` tests the seasons that have `moving` first, with the year of `now`.
Then it tests the fixed rows. So on its days black week comes before every
fixed row. It takes 22 November from late-autumn in 2027. It takes 1 December
from christmas in 2025, and 1 and 2 December in 2030.

The `from` and `to` of the `black-week` row in `SEASONS` are the dates of 2026.
`seasonFor` ignores them for this row. They only keep the rows in calendar
order, which `seasons.test.ts` checks.

In some years a day between 23 and 30 November has no season: 23 November in
2025, 23 and 24 November in 2030, and 30 November in 2027. Such a day is a
neutral date. Black week has no always-on hours.

The user moved Late Autumn from 27 to 30 November to 16 to 22 November. The
gap after Spooky Season is now 6 to 15 November, and it lasts ten days.

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

The same gates apply. The header of a phone width shows no scene (129-11 added
a row for zuckermode, see "The mount"), and the device switch and the server
switch turn it off. With reduced motion the scene holds one frame
for the hours. Both windows fall on dates that have a row, so they show the
scenes of a season. The first window falls in the `christmas` key, so it rotates
through the seven Christmas scripts. The second window falls in the `new-year`
key, so it rotates through the seven New Year scripts. The neutral scenes do
not occur in them.

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
The cap, the gaps, and the log below are for the scenes of a season. The neutral
scene has its own rule (see "Neutral dates", 129-16).

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
- The header of a phone width mounts no scene, so it claims no visit. A phone
  in zuckermode claims a visit only while the list screen shows (see "The
  mount").

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

`web/src/season/scene.ts` draws the scene. 129-12 replaced the engine of
129-9 with a port of a second engine that the user supplied, to get more
variety. It exports these names:

- `SCENES`, a table from a `RowKey` to five `SceneRow` values, so there are
  25 rows. `SceneKey` is a `SeasonId` or `"neutral"`, so there are eleven keys.
  A `ScriptKey` is a key that runs scripts: `"neutral"`, `"christmas"`,
  `"new-year"`, `"winterfest"`, `"black-week"`, and `"late-autumn"`. A `RowKey`
  is a `SceneKey` that is not a `ScriptKey`, so there are five: `spring-bloom`,
  `green-season`, `midsummer`, `harvest-festival`, and `spooky-season`. A
  `ScriptKey` has no rows. `"neutral"` has the ten scripts of `OFFSEASON` (129-18), `"christmas"`
  has the seven scripts of `CHRISTMAS` (129-19), `"new-year"` has the seven
  scripts of `NEWYEAR` (129-20), `"winterfest"` has the eight scripts of
  `WINTERFEST` (129-21), `"black-week"` has the nine scripts of `BLACKWEEK`
  (129-22), and `"late-autumn"` has the seven scripts of `LATEAUTUMN` (129-23).
  So there are 73 scenes.
- `SCENES_PER_KEY` (5), `SCENE_SECONDS` (35), and `FADE_SECONDS` (0.7).
- `sceneCount(key)` returns 10 for `"neutral"`, 7 for `"christmas"`,
  `"new-year"`, and `"late-autumn"`, 8 for `"winterfest"`, 9 for `"black-week"`,
  and `SCENES_PER_KEY` for any other key (129-18, 129-19, 129-20, 129-21,
  129-22, 129-23).
  `isScripted(key)` reports whether `key` is a `ScriptKey` (129-19). Since
  129-22 it tests whether `key` is a key of `SCRIPTED`.
- `sceneWeights(key)` returns the weight of each scene of `key`, in the order
  of the scenes (129-22). See "The Black Week scripts".
- `holdStill(scene)` moves a scene with a script to the still time of its
  script, for reduced motion (129-18).
- `SCALE` (2) and `FPS` (12). One scene pixel is `SCALE` CSS pixels, and the
  scene runs at `FPS` frames each second.
- `createScene(key, W, H, index)` returns a new scene of W by H scene pixels,
  which starts at the row `index`, or at the script `index` for a `ScriptKey`. An
  index outside 0 to `sceneCount(key) - 1` wraps around.
- `resizeScene(scene, W, H)` moves the ground and the obstacles to fit a new
  size.
- `stepScene(scene, elapsed)` moves the scene forward by `elapsed` seconds. It
  counts at most 0.1 s, so a long frame cannot throw a walker across the
  strip. It also rotates the scene.
- `sceneAlpha(scene)` returns the opacity of the scene, from 0 to 1.
- `drawScene(ctx, scene)` paints the scene. It does not clear the canvas.

A `SceneRow` has a name, an environment, an effect, four props, and two cast
members. The fields are typed unions and not strings, so a misspelled prop
fails at compile time. The four props stand at four places: 12 scene pixels
from the left edge, 20 percent of the width, 80 percent of the width, and 24
scene pixels from the right edge. The props at index 1 and 2 are the obstacles.
The first cast member enters from the left edge and the second from the right
edge, and they walk in opposite directions. A walker on the ground jumps when
an obstacle is 0 to 10 scene pixels ahead. It jumps over each obstacle once for
each pass.

The ghost is the exception. A ghost floats and does not jump. Its bob is part
of the drawing. The new cast members are the witch and the ghost. The new
effects are confetti, sparkles, aurora, rain, embers, lanterns, bats, fog, and
clouds.

The module is pure apart from the `Painter` it gets. `Painter` is the part of
`CanvasRenderingContext2D` that the code uses: `fillStyle`, `fillRect`, and,
since 129-12, `globalAlpha`. The module uses no timer, no DOM, and no random
source. Each effect takes its places from a hash of an index and from the time
of the scene. So a test uses a fake `Painter` and gets the same picture each
time. `PALETTES` gives each key an earth colour and an edge colour.

The 73 scenes:

| Key | Scenes |
|---|---|
| `black-week` | The Bar, The Latinum Mountain, The Doors Open, The Money Bin, Merchandising, Through the Glasses, The Junk Shop, The Machine's Markup, The Sign Goes Wrong |
| `new-year` | Year 3000, The Statue Walks, Y2K, The Gate at Midnight, The Wrong Year, Thumb against the Cloud, Fireworks over the River |
| `winterfest` | The Walker Falls, The Gate under the Ice, The Ship in the Glacier, The Climb, The Dog in the Snow, The Station in the Ice, The Maze, The Prison Colony |
| `christmas` | Party at the Tower, The House with the Traps, Gremlins in the Tree, Robot Santa, The Light Show, The Ornament, The Ribbon at Christmas |
| `spring-bloom` | Cherry Blossom, Rain Garden, Pond Hopping, Flower Trail, Butterfly Orchard |
| `green-season` | Deep Woods, Stream Crossing, Fern Garden, Hillside Run, Summer Rain |
| `midsummer` | Golden Meadow, Lakeside Sunset, Campfire Evening, Firefly Night, Festival Lanterns |
| `harvest-festival` | Mushroom Grove, Apple Orchard, Hayfield Run, Village Market, Golden Fields |
| `spooky-season` | Old Graveyard, Haunted Manor, Witchwood, Foggy Marsh, Pumpkin Patch |
| `late-autumn` | The Thing in the Fog, The Duel in the Garden, Coffee and the Owl, The Vineyard, Leaf Chase, The Raid, The Harvest Helpers |
| `neutral` | Time Car, Night Highway, Code Rooftop, Starship, The Gate, Light Cycles, Twin Suns, The Hatch, Shadow over Town, Flashlights in the Woods |

#### Rotation and fade

A `Scene` has the field `rotate`. 129-15 made it false for a visit and true for
the always-on hours. `createScene` takes it as its fifth argument, and the
default is true.

If `rotate` is true, a scene shows one row for `SCENE_SECONDS`. Then it moves to
the next row of its key, and the last row is followed by the first. The walkers
start again at the edges. `sceneAlpha` fades a scene out in the last
`FADE_SECONDS` of its row, and it fades a rotated scene in during the first
`FADE_SECONDS`.

If `rotate` is false, `stepScene` never changes the row and `sceneAlpha` always
returns 1. `drawScene` sets `ctx.globalAlpha` to the value of `sceneAlpha` and
sets it back to 1 at the end.

The first scene of a visit has no fade in. So a frame at time zero is whole when
the system asks for reduced motion. The CSS fade of the canvas covers the start
of the visit.

#### The random start

In the always-on hours, `SeasonScene` passes a random index to `createScene`,
and the scene rotates through all the scenes of the key: five rows, or the
scripts of a `ScriptKey`.

For a visit, 129-15 replaced the random index with `nextRow` in `visits.ts`.
`nextRow(key, count)` returns a row index for the visit and records it in
localStorage under `chalk.season.last.v1`. The value is JSON of an object from
key to row index. The index is never the index of the last visit of the same
key. If the stored value is missing or not valid, any row can come. If
localStorage fails, a module variable holds the last rows, and the rule holds
for that page only.

The canvas has the attribute `data-scene`. Its value is the name of the row on
show. A later demo probe reads it.

#### Differences from the supplied engine

The scene differs from the supplied engine on purpose:

- It has no sky color, no haze, and no earth block. The canvas stays
  transparent, so the scene blends with all 15 themes. Each row names a sky
  (129-14): none, stars with a moon, a sun, or a low sun. The ten neutral
  scripts of 129-18 are the exception: each one paints its own opaque
  background.
- It draws the title (129-13) on a small sign and not on a panel for the whole
  strip. The title is always at single size. The supplied engine uses double
  size on a strip of 275 scene pixels or wider. Here the strip is 24 scene
  pixels high, and double size would make `HARVEST FESTIVAL` about 380 CSS
  pixels wide and nearly as high as the strip.
- The sign is high in the strip, in rows 0 to 10 (129-14). The ground is row
  23, and the head of a walker is at row 13. Two clear rows are between the
  head and the sign, so a walker runs under it. The hat of a witch rises four
  rows and reaches under the bottom edge of the sign, and a jump can pass
  behind the sign.
- The ground is the bottom line of the header: `ground = H - 1`. Scattered
  tufts of grass on the ground stay.
- It has no `window.ChalkSeasonHeader` preview API, because it would be a
  global in production.
- A scene fades to transparent and not to black.

129-14 added a sky and the details of each season to the scene:

- A `SceneRow` has a `sky`: `"none"`, `"stars"`, `"sun"`, or `"low-sun"`.
  `drawSky` draws stars and a moon (orange in Spooky Season), a sun, or a low
  sun with a line of glow for a sunrise or a sunset. Each row of a season
  names its sky.
- `CANOPY` gives each key a color for the background trees. The background
  trees of a Spring Bloom orchard are pink. `isLeafless` is true in Spooky
  Season and Late Autumn, and the background trees there are bare. `isSnowy`
  is true in Winterfest and New Year, and roofs and treetops carry snow. Since
  129-21 both keys run scripts, so no row reaches this test (see "The
  winterfest scripts").
- A lake is frozen in Winterfest: pale ice with still lines. Other water
  drifts. A low sun shows on water as orange lines. Since 129-21 no row has
  the key `winterfest`, so no lake is frozen.
- The props `bridge` (at the obstacle slot in Bridge Walk) and `lilypad` are
  new. 129-18 removed Bridge Walk, so no row uses `bridge` now. 129-20 left
  seven more props with no row: `barrel`, `boat`, `clock`, `flag`, `gift`,
  `lamp`, and `tower`. 129-21 left four more: `cabin`, `ice`, `snowball`, and
  `snowman`. 129-23 left one more: `house`. All 13 stay in the set of props. A cabin has a chimney with smoke. A campfire flickers and smokes, a
  windmill turns, a lantern and a pumpkin flicker, and the windows of the
  manor flicker. This closed the gap that Cabin Smoke had no smoke and Bridge
  Walk had no bridge.
- Some scenes changed to fit their season. Fern Garden has butterflies. Village Market and Lantern Path have
  leaves. Frozen Lake casts a rabbit, and Festival Lanterns casts a cat. Pond
  Hopping and Lakeside Sunset have a lilypad.

`web/src/season/scene.test.ts` uses a fake `Painter`. It checks the table (five
keys with five rows each, ten neutral scripts, seven Christmas scripts, seven
New Year scripts, eight Winterfest scripts, nine Black Week scripts, seven
Late Autumn scripts, 73 distinct names, and the same ids as `SEASONS` in
`SCENES`, except `christmas`, `new-year`, `winterfest`, `black-week`, and
`late-autumn`),
that every scene of a season draws whole pixels with no
rectangle as wide as the strip, that each prop paints something, the rotation
and its wrap, the fade, a start index outside the range, the walkers and the
jump, a ghost that does not jump, and that a resize and a very narrow strip do
not break a scene. The tests of 129-18 are in the slice record.

### Neutral dates (129-12)

A date in a gap shows the neutral scenes. 129-12 reverses the decision of
129-10, which showed no scene on such a date. The user asked for it, so that
chalk has a scene all year, apart from the switches.

129-12 made a neutral date a visit like any other, with the same caps and gaps.
129-16 replaced that rule (see "The windows of the neutral scene"). The
calendar dates and the gaps of 21 days did not change. `seasonFor` still
returns null on a neutral date, and `SEASONS` did not change.

`App.tsx` no longer needs a season for `seasonalOn`. The two mounts pass
`season` or null. `SeasonScene` takes `season: Season | null`. The key is
`season?.id ?? "neutral"` and the label for a screen reader is "Chalk".
`data-season` shows the key, also `neutral`. The night frame still needs a
season: `nightSeason` checks `season !== null`.

#### The windows of the neutral scene (129-16)

The neutral scene does not use the cap of 16 visits or the gaps of `GAP_MS`.
`NEUTRAL_WINDOWS` in `peek.ts` has two windows, as `[start, end)` in local
hours: `[8, 12]` and `[16, 24]`. The neutral scene has at most one visit in
each window, so at most two visits in a day.

`claimNeutral(log, now, rnd)` in `peek.ts` is a pure function.

- A log from another day, or with the wrong number of targets, is replaced. A
  clock moved back gives a new log in the same way.
- The new log has one random target time for each window. The target is no
  later than `SHOW_MS[1]` before the end of the window, so a visit of the
  longest time still ends inside the window.
- A visit starts at the first check with a visible tab, if now is inside a
  window, the visit of that window did not start, and now is at the target time
  or later.
- A window that no visible tab saw is lost. It does not move to the next window
  or to the next day.

The log is `{day, at, done}` in localStorage under the key
`chalk.season.neutral.v1`. `at` holds the target times in milliseconds since the
epoch, and `done` tells for each window if its visit started. A corrupt entry
is replaced. If localStorage fails, a module variable holds the log, and the
windows hold for that page only.

`takeVisit(now, neutral)` in `visits.ts` calls `claimNeutral` if `neutral` is
true. A neutral claim does not read or change the season log, so it does not
use up the cap of the season scenes. `SeasonScene` passes `neutral` when
`season` is null.

#### The off-season scripts (129-18)

A neutral date shows one of ten scripts, and not a row of walkers.
`web/src/season/offseason.ts` holds them in `OFFSEASON`. Each script is a nod to
a film or a series, and a person knows it by one famous moment. A script has no
title, no logo, and no likeness of an actor. The only text is the `CHALK` sign
and the six numbers that The Hatch types. A script uses a motif and does
not copy the design of a ship or a car.

| Script | Nod |
|---|---|
| Time Car | Back to the Future |
| Night Highway | Knight Rider |
| Code Rooftop | The Matrix |
| Starship | Star Trek |
| The Gate | Stargate SG-1 |
| Light Cycles | Tron |
| Twin Suns | Star Wars |
| The Hatch | Lost |
| Shadow over Town | Stranger Things |
| Flashlights in the Woods | The X-Files |

A `Script` has a `name`, a `period` (the length of its loop in seconds), a
`still` (the time of the frame for reduced motion), and
`draw(p, a, W, t)`. `draw` paints the frame at time `t` on a strip `W` scene
pixels wide, with the painter `p` and the alpha setter `a`. A script paints a
strip of `STRIP_H` scene pixels, which is 24. A script is opaque, because it
paints its own background. The rows of the seasons are see-through. This is a
deliberate change for the neutral key.

`scene.ts` runs a script as follows:

- `loadRow` loads a script for the `"neutral"` key. It gives the scene a
  placeholder row from `scriptRow`, and only the name of that row is read. The
  scene has no walkers and no obstacles.
- `drawScene` runs the script at the bottom of the canvas, with an offset of
  `H - STRIP_H`. It multiplies the alpha of the script with `sceneAlpha`.
- `stepScene` wraps the rotation at `sceneCount(key)`.
- `holdStill` moves the scene to the still time of its script.

The slice record has the tests.

#### The Christmas scripts (129-19)

The `"christmas"` key runs scripts, as `"neutral"` does. `scene.ts` has the
table `SCRIPTED`, from each `ScriptKey` to its scripts, and `loadRow` and
`createScene` read it. `web/src/season/christmas.ts` holds the seven scripts in
`CHRISTMAS`. The types and helpers that all scripts share moved to
`web/src/season/strip.ts`: `STRIP_H`, `Px`, `Alpha`, `Script`, `rnd`, `sign`,
`stars`, and `disc`. `offseason.ts` imports them from there.

Each Christmas script is a nod to a film or a series episode, and a person
knows it by one famous moment. The rules of the off-season scripts hold: no
title, no logo, no lettering, no likeness of an actor, and the `CHALK` sign as
the only text.

| Script | Nod |
|---|---|
| Party at the Tower | Die Hard |
| The House with the Traps | Home Alone |
| Gremlins in the Tree | Gremlins |
| Robot Santa | Futurama |
| The Light Show | Christmas Vacation |
| The Ornament | Star Trek: Voyager |
| The Ribbon at Christmas | Star Trek: Generations |

In The Ornament, a snap of light changes the colors of the baubles, and the
scene shows no face.

`PALETTES` and `CANOPY` have an entry for `christmas`, because their `Record`
type needs every `SceneKey`. A script never reads them, as for `"neutral"`.

#### The New Year scripts (129-20)

The `"new-year"` key runs scripts too. `web/src/season/newyear.ts` holds the
seven scripts in `NEWYEAR`, and `SCRIPTED` and `isScripted` in `scene.ts` list
the key. The key runs on 31 December and 1 January. In the always-on hours, from
20:00 on 31 December to 05:00 on 1 January, it rotates through all seven.

Six scripts are nods to a film, a series episode, or a game, and a person knows
each one by one famous moment. The seventh is a plain fireworks show with no
nod. The rules of the Christmas scripts hold: no title, no logo, no show
lettering, no likeness of an actor, and the `CHALK` sign as the only text. The
one exception is the years and the clock digits where they are the moment. Each
character is generic: a man in a red jacket, a man in a white shirt, a green
statue with a torch, and a figure in a blue jumpsuit. No script draws a mascot
or a character of a show.

| Script | Nod | Text on show |
|---|---|---|
| Year 3000 | Futurama | 1999 runs to 3000 |
| The Statue Walks | Ghostbusters II | none |
| Y2K | The Simpsons | 1999, 2000, and 1900 |
| The Gate at Midnight | Star Trek: Voyager | 23:59, 00:00, and a countdown digit |
| The Wrong Year | Seinfeld | 2000 and 2001 |
| Thumb against the Cloud | Fallout, a game | none |
| Fireworks over the River | none | none |

`PALETTES` and `CANOPY` keep an entry for `"new-year"` for the same reason as
for `"christmas"`. Eight props are in no row now: `barrel`, `boat`, `bridge`, `clock`, `flag`,
`gift`, `lamp`, and `tower`. The props stay in the vocabulary for later tuning, and the prop test still checks
that each one paints something.

#### The winterfest scripts (129-21)

The `"winterfest"` key runs scripts too. `web/src/season/winterfest.ts` holds
the eight scripts in `WINTERFEST`, and `SCRIPTED` and `isScripted` in
`scene.ts` list the key. The key runs from 2 January to 7 February. In the
always-on hours it rotates through all eight. The user chose the eight on an
animated mock-up page.

Each script is a nod to a film or a series, and a person knows it by one
famous moment in snow or ice. The rules of the earlier scripts hold: no title,
no logo, no show lettering, no likeness of an actor, and the `CHALK` sign as the
only text. Each character is generic: a big-eared figure, a smooth-faced
figure, two agents, and a four-legged walker.

| Script | Nod | What the strip shows |
|---|---|---|
| The Walker Falls | Star Wars: The Empire Strikes Back | A craft circles a four-legged walker, the craft wraps a tow cable around its legs, and it falls |
| The Gate under the Ice | Stargate SG-1 | A ring gate in the ice dials, opens in blue light, and shuts |
| The Ship in the Glacier | Star Trek: Voyager | A ship lies in a glacier, and two figures walk toward it with light beams |
| The Climb | Star Trek: Deep Space Nine | Two figures climb a snow slope, and one slips |
| The Dog in the Snow | The Thing | A dog runs to a base of three blocks, and a helicopter flies over |
| The Station in the Ice | The X-Files | Two agents walk to a station, and one lights it with a beam |
| The Maze | The Shining | A snow maze from above, with two figures and footprints, and a storm |
| The Prison Colony | Star Trek VI: The Undiscovered Country | Two figures on a snow field, and a beam takes them away |

The Maze is drawn from above. A maze does not read from the side at 24 px.

`PALETTES` and `CANOPY` keep an entry for `"winterfest"` for the same reason as
for `"christmas"` and `"new-year"`. Twelve props are in no row now: `barrel`,
`boat`, `bridge`, `cabin`, `clock`, `flag`, `gift`, `ice`, `lamp`, `snowball`,
`snowman`, and `tower`. They stay in the vocabulary, and the prop test still
checks that each one paints something.

Open cleanup: the engine in `scene.ts` still has the branches for snow on
roofs, treetops, and pines (`isSnowy`), the frozen lake, snow tufts on the
ground, and the smoke of a cabin chimney. They key on `winterfest` and
`new-year`, and no row reaches them now. The same holds for the `late-autumn`
entries of `PALETTES` and `CANOPY` and the `late-autumn` case of `isLeafless`
(129-23). They stay on purpose for the tuning
slices of 129-24 and later. After the last of those slices, remove each branch
that no row uses, or give it a row. The comments on the branches say that no
row reaches them.

#### The Black Week scripts (129-22)

The `"black-week"` key runs scripts too. `web/src/season/blackweek.ts` holds the
nine scripts in `BLACKWEEK`, and `SCRIPTED` and `isScripted` in `scene.ts` list
the key. The key runs from the Monday before Black Friday to Cyber Monday (see
"Black Week moves with the year"). The user chose the name Black Week and the
nine scenes.

Each script is a nod to a film, a series, or a game, and a person knows it by
one famous moment about money or a sale. Eight scripts nod to a film or a
series, and one nods to a game. No script shows a title, a logo, or a likeness
of an actor. Each character is generic: a big-eared figure, a duck in a top
hat, a small wise figure with a cane, and a flying blue shopkeeper.

The rule about text is different here. The earlier keys allow the `CHALK` sign
and little else. Black Week allows short sign words and prices, because the
text is the joke. The user approved this exception. The scripts have their own
font, `FONT` in `blackweek.ts`: capital letters, digits, and the signs `%`,
`-`, and `+`, each glyph three pixels wide and five high.

| Script | Nod | What the strip shows | Text on show |
|---|---|---|---|
| The Bar | Star Trek: Deep Space Nine | Latinum bars pile up on a counter, a big-eared figure stands by a spinning wheel, a banner unfolds, and two figures cross the floor | DISCOUNT 0%, DISCOUNT 50%, PROFIT 200%, BLACK FRIDAY |
| The Latinum Mountain | Star Trek: Deep Space Nine | A pile of latinum bars grows, and then it collapses | none |
| The Doors Open | South Park | A crowd waits at a shop with a sale plate, the doors open, and the crowd runs in | SALE |
| The Money Bin | DuckTales | A duck in a top hat jumps into a pile of gold coins and swims in it | none |
| Merchandising | Spaceballs | A small wise figure with a cane stands while goods pile up beside it | MERCH, and MERCH with a percent that rises |
| Through the Glasses | They Live | Three boards show sale words, a figure puts on glasses, the strip turns gray, and the boards show orders | SALE, NEW, 50%, OBEY, BUY, CONSUME |
| The Junk Shop | Star Wars: The Phantom Menace | A flying blue shopkeeper hovers by a junk pile, and a price plate rises | 20, 40, 80 |
| The Machine's Markup | Borderlands, a game | A vending machine shows a discount that turns into a markup, and a figure raises its arms | -50%, +50%, +300%, +900% |
| The Sign Goes Wrong | Star Trek: Deep Space Nine | A sign changes from 50% OFF to 500% OFF, a crowd rushes in, and the latinum bars vanish | 50% OFF, 50 % OFF, 500% OFF |

The user wanted a banner that comes every few minutes. In The Bar, the banner
BLACK FRIDAY unfolds inside the loop of 20 s. It covers the PROFIT 200% plate
for a short time. No timer outside the scene drives it.

`PALETTES` and `CANOPY` keep an entry for `"black-week"` for the same reason as
for `"christmas"`. A script never reads them.

##### The weight rule

A `Script` has the optional field `weight`. If it is absent, the weight is 1.
`sceneWeights(key)` returns the weights of the scenes of `key`. A key that runs
rows gives 1 for each row. `nextRow(key, weights)` in `visits.ts` takes a count
or an array of weights. A count gives each row the weight 1. The chance of a row
is its weight divided by the sum of the weights. A weight that is not a finite
number above 0 counts as 0. `nextRow` still never picks the scene of the last
visit of the same key, unless every other row has the weight 0.

Only The Bar has a weight above 1. Its weight is 2, so a visit shows it twice
as often as each other scene that the last-visit rule allows. `SeasonScene.tsx`
passes `sceneWeights(key)` to `nextRow`. The always-on hours ignore weights,
and black week has no always-on hours.

#### The late-autumn scripts (129-23)

The `"late-autumn"` key runs scripts too. `web/src/season/lateautumn.ts` holds
the seven scripts in `LATEAUTUMN`, and `SCRIPTED` and `isScripted` in `scene.ts`
list the key. The key runs from 16 to 22 November. The user chose the seven on
an animated mock-up page.

Each script is a nod to a film, a series, or a game, and a person knows it by
one moment in autumn. Five scripts nod to a film or a series, and two nod to a
game. The rules of the earlier scripts hold: no title, no logo, no lettering,
no likeness of an actor, and the `CHALK` sign as the only text. Each character
is generic.

| Script | Nod | What the strip shows | Loop |
|---|---|---|---|
| The Thing in the Fog | The X-Files | Three layers of fog drift over autumn trees. Two agents aim light beams at a dark monster that comes into view, steps closer, and fades out | 16 s |
| The Duel in the Garden | Kill Bill Vol. 1 | A fighter in yellow and a fighter in white cross swords by a red maple. The strip flashes white, and the red leaves scatter | 14 s |
| Coffee and the Owl | Twin Peaks | A figure in a dark suit raises a cup in a pine forest, and an owl blinks and glows | 16 s |
| The Vineyard | Star Trek: The Next Generation | A bald man in a red and black uniform top picks grapes by a stone château. His badge chirps, a column of light takes him away, and a starship glides past | 24 s |
| Leaf Chase | Animal Crossing, a game | A villager with a net runs after a falling leaf and catches it | 12 s |
| The Raid | Fantastic Mr. Fox | A fox with a bundle runs past farm buildings and lamp beams, and jumps into a hole | 16 s |
| The Harvest Helpers | Stardew Valley, a game | Rows of crops vanish one by one, and five small helpers hop to a crate with a crop each | 24 s |

The user asked for the monster of The Thing in the Fog, and for the maple to
stand to the left of the sign. The user reworked The Vineyard: a stone château,
vine rows with grapes that sway, a bald man with a combadge, a chirp, a beam
that leaves the basket behind, and a starship. The loops of The Vineyard and
The Harvest Helpers are slow, 24 s each, at the request of the user.

`PALETTES` and `CANOPY` keep an entry for `"late-autumn"` for the same reason
as for `"christmas"`. A script never reads them.

### The component

`web/src/components/SeasonScene.tsx` replaces `SeasonFigure.tsx`.
It keeps the one-timer schedule and the visible-page rule of 129-7: a
`setTimeout` for each step, and `takeVisit` only for a visible page.
One component serves every season.

`runScene` starts a visit. It sets the size of the canvas from its CSS size
divided by `SCALE`, makes a new scene, and paints it once. The scene starts at
the row of `nextRow`, or at a random row in the always-on hours (see "The random
start"). Each visit makes a new scene, so no state passes from one visit to the
next.
Unless the system asks for reduced motion, it then starts a
`requestAnimationFrame` loop. The loop steps and paints the scene at `FPS`.
A `ResizeObserver` resizes the scene when the canvas changes size.

The loop runs only while the canvas is up: during a visit, and in the always-on
hours. When the visit ends, it stops `FADE_MS`
later, and `FADE_MS` is 1200. This is the time of the CSS fade-out. If the loop
stopped first, the scene would freeze in the picture while it fades.

With `prefers-reduced-motion: reduce`, a visit paints one frame and holds it,
and the CSS fade is off. A script holds its still frame: `runScene` calls
`holdStill` before the one paint (129-18). So the promise in the profile panel, that the scene
holds still, stays true.

The canvas has `role="img"` and the aria-label "<label>, an animated pixel
scene". It has `aria-hidden` while it is hidden. It sets `data-season` to the
scene key (a season id, or `neutral`) and `data-visible` while the canvas is up, in a visit or in the
always-on hours.

### The mount

`App.tsx` mounts `SeasonScene` in the header, between `.chalk-header-left` and
`StatusBar`. Two gates and one width rule decide if it mounts:

- The device switch is on.
- The server switch is on.
- The window is wider than 767 px (`!isMobile`).

Before 129-12 a third gate, the calendar, also decided. It is gone, because a
neutral date shows the neutral scenes.

It does not depend on the active channel, on a parked channel, or on the
phone's list screen.

`.chalk-season` is the strip. It has `flex: 1 1 0`, `min-width: 0`,
`align-self: stretch`, and `position: relative`. It takes the empty middle of
the header, and it cannot widen the header. It has `pointer-events: none`.
`.chalk-season-canvas` is out of flow: `position: absolute`, 100 percent wide,
and 48 px high. It sits on the bottom line of the header. The header has
padding of `--chalk-s3` below its content, so `bottom` is
`calc(-1 * var(--chalk-s3))`. The scene draws its ground on the last row of the
canvas, and the walkers stand on the line. `image-rendering: pixelated` keeps
the pixels sharp. A `mask-image` fades both ends, so the scene has no hard edge
against the brand and the status bar. The canvas has opacity 0.9 while a visit
shows.

The header has the same height with and without the scene. A check in a
browser found no change.

At 390 px only about 30 px of the middle remains, so the scene would be a
sliver. So the header of a phone shows no scene. The old figure did show on a
phone. This is a recorded trade-off. 129-9 and 129-10 recorded that a phone
shows no scene at all. 129-11 changed this for zuckermode, as the next
subsection says.

### The row above the zuckermode list (129-11)

On a phone in zuckermode, the list screen shows the scene in a row at the top
of the list. The user asked for a row that goes away when it is off.

`App.tsx` passes `scene` to `ZuckerList`. The value is
`<SeasonScene season always row />`, or `null` if the device switch or the
server switch says no. `ZuckerList` stays presentational. It
renders `scene` as the first child of `.chalk-zucker`, above
`.chalk-zucker-head`. A switch that is off mounts no row.
The row is a child of the list screen only, so it does not show on the chat
screen. The classic phone layout (the drawer) still shows no scene.

`SeasonScene` has a `row` prop. With it, the root gets `chalk-season--row`.
While the scene shows, the root also gets `chalk-season--live`.

- `.chalk-season--row` is a flex child (`flex: 0 0 auto`) with `height: 0` and
  `overflow: hidden`. Between visits the row takes no space. A height
  transition of 1200 ms opens and closes it.
- `.chalk-season--row.chalk-season--live` is 48 px high and has a bottom
  border. `box-sizing` makes 48 px the total height.
- The canvas sits at `bottom: 0` in the row.
- With reduced motion the height transition is off too, so the row jumps.

`ZuckerList` unmounts when a conversation opens. `SeasonScene` then mounts
again when the user comes back to the list, and it starts with a first pause of
4 s to 12 s. The log of visits is in localStorage, so the caps hold across that
restart. In the always-on hours the row stays open and claims no visit.

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
The night uses the same switches as the rest of the phase, and the Spooky
Season row. It does not depend on the width rule, so a phone shows the frame on video tiles.

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

### Two gates

The scene shows only if both hold. It shows in the header on a screen
wider than a phone, and in the row above the list on a phone in zuckermode:

- The device switch is on.
- The server switch is on.

The calendar is not a gate since 129-12. It picks the scenes: those of the
season, or the neutral ones. The night frame on video tiles still needs a
season, and it uses the same two switches.

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

`web/src/whats-new.ts` has an entry for phase 129. 129-9, 129-10, 129-12,
129-18, and 129-19 rewrote its lines in place, because the entry is keyed by the phase number. A person who already
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
blend with all 15 themes. 129-13 reversed the title part of this decision at
the request of the user: the scene shows the title on a small sign. The solid
panel for the whole strip stays rejected.

A phone layout with the scene on a second header row (129-9). It changes the
height of the header. This still holds for the header. 129-11 put the scene
in the list screen instead.

A preview API on `window` (129-12). The supplied engine has one,
`window.ChalkSeasonHeader`. In production it would be a global. The contact
sheet of the verification renders the real `scene.ts` instead.

A start at the first scene in each visit (129-12). A visit lasts 45 s to 75 s
and a scene lasts 35 s, so scenes 3 to 5 would almost never show. `createScene`
takes an index, and 129-12 passed a random one. 129-15 replaced the rotation in
a visit with one held scene.

A scrolling world that runs through the rows with no cut (129-15). It would let
one visit show more than one scene. It is a larger change of the engine, so
the slice held one scene instead.

A crossfade through all five rows in a longer visit (129-15). A visit of 45 s to
75 s is short on purpose, and a longer visit would stay on the screen longer.

A gap-based schedule with a lower cap for the neutral scene (129-16). It cannot
guarantee one visit in each part of the day, so a day could have no morning
visit. The windows give that guarantee for a tab that is visible.

A fade to black at the end of a scene, as the supplied engine does (129-12).
The canvas is transparent, so the alpha fades to transparent.

Walker rows with film-themed props for the neutral scenes (129-18). A moment
of a film does not fit in a strip 24 scene pixels high with two walkers and
four props.

The titles of the films on the neutral scenes (129-18). The user wants each
scene to speak for itself. The only text is the sign.

Logos, and exact designs of a ship or a car (129-18). They carry a risk for a
trademark. A scene uses a motif.

The Christmas scenes on the whole `winterfest` key (129-19). That key also runs
from 2 January to 7 February, and a Christmas scene is wrong in those weeks. The
Christmas scenes have a key of their own, `christmas`, that runs in December.

Lettering, logos, and faces from the reference mock-ups of the Christmas scenes
(129-19). The mock-ups had a lettered van, a company logo on a tower, and the
face of a character. The scenes leave them out, by the same rules as 129-18.

Fixed dates of 23 to 30 November for Black Week (129-22). Black Friday moves
from 23 to 29 November, so fixed dates match the week only in the years in
which Black Friday falls on 27 November. The season has a `moving` window that
`blackWeek(year)` computes.

Removing Late Autumn (129-22). Black Week takes the days of its old dates, 27 to
30 November. The user kept the key and moved its dates to 16 to 22 November.

A banner on a separate timer outside the scene (129-22). The user wanted a
banner that comes every few minutes. The banner unfolds inside the loop of
The Bar instead.

The five walker rows for Late Autumn (129-23). Windy Avenue, Rainy Village,
Forest Floor, Creek Crossing, and Lantern Path had no famous moment. The user
chose scripted nods from an animated mock-up page, as for Winterfest. The slice
removes the rows.

A craft in The Thing in the Fog (129-23). The first version of the scene showed
a craft in the fog. The user wanted a monster, and the scene shows one.

The maple under the sign in The Duel in the Garden (129-23). The user wanted
the maple to the left of the sign, and the scene draws it there.

The five walker rows for Winterfest (129-21). Snowy Pines, Cabin Smoke, Frozen
Lake, Aurora Ridge, and Lantern Walk had no famous moment. The user chose
scripted nods from an animated mock-up page, as for New Year. The slice removes
the rows.

The maze of The Maze in side view (129-21). At 24 px high a hedge is a few
rows, and a side view shows no maze. The script draws the maze from above.

A likeness of a character in the Winterfest scenes (129-21). The rules of
129-18 to 129-20 hold. The scenes use a big-eared figure, a smooth-faced
figure, two agents, and a four-legged walker, and they carry no title, logo, or
lettering.

The five walker rows for New Year (129-20). Midnight Skyline, Rooftop
Countdown, Harbor Lights, Town Celebration, and First Sunrise had no famous
moment. The user chose scripted nods, as for Christmas, from an animated
mock-up page. The slice removes the rows.

Titles and show lettering on the New Year scenes (129-20). The user wants each
scene to speak for itself, as in 129-18. The years and clock digits are the
only added text, because they are the moment.

A likeness of a mascot or of a character (129-20). The rules of 129-18 and
129-19 hold. The scenes use a generic figure: a man in a red jacket, a man in a
white shirt, and a figure in a blue jumpsuit.

An earlier set of candidates for the neutral scenes (129-18). The review
replaced the candidates Jaws, E.T., and an alphabet wall with Lost, Stargate,
and the shadow-monster scene of Stranger Things.

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

- **129-11 — the row above the zuckermode list.** The `scene` prop of
  `ZuckerList.tsx`, and the `scene` value in `App.tsx`. The `row` prop and the
  classes `chalk-season--row` and `chalk-season--live` in `SeasonScene.tsx`.
  The row rules and the reduced-motion rule in `theme.css`. Text in
  `ProfilePanel.tsx`, `AdminSettingsTab.tsx`, and `whats-new.ts`.

- **129-12 — 45 scenes and the neutral dates.** `season/scene.ts` is the port
  of the second engine: `SCENES`, `PALETTES`, `sceneAlpha`, the rotation, and
  the `index` of `createScene`. `Painter` gained `globalAlpha`. `scene.test.ts`
  covers the new engine. `SeasonScene.tsx` takes `season: Season | null` and
  starts at a random scene. `seasonalOn` in `App.tsx` no longer needs a season,
  and the two mounts pass `season` or null. Text in `whats-new.ts` and
  `CHANGELOG.md`.

- **129-13 — the title.** `PALETTES` in `season/scene.ts` gained `title`,
  `ink`, and `panel` for each key. The title is the name of the season, and
  `CHALK` on the neutral dates. `FONT` is a 5 by 7 pixel font. `drawTitle`
  draws a centred sign: a panel with an edge line at the top and at the
  bottom, and the letters at single size (129-14 changed the geometry). `drawScene` calls it
  last, so the walkers pass behind the sign, and the title fades with its
  scene. If the sign does not fit in the width of the strip, `drawTitle`
  leaves it out. `titleFor` and `hasGlyph` are exports for the tests. One
  scene pixel is 2 CSS pixels, so a letter is 10 by 14 CSS pixels. Text in
  `CHANGELOG.md`.

- **129-14 — the sign higher, and the details of the seasons.** The user asked
  for a higher sign, so that the creatures can run under it, and for scenes
  that are more authentic for each season. `drawTitle` draws at y = 2 with a
  panel 11 scene pixels high from row 0, and edge lines at rows 0 and 10. The
  canvas grew from 44 px to 48 px, in the header and in the zuckermode row, so
  `H` is 24 scene pixels and the ground is row 23. The header height does not
  change. In the title-bar header the canvas takes the height of the header, so
  the strip there can be smaller. `SceneRow` gained `sky`, and `drawSky` draws
  it. `CANOPY`, `isLeafless`, and `isSnowy` set the background trees and the
  snow. The lake is frozen in Winterfest. The props `bridge` and `lilypad` are
  new, and the cabin, campfire, windmill, lantern, pumpkin, and manor windows
  got smoke or flicker. Five scenes changed their effect or cast. The gap of
  Cabin Smoke and Bridge Walk is closed. `scene.test.ts` covers a walker under
  the sign, snow and ice, the named details, and the cast by season. Text in
  `CHANGELOG.md`.

- **129-15 — a visit holds one scene.** The problem: `stepScene` rotated to the
  next row every `SCENE_SECONDS`, with a fade out and a fade in. A visit of
  45 s to 75 s showed two or three scenes. The design: `Scene` has `rotate`, and it is false for a visit.
  `stepScene` does not rotate it and `sceneAlpha` returns 1. The always-on
  hours still rotate. `nextRow` in `season/visits.ts` picks the row of a visit,
  never the row of the last visit of the same key, and records it in
  `chalk.season.last.v1`. The canvas has `data-scene`. Rejected: a scrolling
  world across the rows, and a crossfade through all five rows in a longer
  visit (see "What was rejected"). Tests in `scene.test.ts` and
  `visits.test.ts`. Text in `CHANGELOG.md` and `whats-new.ts`.

- **129-16 — the windows of the neutral scene.** The problem: the neutral scene
  shared the log and the cap of the season scenes. A schedule of gaps cannot
  guarantee one visit in each part of the day. The design: `NEUTRAL_WINDOWS`, `claimNeutral`, `NeutralLog`, and
  a log under `chalk.season.neutral.v1`. `takeVisit(now, neutral)` sends a
  neutral claim to that log. Season scenes keep the cap of 16 and 10. Rejected:
  a gap-based schedule with a lower cap (see "What was rejected"). Tests in
  `peek.test.ts` and `visits.test.ts`. Text in `CHANGELOG.md` and
  `whats-new.ts`.

- **129-17 — a headed season demo (built).** The problem: a scene shows only
  on a date of its season and after a pause, and a visit picks its row by its
  own rule. A person who tunes a scene cannot wait for that. The design: the
  flags `--season=<key>`, `--scene=<row name>`, and `--scene-secs=N` (default
  30) in `.claude/skills/run-chalk/ui-sweep.mjs`, with `--headed`. The script
  has the table `SEASON_DATES`. Neutral is 10 November 2026 at 09:00, in the
  first neutral window. The other keys are at 13:00 on a date inside the
  season, near the real date. Playwright `page.clock.install` sets the date,
  and the clock runs at normal speed. An init script removes
  `chalk.season.visits.v1` and seeds `chalk.season.neutral.v1`, so a visit is
  due at once. After each page load, `clock.fastForward(13000)` skips
  `FIRST_PAUSE_MS` (4 s to 12 s). The script waits for
  `[data-testid='season-scene'][data-visible]` and reads `data-scene`. It
  loads the page again, up to 25 times, until `data-scene` is the target. It
  then shows the scene for `--scene-secs` seconds with a corner tag. Without
  `--scene`, the targets are the five row names of the key, read from
  `web/src/season/scene.ts`. 129-18 changed this for neutral: the ten script
  names come from `web/src/season/offseason.ts`. The script prints `SCENE <key>: <name>`, with
  `(wanted X)` if it gave up, and logs each try to `probe.log`. An unknown key
  or scene stops it with exit 2. Rejected: a forced index, which needs a
  preview hook in the product, and a `Math.random` stub in the probe, which
  changes the whole app. The demo has no preview API, so it matches the scene
  by reload. A visit lasts 45 s to 75 s, so a `--scene-secs` value above 45 can
  let the visit end before the next load. The `ui-sweep` skill lists the flags.

- **129-18 — ten scripted neutral scenes (built).** The problem: the five
  neutral rows (Green Alley, Quiet Forest, Little Workshop, Bridge Walk, and
  Morning Hills) were walkers on a strip 24 scene pixels high. They could not
  show a moment of a film. The design: `web/src/season/offseason.ts` has
  `STRIP_H`, `Script`, and `OFFSEASON` with ten scripts (see "The off-season
  scripts"). `SCENES` is now `Record<SeasonId, SceneRow[]>`. `scene.ts` gained
  `sceneCount`, `Scene.script`, `scriptRow`, and `holdStill`, and `loadRow`,
  `createScene`, `stepScene`, and `drawScene` handle a script. `SeasonScene.tsx`
  calls `sceneCount` and calls `holdStill` before the one paint under reduced
  motion. In `ui-sweep.mjs`, `sceneNames` reads the neutral names from
  `offseason.ts`. The user approved the design on an animated mock-up page.
  Rejected: walker rows with film props, the film titles, and logos or exact
  designs (see "What was rejected"). Tests in `scene.test.ts`: the table has 50
  scenes. Each script draws whole pixels, inside a budget of rectangles, at
  three widths over its loop. A script holds through a visit. A rotating
  neutral scene moves on to the next script. The fade of a rotating scene caps
  the alpha of a script. A script draws at the bottom of a taller canvas. The
  still time of each script is inside its loop. The prop `bridge` is no longer
  used by a row, so the prop test adds it by hand. Text in `CHANGELOG.md` and
  `whats-new.ts`.

- **129-19 — Christmas scenes and a new calendar (built).** The problem: the
  user wanted Christmas scenes in December. The `winterfest` key also runs in
  January and February, so a Christmas scene on that whole key is wrong in those
  weeks. The design: a new key, `christmas`. `SeasonId` has `"christmas"`, and
  `SEASONS` has the new rows (see "The calendar decides which season it is").
  The user chose the calendar. Christmas runs from 1 to 26 December. The gap
  from 27 to 30 December is neutral. New Year runs on 31 December and 1 January.
  Winterfest runs from 2 January to 7 February. The always-on hours of
  24 December, and of 31 December, did not change. They now fall in the
  `christmas` key and the `new-year` key. `christmas.ts` has the seven scripts
  (see "The Christmas scripts"). `strip.ts` has the parts that all scripts
  share, moved out of `offseason.ts`. `scene.ts` has `SCRIPTED`, `ScriptKey`,
  `RowKey`, and `isScripted`, and `sceneCount`, `loadRow`, and `createScene`
  use them. `SCENES` is `Record<RowKey, SceneRow[]>`. In `ui-sweep.mjs`,
  `SEASON_DATES` has `christmas` at 10 December 2026 at 13:00, `winterfest` moves
  to 15 January 2027, and `new-year` moves to 31 December 2026 at 13:00.
  `sceneNames` also reads `christmas.ts`. The user approved the scenes on an
  animated mock-up page first. Rejected: Christmas scenes on the whole
  `winterfest` key, and lettering, logos, and faces from the reference mock-ups
  (see "What was rejected"). Tests in `seasons.test.ts`: the gaps last 21 days,
  except the gap from 27 to 30 December, which lasts four. There are nine
  season ids. Each season starts and ends on its new dates. `christmas` has no
  night frame. Christmas Eve is in the `christmas` key, and New Year's Eve is in
  the `new-year` key. Tests in `scene.test.ts`: the table has 57 scenes, the
  script tests run over both sets of scripts, and a `christmas` scene runs its
  scripts and holds one through a visit. Text in `CHANGELOG.md` and
  `whats-new.ts`.

- **129-20 — New Year scripts (built).** The problem: the `new-year` key showed
  five walker rows with no famous moment. The user wanted nods, as for
  Christmas. The design: `newyear.ts` has the seven scripts in `NEWYEAR` (see
  "The New Year scripts"), and the user chose them on an animated mock-up page.
  The slice removes the five rows. `SCRIPTED` has `"new-year"`, `isScripted` lists it,
  and `SCENES` has seven keys. There are 59 scenes. Eight props, `barrel`,
  `boat`, `bridge`, `clock`, `flag`, `gift`, `lamp`, and `tower`, are in no row.
  They stay in the vocabulary. The always-on hours of 31 December rotate through
  the seven scripts. In `ui-sweep.mjs`, `sceneNames` also reads `newyear.ts`.
  Rejected: the walker rows for New Year, titles and show lettering, and a
  likeness of a mascot or a character (see "What was rejected"). Tests in
  `scene.test.ts`: the table has 59 scenes, the script tests run over all three
  sets of scripts, and a `new-year` scene runs its scripts and holds one through
  a visit. The prop test checks the eight props that no row uses. The First
  Sunrise check and the cast check of `new-year` are gone, because the rows are
  gone. The budget test found a negative stem height in Thumb against the
  Cloud, and a clamp fixed it. Text in `CHANGELOG.md` and `whats-new.ts`.

- **129-21 — Winterfest scripts (built).** The problem: the `winterfest` key
  showed five walker rows with no famous moment. The user wanted nods, as for
  New Year. The design: `winterfest.ts` has the eight scripts in `WINTERFEST`
  (see "The winterfest scripts"), and the user chose them on an animated
  mock-up page. The slice removes the five rows. `SCRIPTED` has `"winterfest"`,
  `isScripted` lists it, and `SCENES` has six keys. There are 62 scenes. Twelve
  props are in no row. They stay in the vocabulary. The snow, frozen-lake, and
  smoke branches of the engine stay too, with no row to reach them (open
  cleanup, see "The winterfest scripts"). In `ui-sweep.mjs`, `sceneNames` also
  reads `winterfest.ts`. Rejected: the walker rows, the maze in side view, and
  a likeness of a character (see "What was rejected"). Tests in
  `scene.test.ts`: the table has 62 scenes, the script tests run over all four
  sets of scripts, and a `winterfest` scene runs its scripts and holds one
  through a visit. The prop test checks the 12 props that no row uses. The ice,
  roof snow, smoke, and winterfest cast checks are gone, because the rows are
  gone. Text in `CHANGELOG.md` and `whats-new.ts`.

- **129-22 — Black Week (built).** The problem: the user wanted a season for
  Black Week, with scenes about money and sales. The design: `black-week` is a
  new key with nine scripts in `BLACKWEEK` in `blackweek.ts` (see "The Black
  Week scripts"). The season is the first with `moving(year)`, and
  `blackWeek(year)` computes the window (see "Black Week moves with the
  year"). `seasonFor` tests moving seasons first. Late Autumn moved from 27 to
  30 November to 16 to 22 November, and the gap after Spooky Season is now 6 to
  15 November. `Script` has the optional `weight`. `sceneWeights(key)` returns
  the weights, and `nextRow(key, weights)` picks by weight. The Bar has the
  weight 2. `SCRIPTED` has `"black-week"`, `isScripted` is `key in SCRIPTED`,
  and `SCENES` still has six keys. There are 71 scenes. The scripts show sign
  words and prices, which the earlier keys do not. In `ui-sweep.mjs`,
  `SEASON_DATES` has `black-week` (25 November 2026) and moves `late-autumn` to
  18 November, and `sceneNames` also reads `blackweek.ts`. Rejected: fixed dates
  for the week, removing Late Autumn, and a banner on a separate timer (see
  "What was rejected"). Tests: `seasons.test.ts` checks the gap list, 11 rows,
  the `black-week` id, `blackWeek` for 2024 to 2040, and the precedence of black
  week over late-autumn and christmas. The row of late-autumn is checked to
  21 November, because the date table uses 2027, where 22 November is black
  week. `scene.test.ts` checks 71 scenes, the script tests over five sets of
  scripts, and the weights. `visits.test.ts` checks a weighted `nextRow`. Text
  in `CHANGELOG.md` and `whats-new.ts`.

- **129-23 — Late Autumn scripts (built).** The problem: the `late-autumn` key
  showed five walker rows with no famous moment: Windy Avenue, Rainy Village,
  Forest Floor, Creek Crossing, and Lantern Path. The user wanted nods, as for
  the other keys. The design: `lateautumn.ts` has the seven scripts in
  `LATEAUTUMN` (see "The late-autumn scripts"). The user chose them on an
  animated mock-up page and refined four of them there. The Thing in the Fog
  shows a monster, not a craft. The maple of The Duel in the Garden stands to
  the left of the sign. The user reworked The Vineyard and slowed The
  Harvest Helpers to a loop of 24 s. The slice removes the five rows. `SCRIPTED` has
  `"late-autumn"`, `isScripted` lists it, and `SCENES` has five keys. There are
  73 scenes. Thirteen props are in no row: `house` joins the earlier twelve.
  They stay in the vocabulary. In `ui-sweep.mjs`, `sceneNames` also reads
  `lateautumn.ts`. Rejected: the walker rows, the craft version of The Thing in
  the Fog, and the maple under the sign (see "What was rejected"). Tests in
  `scene.test.ts`: the table has 73 scenes and five row keys, the script tests
  run over six sets of scripts, and a `late-autumn` scene runs its scripts and
  holds one through a visit. The prop test checks the 13 props that no row
  uses. The blossom check uses `harvest-festival`, because `late-autumn` has no
  row. Text in `CHANGELOG.md` and `whats-new.ts`.

- **129-24 and later — tune the scenes (planned, not started).** One key for
  each slice, in this order: spring-bloom, green-season, midsummer,
  harvest-festival, spooky-season. These are the five keys that have rows.

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
6. The header of a window of 767 px or less shows no scene. The old figure
   did show on a phone. The scene does not fit: at 390 px only about 30 px of
   the middle remains. 129-11 changed this for zuckermode: the list screen
   shows the scene in a row (see trade-offs 13 and 14). The classic phone layout
   shows no scene.
7. The calendar is for the Northern Hemisphere. A reader in the Southern
   Hemisphere sees the same season on the same date.
8. The loop of the scene runs at 12 fps during a visit and for 1.2 s after it.
   This costs CPU for about a minute each visit, and nothing between visits.
9. 129-9, 129-10, and 129-12 rewrote the what's-new entry of phase 129 in place. A person
   who already marked it as read does not see the new text.
10. In the always-on hours the 12 fps loop runs for nine hours while the tab is
    visible. `requestAnimationFrame` pauses in a hidden tab. This costs CPU
    for nine hours on two evenings of the year.
11. The always-on hours follow the Northern Hemisphere calendar, like the rows. A reader in the Southern Hemisphere sees the scene in summer on those
    evenings.
12. The header of a phone width shows no scene in the always-on hours either.
    In zuckermode the row stays open in those hours.
13. Only the list screen of zuckermode claims a visit. A user who stays in a
    conversation gets fewer visits. A visit that the user leaves by opening a
    conversation still counts.
14. When the row opens or closes, the rows below it move by 48 px over 1.2 s.
    A tap in that moment can land on a different row. This is the accepted cost
    of a row that goes away.
15. A visit shows one scene of the five, of the seven for christmas and
    new-year, and late-autumn, of the eight for winterfest, of the nine for
    black-week, or of the ten for neutral (129-15, 129-19, 129-20, 129-21,
    129-22, 129-23). The row
    differs from the row
    of the last visit of the same key, so each scene shows over many visits.
    Only the always-on hours walk all five in one run.
16. The sign of the title covers the middle of the strip, about 105 scene
    pixels at most for `HARVEST FESTIVAL`. The sign is high (129-14), so the
    walkers run under it. Only a jump of a walker can pass behind it. A strip
    that is too narrow for the sign shows no title.
17. A window of the neutral scene is lost if no visible tab checks at or after
    its target time inside the window (129-16). A device that is always in the
    background sees no neutral visit. The neutral log is for a device and a
    local day, like the cap.
18. A neutral script is opaque (129-18). It paints its own background, so it
    does not blend with a theme as the see-through rows do. This is a deliberate
    change. The scripts of `christmas`, `new-year`, `winterfest`, and `black-week`
    are opaque too.

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

A second probe ran on 2026-11-02. It checked a neutral date (then without a
scene), a season date,
the four sides of the always-on hours, and a date just before them. It passed.

A third Playwright probe ran on 2026-11-02 on an iPhone 14 viewport. It checked
the cases of items 29 to 33 of the checklist below. The cases are a row that
is closed before a visit, opens, and collapses after it, a conversation that
opens and a return to the list, zuckermode off, a neutral date, and 21:00 on
24 December. It passed.

For 129-12, a contact sheet of all 45 scenes was rendered from the real
`scene.ts` on a dark background and on a light background on 2026-11-02. A
Playwright probe ran on the same date against neutral dates, 29 February, the
Halloween night frame, a rotation in the always-on hours, and the first frame
under reduced motion. It passed.

For 129-13, the showcase in the real header on 2026-11-02 showed the title.
For 129-14, contact sheets of all 45 scenes on dark and light backgrounds on 2026-11-02 showed the sign and the seasonal details.

### Manual checklist for the live stack

Use two users, Alice and Bob, and a date inside a season. A date in a gap has
no season and shows the neutral scenes (see item 13).

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
7. Check the classic phone layout (400 px wide, zuckermode off). Check that no
   scene shows, that the header looks as before, and that there is no sideways
   overflow. Check that the count in `chalk.season.visits.v1` does not change.
8. As an administrator, open the settings tab in the admin panel and turn the
   switch off. Check that the scene on the screen of the administrator goes
   away at once.
9. Check that Bob loses the scene on his next page load, one minute at most
   after the save.
10. Check that a signed-out client of an instance with the switch off never
    shows the scene.
11. Close and open the settings tab. Check that it shows the saved value.
12. Set the system date to each date in the list below. Check that
    `data-season` on the canvas is the key of the season, and that the scene is
    one of the five scenes of the key (see the table in "The scene"):
    - 1 January and 31 December: `new-year`, one of the seven New Year scenes
      (129-20)
    - 15 January: `winterfest`, one of the eight Winterfest scenes (129-21)
    - 10 April: `spring-bloom`
    - 10 May: `green-season`
    - 15 July: `midsummer`
    - 20 September: `harvest-festival`
    - 28 October: `spooky-season`
    - 18 November: `late-autumn`, one of the seven Late Autumn scenes (129-23)
    - 25 November: `black-week`, one of the nine Black Week scenes (129-22)
    - 10 December and 26 December: `christmas`, one of the seven Christmas
      scenes (129-19)
13. Set the system date to a date in a gap, for example 15 April, 15 November,
    and 28 December. Check that `data-season` is `neutral` and that the scene
    is one of the ten neutral scenes. Check that the visits follow the same
    windows of 129-16: at most one visit from 08:00 to 12:00 and one from
    16:00 to 24:00. Check that `chalk.season.neutral.v1` has `done` set for each
    visit, and that the count in `chalk.season.visits.v1` does not change.
    Set the system date to 29 February of a leap year. Check that the scene is
    a neutral scene, because the date is in the gap from 8 February to
    28 February.
14. Switch between a dark theme and a light theme, for example `warmwhite`.
    Check that the scene shows on both with no panel behind it, except the small sign of the title.
15. Check that two visits make a new scene: the walkers enter from the edges
    again, and `data-scene` differs from the first visit. On a date in a
    season, the second visit comes 20 minutes or more after the first, and 1
    hour or more if the first started before 18:00. To avoid the wait, clear the
    key `chalk.season.visits.v1` from localStorage after the first visit. The
    next visit then comes within a minute.
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
    does not change, that the header of a phone width shows no scene, and that
    a device with the switch off shows no scene.
29. Check the row above the zuckermode list (400 px wide, zuckermode on, a date
    inside a season). On the list screen, check that the row takes no space
    before a visit. Check that it opens to 48 px, that the scene shows, and
    that the row collapses when the visit ends.
30. Open a conversation and go back to the list. Check that the row is closed,
    and that a visit comes after a first pause of 4 s to 12 s. Check that the
    daily caps still hold.
31. Turn zuckermode off. Check that no row shows.
32. Set the system date to a date in a gap. Check that the row shows a neutral
    scene.
33. Set the system clock to 21:00 on 24 December. Check that the row stays
    open, and that the count in `chalk.season.visits.v1` does not change.
34. On a date in a gap, set the clock to the evening. Check that a visit shows
    a neutral scene, and that the night frame is absent on video tiles.
35. Watch a whole visit of a season scene. Check that the scene stays the same,
    that `data-scene` does not change, and that the scene does not fade between
    scenes. In the always-on hours, watch for 35 seconds. Check that the scene
    fades out, that the next scene of the same key fades in, and that the
    walkers start again at the edges. After the fifth scene, check that the
    first one comes back.
36. Emulate reduced motion and start a visit. Check that the first frame is
    whole, with no fade in, and that it holds still.
37. During a visit in a season, check that the sign shows the name of the
    season. Check that the walkers run under the sign, and that the title
    fades with the scene.
38. On a date in a gap, check that the sign shows `CHALK`.
39. Make the strip narrower than the sign. Check that the title is absent and
    that the scene still shows.
40. Watch a walker run under the sign. Check that its head does not touch the
    sign.
41. Check three seasonal details. Examples are the smoke of the cabin in Cabin
    Smoke, the ice in Frozen Lake, and the bare trees in Old Graveyard.
    Since 129-21 the first two scenes are gone. Use the blossom in Cherry
    Blossom and the water in Lakeside Sunset in their place.
42. On a neutral date, watch each of the ten scripts (the demo in the `ui-sweep`
    skill shows one by name). Check that the strip is opaque, that the only text
    is the `CHALK` sign and, in The Hatch, the six numbers, and that the sign
    stays clear of the picture. Check this on a dark theme and on a light theme.
43. Emulate reduced motion on a neutral date. Check that a script holds its
    still frame, and that the frame shows the moment of the script.
44. Set the system date to 31 December. Watch each of the seven New Year
    scripts (the demo in the `ui-sweep` skill shows one by name). Check that
    the strip is opaque, and that the only text is the `CHALK` sign and the
    years and clock digits of the scripts. Check that no script shows a title,
    a logo, or a face. Check this on a dark theme and on a light theme.
45. Emulate reduced motion on 31 December. Check that a script holds its still
    frame, and that the frame shows the moment of the script.
46. Set the system date to 15 January. Watch each of the eight Winterfest
    scripts (the demo in the `ui-sweep` skill shows one by name). Check that the
    strip is opaque, and that the only text is the `CHALK` sign. Check that no
    script shows a title, a logo, or a face. Check this on a dark theme and on a
    light theme.
47. Emulate reduced motion on 15 January. Check that a script holds its still
    frame, and that the frame shows the moment of the script.

## How to add a season

1. Add a row to `SEASONS` in `web/src/season/seasons.ts`.
   It has an `id`, a `label`, a `from` date, and a `to` date.
   The rows must stay in calendar order with no overlap. Leave a gap of
   21 days between two seasons, or shorten the row of the season whose days you
   take.
   A season can have more than one row. The rows then share the `id`.
   A season whose dates move with the year also sets `moving`, a function from
   a year to a window (129-22). Its `from` and `to` then only keep the rows in
   calendar order, and `seasonFor` tests it before the fixed rows.
2. Add the new id to `SeasonId` in `seasons.ts`.
3. Add five rows to `SCENES` in `web/src/season/scene.ts`, with the same key,
   and add an entry to `PALETTES` and to `CANOPY`. Each row sets a name, an environment, an
   effect, four props, and two cast members. The props at index 1 and 2 are the
   obstacles. An environment, prop, cast member, or effect that does not exist
   yet needs drawing code in `scene.ts`.
4. Add the keywords of the season to the `seasonal` section in `settings-nav.ts`, if they are not there.
5. Optional: add a `night` window to the season.
   A `night` window needs a rule `html[data-season-night="<id>"] .chalk-voice-night` in `theme.css`.
   It also needs colours in the `setNightFrame` call in `App.tsx`.
   `theme-season.test.ts` fails if a season has a `night` window and no such rule.

`seasons.test.ts` checks that no day falls in two rows and that each gap is a
date in no row.
`scene.test.ts` checks that `SCENES` and `SEASONS` list the same ids, and that
each key of `SCENES` has five rows. The `"neutral"`, `"christmas"`,
`"new-year"`, `"winterfest"`, `"black-week"`, and `"late-autumn"` keys are not
in `SCENES`. They use the scripts of `OFFSEASON` (129-18), `CHRISTMAS`
(129-19), `NEWYEAR` (129-20), `WINTERFEST` (129-21), `BLACKWEEK` (129-22), and
`LATEAUTUMN` (129-23).

A key can run scripts and not rows, as `"neutral"`, `"christmas"`,
`"new-year"`, `"winterfest"`, `"black-week"`, and `"late-autumn"` do (129-19,
129-20, 129-21, 129-22, 129-23).
For such a key, add the scripts to a file next to `christmas.ts`, import the
shared parts from `strip.ts`, add the key to `SCRIPTED` in `scene.ts`, and add
the key to `PALETTES` and `CANOPY`. A script never reads those two entries, but
their `Record` type needs every `SceneKey`.

The device switch, the server switch, the schedule, the component, and the
stylesheet need no change.
