// chalk-web -- 129-9: the scene. 129-12: five scenes for each key, and the
// neutral key. 129-13: the title of the season on a small sign. 129-14: a
// higher sign, a sky for each row, and the details of each season. 129-15: a
// visit holds one row. 129-18: the neutral key has ten scripts and no rows.
// 129-19: the christmas key has seven scripts and no rows. 129-20: the new-year
// key has seven scripts and no rows. 129-21: the winterfest key has eight
// scripts and no rows. 129-22: the black-week key has nine scripts and no
// rows, and a script can have a weight. 129-23: the late-autumn key has seven
// scripts and no rows.
//
// This module draws a small pixel scene and moves it. There are eleven keys:
// the ten season ids of seasons.ts, and "neutral" for a date in no season.
// SCENES holds the five keys that have rows. Each of them has five rows
// (SCENES_PER_KEY), so there are 25 rows. A row names an environment, an
// effect, four props, and two cast members. Six keys have scripts and no
// rows: "neutral" has the ten scripts of OFFSEASON (offseason.ts), "christmas"
// has the seven scripts of CHRISTMAS (christmas.ts), "new-year" has the seven
// scripts of NEWYEAR (newyear.ts), "winterfest" has the eight scripts of
// WINTERFEST (winterfest.ts), and "black-week" has the nine scripts of
// BLACKWEEK (blackweek.ts), and "late-autumn" has the seven scripts of
// LATEAUTUMN (lateautumn.ts). So there are 73 scenes.
// A script draws its own opaque strip, and it does not use the fields of a
// row. The rows stay see-through.
// A scene shows its row or its script. A scene that rotates (rotate is true)
// shows it for SCENE_SECONDS. Then it shows the next one of the same key, and
// the first comes after the last. A scene that does not rotate holds its row or
// its script. The always-on hours rotate. A visit does not.
// Pure: the module uses no timer, no DOM, and no random source. The Painter is
// a parameter. Each effect takes its places from a hash of an index and from
// the time of the scene. So a test uses a fake Painter and gets the same
// picture each time. SeasonScene.tsx owns the loop and the start index.
// The scene differs from the engine that the user supplied, on purpose:
//   - It paints no sky color, no haze, and no earth block. The canvas stays
//     transparent, so the scene blends with all themes. The supplied engine
//     has no stars, no moon, and no sun. Here each row names a sky: none,
//     stars with a moon, a sun, or a low sun. See drawSky.
//   - It draws the title on a small sign, not on a panel for the whole strip.
//     The title is always at single size. The supplied engine uses double size
//     on a strip of 275 scene pixels or wider. Here the strip is 24 scene
//     pixels high, and double size would make the longest title nearly as
//     high as the strip.
//   - The sign is high in the strip, in rows 0 to 10. The ground is row 23.
//     The head of a walker is at row 13, so two clear rows are between the
//     head and the sign. A walker runs under the sign. The hat of a witch
//     rises four rows and reaches under the bottom edge of the sign, and a
//     jump can pass behind the sign.
//   - The ground is H - 1. The bottom line of the header is the ground.
//     Scattered tufts of grass on the ground stay.
//   - It has no preview API on window, because that would be a global in
//     production.
//   - A scene fades to transparent, not to black.

import { BLACKWEEK } from "./blackweek";
import { CHRISTMAS } from "./christmas";
import { LATEAUTUMN } from "./lateautumn";
import { NEWYEAR } from "./newyear";
import { WINTERFEST } from "./winterfest";
import { OFFSEASON } from "./offseason";
import { STRIP_H, type Script } from "./strip";
import type { SeasonId } from "./seasons";

/** SCALE is the number of CSS pixels in one scene pixel. */
export const SCALE = 2;

/** FPS is the number of frames each second that the component paints. */
export const FPS = 12;

/**
 * SCENE_SECONDS is the time in seconds that a scene that rotates shows one row
 * before it rotates. A scene that does not rotate ignores it.
 */
export const SCENE_SECONDS = 35;

/**
 * FADE_SECONDS is the length in seconds of the fade at the end of a row, and
 * of the fade in after a rotation. A scene that does not rotate has no fade.
 * See [sceneAlpha].
 */
export const FADE_SECONDS = 0.7;

/** SCENES_PER_KEY is the number of rows that each season of SCENES has. */
export const SCENES_PER_KEY = 5;

/**
 * sceneWeights returns the weight of each scene of key, in the order of the
 * scenes. The weight of a script is its weight field, or 1 if it has none. A
 * key that runs rows gives 1 for each of its SCENES_PER_KEY rows. nextRow in
 * visits.ts picks the scene of a visit with these weights. The always-on hours
 * ignore them.
 */
export function sceneWeights(key: SceneKey): number[] {
  return isScripted(key) ? SCRIPTED[key].map((s) => s.weight ?? 1) : Array.from({ length: SCENES_PER_KEY }, () => 1);
}

/**
 * sceneCount returns the number of scenes of key: the number of scripts for a
 * key that runs scripts ("neutral", "christmas", "new-year", "winterfest",
 * "black-week", and "late-autumn"), and SCENES_PER_KEY for any other key.
 */
export function sceneCount(key: SceneKey): number {
  return isScripted(key) ? SCRIPTED[key].length : SCENES_PER_KEY;
}

// The scripts of each key that runs scripts in place of rows. isScripted reads
// the keys of this object.
const SCRIPTED = {
  neutral: OFFSEASON,
  christmas: CHRISTMAS,
  "new-year": NEWYEAR,
  winterfest: WINTERFEST,
  "black-week": BLACKWEEK,
  "late-autumn": LATEAUTUMN,
};

/** A ScriptKey is a key that runs scripts and has no rows in SCENES. */
export type ScriptKey = keyof typeof SCRIPTED;

/** A RowKey is a key that has rows in SCENES. It is a SceneKey that is not a ScriptKey. */
export type RowKey = Exclude<SceneKey, ScriptKey>;

/** isScripted reports whether key runs scripts instead of rows. */
export function isScripted(key: SceneKey): key is ScriptKey {
  return key in SCRIPTED;
}

// The downward pull on a jump, and the upward speed at the start of a jump, in
// scene pixels and seconds.
const GRAVITY = 105;
const JUMP = 40;

/**
 * A SceneKey names a set of scenes: a season id or "neutral". A key has five
 * rows in SCENES, except five season keys that have scripts. "christmas" has
 * the seven scripts of CHRISTMAS, "new-year" has the seven scripts of NEWYEAR,
 * "winterfest" has the eight scripts of WINTERFEST, "black-week" has the nine
 * scripts of BLACKWEEK, and "late-autumn" has the seven scripts of LATEAUTUMN.
 * "neutral", for a date in no season, has the ten scripts of OFFSEASON.
 */
export type SceneKey = SeasonId | "neutral";

// The unions below list every value that a row can use. A misspelled value
// fails at compile time.

type Environment =
  | "city"
  | "town"
  | "lake"
  | "hills"
  | "forest"
  | "mountain"
  | "orchard"
  | "garden"
  | "meadow"
  | "farm"
  | "graveyard"
  | "swamp";
type Effect =
  | "fireworks"
  | "confetti"
  | "sparkles"
  | "snow"
  | "aurora"
  | "petals"
  | "rain"
  | "butterflies"
  | "fireflies"
  | "embers"
  | "lanterns"
  | "leaves"
  | "ghosts"
  | "bats"
  | "fog"
  | "clouds";
/**
 * A Sky is the sky of one scene. "none" draws nothing. "stars" draws stars and
 * a moon, orange in Spooky Season. "sun" draws a sun. "low-sun" draws a low
 * sun with a line of glow, for a sunrise or a sunset.
 */
type Sky = "none" | "stars" | "sun" | "low-sun";
type Prop =
  | "bridge"
  | "lilypad"
  | "tree"
  | "cherry"
  | "appletree"
  | "pine"
  | "bare"
  | "house"
  | "cabin"
  | "manor"
  | "stall"
  | "tower"
  | "clock"
  | "windmill"
  | "lamp"
  | "lantern"
  | "snowman"
  | "scarecrow"
  | "reeds"
  | "flower"
  | "flag"
  | "boat"
  | "grave"
  | "pumpkin"
  | "mushroom"
  | "cauldron"
  | "campfire"
  | "ice"
  | "snowball"
  | "stone"
  | "log"
  | "stump"
  | "crate"
  | "barrel"
  | "basket"
  | "hay"
  | "gift"
  | "flowerpot";
type Cast =
  | "person"
  | "cat"
  | "fox"
  | "rabbit"
  | "hedgehog"
  | "frog"
  | "chick"
  | "penguin"
  | "skeleton"
  | "witch"
  | "ghost";

/**
 * A SceneRow describes one scene. `name` is the name of the scene.
 * `environment` and `effect` set the background and the moving effect. `props`
 * has four props. Their places are the four entries of `positions`, and the
 * props at index 1 and 2 are the obstacles that the walkers jump over. `cast`
 * has two walkers: the first enters from the left edge, the second from the
 * right edge. `sky` is the sky that drawSky draws.
 */
export interface SceneRow {
  name: string;
  environment: Environment;
  effect: Effect;
  props: [Prop, Prop, Prop, Prop];
  cast: [Cast, Cast];
  sky: Sky;
}

function row(
  name: string,
  environment: Environment,
  effect: Effect,
  props: [Prop, Prop, Prop, Prop],
  cast: [Cast, Cast],
  sky: Sky = "none",
): SceneRow {
  return { name, environment, effect, props, cast, sky };
}

/**
 * SCENES holds the rows of each RowKey, in the order of rotation. Each key has
 * SCENES_PER_KEY rows. The "neutral", "christmas", "new-year", "winterfest",
 * "black-week", and "late-autumn" keys have no rows. They use the scripts of
 * OFFSEASON, CHRISTMAS, NEWYEAR, WINTERFEST, BLACKWEEK, and LATEAUTUMN.
 */
export const SCENES: Record<RowKey, SceneRow[]> = {
  "spring-bloom": [
    row("Cherry Blossom", "orchard", "petals", ["cherry", "flowerpot", "stone", "cherry"], ["rabbit", "chick"], "sun"),
    row("Rain Garden", "garden", "rain", ["tree", "flowerpot", "log", "flower"], ["frog", "rabbit"]),
    row("Pond Hopping", "lake", "butterflies", ["reeds", "lilypad", "stone", "reeds"], ["frog", "chick"], "sun"),
    row("Flower Trail", "meadow", "petals", ["flower", "flowerpot", "stone", "flower"], ["rabbit", "fox"], "sun"),
    row("Butterfly Orchard", "orchard", "butterflies", ["cherry", "log", "flowerpot", "cherry"], ["chick", "rabbit"], "sun"),
  ],
  "green-season": [
    row("Deep Woods", "forest", "fireflies", ["tree", "log", "stone", "tree"], ["fox", "cat"]),
    row("Stream Crossing", "lake", "butterflies", ["reeds", "log", "stone", "tree"], ["frog", "fox"], "sun"),
    row("Fern Garden", "garden", "butterflies", ["flower", "flowerpot", "log", "tree"], ["frog", "rabbit"], "sun"),
    row("Hillside Run", "hills", "butterflies", ["tree", "stone", "log", "tree"], ["rabbit", "fox"], "sun"),
    row("Summer Rain", "forest", "rain", ["tree", "log", "stump", "tree"], ["frog", "cat"]),
  ],
  midsummer: [
    row("Golden Meadow", "meadow", "butterflies", ["flower", "stone", "flowerpot", "flower"], ["rabbit", "fox"], "sun"),
    row("Lakeside Sunset", "lake", "fireflies", ["reeds", "lilypad", "stone", "reeds"], ["frog", "person"], "low-sun"),
    row("Campfire Evening", "forest", "embers", ["pine", "log", "stone", "campfire"], ["person", "fox"], "stars"),
    row("Firefly Night", "hills", "fireflies", ["tree", "stone", "log", "tree"], ["cat", "rabbit"], "stars"),
    row("Festival Lanterns", "town", "lanterns", ["lantern", "crate", "flowerpot", "lantern"], ["person", "cat"], "stars"),
  ],
  "harvest-festival": [
    row("Mushroom Grove", "forest", "leaves", ["tree", "mushroom", "log", "tree"], ["hedgehog", "fox"]),
    row("Apple Orchard", "orchard", "leaves", ["appletree", "basket", "crate", "appletree"], ["fox", "rabbit"], "sun"),
    row("Hayfield Run", "farm", "leaves", ["hay", "hay", "crate", "scarecrow"], ["hedgehog", "person"], "sun"),
    row("Village Market", "town", "leaves", ["stall", "basket", "mushroom", "lantern"], ["person", "fox"], "sun"),
    row("Golden Fields", "farm", "leaves", ["scarecrow", "stump", "hay", "windmill"], ["fox", "hedgehog"], "low-sun"),
  ],
  "spooky-season": [
    row("Old Graveyard", "graveyard", "ghosts", ["bare", "grave", "pumpkin", "bare"], ["skeleton", "cat"], "stars"),
    row("Haunted Manor", "town", "bats", ["manor", "grave", "pumpkin", "bare"], ["skeleton", "ghost"], "stars"),
    row("Witchwood", "forest", "bats", ["bare", "mushroom", "cauldron", "bare"], ["witch", "cat"], "stars"),
    row("Foggy Marsh", "swamp", "fog", ["bare", "stone", "grave", "reeds"], ["ghost", "skeleton"]),
    row("Pumpkin Patch", "farm", "ghosts", ["pumpkin", "pumpkin", "pumpkin", "scarecrow"], ["cat", "witch"], "stars"),
  ],
};

// For each key: the colours of the ground tufts and of the hills, meadow, and
// farm (earth, edge), the title of the season (title), and the colours of the
// letters (ink) and of the sign (panel). The edge colour also draws the two
// lines of the sign. The neutral key has the title "CHALK".
const PALETTES: Record<SceneKey, {
  earth: string;
  edge: string;
  title: string;
  ink: string;
  panel: string;
}> = {
  // Rows never read the entries of "new-year", "winterfest", and "black-week",
  // because those keys run scripts. The Record type needs them.
  "new-year": {
    earth: "#29344d",
    edge: "#576d95",
    title: "NEW YEAR",
    ink: "#ffd47c",
    panel: "#091222",
  },
  winterfest: {
    earth: "#b3cdd4",
    edge: "#e6f4f0",
    title: "WINTERFEST",
    ink: "#daf5ff",
    panel: "#102637",
  },
  "spring-bloom": {
    earth: "#467849",
    edge: "#81ba70",
    title: "SPRING BLOOM",
    ink: "#ffe0ea",
    panel: "#294d43",
  },
  "green-season": {
    earth: "#285b33",
    edge: "#68a94e",
    title: "GREEN SEASON",
    ink: "#ceffab",
    panel: "#173a2b",
  },
  midsummer: {
    earth: "#607c35",
    edge: "#afbd60",
    title: "MIDSUMMER",
    ink: "#ffe6a0",
    panel: "#485139",
  },
  "harvest-festival": {
    earth: "#64512c",
    edge: "#b49a4c",
    title: "HARVEST FESTIVAL",
    ink: "#ffdc92",
    panel: "#453423",
  },
  "spooky-season": {
    earth: "#152d1d",
    edge: "#467442",
    title: "SPOOKY SEASON",
    ink: "#ffb057",
    panel: "#121324",
  },
  // Rows never read this entry, because "late-autumn" runs scripts. The Record
  // type needs it.
  "late-autumn": {
    earth: "#493d30",
    edge: "#a27743",
    title: "LATE AUTUMN",
    ink: "#f9c992",
    panel: "#292e2e",
  },
  // Rows never read this entry, because "christmas" runs scripts. The Record
  // type needs it.
  christmas: {
    earth: "#2a3a36",
    edge: "#5f7c74",
    title: "CHRISTMAS",
    ink: "#ffd23a",
    panel: "#132622",
  },
  "black-week": {
    earth: "#2a3a36",
    edge: "#5f7c74",
    title: "BLACK WEEK",
    ink: "#ffd23a",
    panel: "#132622",
  },
  neutral: {
    earth: "#193d28",
    edge: "#397a4b",
    title: "CHALK",
    ink: "#62edaf",
    panel: "#081d13",
  },
};

// A walker. `lift` is the height above the ground and `vy` the upward speed.
// `jumped` is the id of the last obstacle that the walker jumped, or -1.
interface Actor {
  type: Cast;
  x: number;
  dir: 1 | -1;
  speed: number;
  width: number;
  lift: number;
  vy: number;
  jumped: number;
}

// An obstacle: the prop at index `id` of the row, with its x place and width.
interface Obstacle {
  id: number;
  x: number;
  width: number;
}

/**
 * A Scene is the state of one running scene, W by H scene pixels. `key` and
 * `index` pick the current row, `row`. For a key that runs scripts, they pick
 * the current script, and `row` only holds its name. `time` is the time of the
 * scene in seconds, and `sceneTime` is the time since the current row started.
 * `rotations` counts the rotations. One loop at a time must step and paint a
 * Scene.
 */
export interface Scene {
  key: SceneKey;
  index: number;
  row: SceneRow;
  W: number;
  H: number;
  ground: number;
  time: number;
  sceneTime: number;
  // The number of rotations since createScene. sceneAlpha reads it to skip the
  // fade in of the first row.
  rotations: number;
  // 129-15: true if the scene rotates through the rows. It is false for a
  // visit, which holds one row from start to end.
  rotate: boolean;
  // 129-18: the script of an off-season scene, or null for a scene with a row.
  script: Script | null;
  actors: Actor[];
  obstacles: Obstacle[];
}

/**
 * A Painter is the part of CanvasRenderingContext2D that drawScene uses, so a
 * test can pass a fake.
 */
export type Painter = Pick<CanvasRenderingContext2D, "fillStyle" | "fillRect" | "globalAlpha">;

type Px = (x: number, y: number, w: number, h: number, color: string) => void;

// 129-18: the row of a script. A script draws itself, so only the name is
// read, and it names the scene. The other fields are placeholders.
function scriptRow(script: Script): SceneRow {
  return row(script.name, "town", "sparkles", ["lamp", "lamp", "lamp", "lamp"], ["person", "cat"]);
}

/**
 * holdStill moves a scene with a script to the still time of its script. The
 * frame then holds when the system asks for reduced motion. A scene with a row
 * does not change.
 */
export function holdStill(s: Scene): void {
  if (s.script) s.sceneTime = s.script.still;
}

// The x places of the four props of a row, from left to right. The two inner
// places, at 20 percent and 80 percent of the width, hold the obstacles. The
// outer places are at fixed distances from the edges, where the walkers enter.
// The walkers jump over the inner props only.
function positions(W: number): number[] {
  return [12, Math.round(W * 0.2), Math.round(W * 0.8), W - 24];
}

// Loads the row at s.index, or the script at s.index for a key that runs
// scripts. The row
// timer starts again. A script has no walkers and no obstacles. For a row, the
// walkers go back to the edges. The props at index 1 and 2 become the
// obstacles. The props at index 0 and 3 stand next to the edges, so they are
// not obstacles.
function loadRow(s: Scene): void {
  s.sceneTime = 0;
  if (isScripted(s.key)) {
    const script = SCRIPTED[s.key][s.index];
    s.script = script;
    s.row = scriptRow(script);
    s.obstacles = [];
    s.actors = [];
    return;
  }
  s.script = null;
  s.row = SCENES[s.key][s.index];
  const at = positions(s.W);
  s.obstacles = [1, 2].map((i) => ({ id: i, x: at[i], width: 10 }));
  s.actors = s.row.cast.map((type, i) => ({
    type,
    x: i === 0 ? -14 : s.W + 14,
    dir: i === 0 ? 1 : -1,
    speed: i === 0 ? 17 : 20,
    width: 9,
    lift: 0,
    vy: 0,
    jumped: -1,
  }));
}

/**
 * createScene returns a new scene of W by H scene pixels for `key`. The scene
 * starts at the row `index`, or at the script `index` for a key that runs scripts. An index
 * outside 0 to sceneCount(key) - 1 wraps around, also a negative one.
 *
 * If rotate is true, the scene rotates through the rows or scripts of the key.
 * If rotate is false, the scene holds the row or script `index` and stepScene
 * never changes it.
 */
export function createScene(
  key: SceneKey,
  W: number,
  H: number,
  index = 0,
  rotate = true,
): Scene {
  const n = sceneCount(key);
  const start = ((index % n) + n) % n;
  const s: Scene = {
    key,
    index: start,
    row: isScripted(key) ? scriptRow(SCRIPTED[key][start]) : SCENES[key][start],
    W,
    H,
    ground: H - 1,
    time: 0,
    sceneTime: 0,
    rotations: 0,
    rotate,
    script: null,
    actors: [],
    obstacles: [],
  };
  loadRow(s);
  return s;
}

/**
 * resizeScene moves the ground and the obstacles to fit a scene of W by H
 * scene pixels.
 */
export function resizeScene(s: Scene, W: number, H: number): void {
  s.W = W;
  s.H = H;
  s.ground = H - 1;
  const at = positions(W);
  s.obstacles.forEach((o) => {
    o.x = at[o.id];
  });
}

/**
 * stepScene moves the scene forward by `elapsed` seconds. It counts at most
 * 0.1 s, so a long frame cannot throw a walker across the strip. When the row
 * has shown for SCENE_SECONDS and the scene rotates, the scene shows the next
 * row of its key, and the walkers start again at the edges. A scene that does
 * not rotate stays on its row.
 */
export function stepScene(s: Scene, elapsed: number): void {
  const dt = Math.min(elapsed, 0.1);
  s.time += dt;
  s.sceneTime += dt;
  if (s.rotate && s.sceneTime >= SCENE_SECONDS) {
    s.index = (s.index + 1) % sceneCount(s.key);
    s.rotations++;
    loadRow(s);
  }
  for (const a of s.actors) {
    if (a.type === "ghost") {
      // A ghost floats: it never jumps. Its bob is drawn in drawActor.
      a.x += a.dir * a.speed * dt;
    } else {
      if (a.lift === 0 && a.vy === 0) {
        for (const o of s.obstacles) {
          const gap = a.dir > 0 ? o.x - (a.x + a.width) : a.x - (o.x + o.width);
          if (gap >= 0 && gap <= 10 && a.jumped !== o.id) {
            a.vy = JUMP;
            a.jumped = o.id;
            break;
          }
        }
      }
      a.x += a.dir * a.speed * dt;
      if (a.vy !== 0 || a.lift > 0) {
        a.lift += a.vy * dt;
        a.vy -= GRAVITY * dt;
        if (a.lift <= 0) {
          a.lift = 0;
          a.vy = 0;
        }
      }
    }
    if (a.dir > 0 && a.x > s.W + 14) {
      a.x = -14;
      a.jumped = -1;
    }
    if (a.dir < 0 && a.x < -14) {
      a.x = s.W + 14;
      a.jumped = -1;
    }
  }
}

// A hash of n to a number from 0 up to, but not including, 1. The same n always
// gives the same number, so the effects need no random source.
function rand(n: number): number {
  const v = Math.sin(n * 127.1 + 78.233) * 43758.5453;
  return v - Math.floor(v);
}

/**
 * sceneAlpha returns the opacity of the scene, from 0 to 1. The scene fades
 * out in the last FADE_SECONDS of its row. After a rotation, it also fades in
 * during the first FADE_SECONDS of the new row. A scene that does not rotate
 * always returns 1. The first row of a scene does not fade in, so a frame at
 * time zero is whole when the system asks for reduced motion. The CSS fade of
 * the canvas covers the start of the visit.
 */
export function sceneAlpha(s: Scene): number {
  if (!s.rotate) return 1;
  const out = (SCENE_SECONDS - s.sceneTime) / FADE_SECONDS;
  const into = s.rotations > 0 ? s.sceneTime / FADE_SECONDS : 1;
  return Math.max(0, Math.min(1, into, out));
}

// The color of the background trees of each key. The orchard of Spring Bloom
// uses pink instead. A bare tree has no canopy.
const CANOPY: Record<SceneKey, string> = {
  // Rows never read the entries of "new-year", "winterfest", and "black-week",
  // because those keys run scripts. The Record type needs them.
  "new-year": "#1f3a35",
  winterfest: "#1f3f38",
  "spring-bloom": "#5f8f57",
  "green-season": "#264f35",
  midsummer: "#3f7a3a",
  "harvest-festival": "#9a6a2c",
  "spooky-season": "#2a2433",
  // Rows never read this entry, because "late-autumn" runs scripts.
  "late-autumn": "#7b4a26",
  // Rows never read this entry, because "christmas" runs scripts.
  christmas: "#1f3f38",
  "black-week": "#1f3f38",
  neutral: "#264635",
};

// Reports whether the key is Winterfest or New Year. In those keys, roofs and
// treetops carry snow. Both keys run scripts, so no row reaches this test now.
// The test stays for later tuning.
function isSnowy(s: Scene): boolean {
  return s.key === "winterfest" || s.key === "new-year";
}

// Reports whether the key is Spooky Season or Late Autumn. In those keys, the
// background trees are bare. Late Autumn runs scripts, so no row reaches that
// case now. The case stays for later tuning.
function isLeafless(s: Scene): boolean {
  return s.key === "spooky-season" || s.key === "late-autumn";
}

// Draws the sky that the row names. Stars come with a moon. A low sun comes
// with a line of glow, and on water it shows as orange lines.
function drawSky(p: Px, s: Scene): void {
  const { W, ground, time, row: r } = s;
  if (r.sky === "stars") {
    for (let i = 0; i < 29; i++) {
      const lit = Math.floor(time * 2 + i * 0.7) % 4 === 0;
      p(rand(i + 11) * W, rand(i + 81) * (ground - 8), 1, 1, lit ? "#b9bba0" : "#475668");
    }
    const x = W - 34;
    const c = s.key === "spooky-season" ? "#e6a34c" : "#d8ddd3";
    p(x + 2, 2, 7, 1, c);
    p(x, 3, 11, 5, c);
    p(x + 2, 8, 7, 1, c);
    p(x + 3, 4, 2, 2, s.key === "spooky-season" ? "#b97b34" : "#a7a493");
  }
  if (r.sky === "sun") {
    const x = W - 34;
    p(x + 2, 2, 7, 1, "#ffda76");
    p(x, 3, 11, 6, "#ffda76");
    p(x + 2, 9, 7, 1, "#ffda76");
  }
  if (r.sky === "low-sun") {
    const x = Math.round(W * 0.7);
    p(x + 3, ground - 11, 8, 1, "#ffc46b");
    p(x + 1, ground - 10, 12, 2, "#ffb45c");
    p(x, ground - 8, 14, 4, "#ff9a4f");
    p(x - 14, ground - 5, 42, 1, "#c9774a");
  }
}

function drawBackground(p: Px, s: Scene): void {
  const { W, ground, key } = s;
  const env = s.row.environment;
  const { earth, edge } = PALETTES[key];
  if (env === "city" || env === "town") {
    for (let i = 0; i < 8; i++) {
      const x = i < 4 ? i * 17 : W - (8 - i) * 17;
      const bh = env === "city" ? 9 + ((i * 7) % 10) : 5 + ((i * 3) % 6);
      p(x, ground - bh, 13, bh, "#1c2a30");
      if (isSnowy(s)) p(x, ground - bh, 13, 1, "#dfeef0");
      for (let yy = ground - bh + 3; yy < ground - 2; yy += 4) {
        p(x + 3, yy, 2, 1, "#b09a62");
        p(x + 8, yy, 2, 1, "#627a70");
      }
    }
  }
  if (env === "forest" || env === "orchard" || env === "garden") {
    for (let i = 0; i < 7; i++) {
      const x = i < 4 ? i * 17 : W - (7 - i) * 18;
      p(x + 4, ground - 11, 2, 11, "#26382a");
      if (isLeafless(s)) {
        p(x + 1, ground - 13, 3, 1, "#26382a");
        p(x + 6, ground - 12, 3, 1, "#26382a");
        continue;
      }
      p(x, ground - 14, 10, 8, env === "orchard" && key === "spring-bloom" ? "#d99ab4" : CANOPY[key]);
      if (isSnowy(s)) p(x, ground - 14, 10, 1, "#e6f4f0");
    }
  }
  if (env === "hills" || env === "meadow" || env === "farm") {
    for (let x = 0; x < W; x += 5) {
      const height = 3 + Math.round((Math.sin(x / 23) + 1) * 2);
      p(x, ground - height, 5, height, earth);
    }
    if (env === "farm") {
      for (let x = 3; x < W; x += 12) p(x, ground - 2, 5, 1, edge);
    }
  }
  if (env === "mountain") {
    for (let i = 0; i < 6; i++) {
      const x = i < 3 ? i * 22 : W - (6 - i) * 22;
      const height = 10 + (i % 3) * 3;
      for (let level = 0; level < height; level += 2) {
        p(x + Math.floor(level / 3), ground - height + level, Math.max(3, 17 - Math.floor(level / 2)), 2, "#38505c");
      }
    }
  }
  if (env === "lake" || env === "swamp") {
    // Only a row of "winterfest" freezes the lake. No row has that key now, so
    // the ice stays for later tuning.
    const frozen = key === "winterfest";
    const sunset = s.row.sky === "low-sun";
    p(0, ground - 4, W, 4, frozen ? "#a9cfdc" : env === "lake" ? "#284f61" : "#2a4940");
    for (let i = 0; i < 20; i++) {
      const drift = frozen ? 0 : s.time * 2;
      const c = frozen ? "#dcecf0" : sunset && i % 2 ? "#e0935a" : "#739087";
      p((i * 31 + drift) % W, ground - 3 + (i % 2), 5, 1, c);
    }
  }
  if (env === "graveyard") {
    for (let i = 0; i < 9; i++) {
      const x = (i * 37 + 8) % W;
      p(x, ground - 5, 5, 5, "#34483e");
      p(x + 1, ground - 6, 3, 1, "#566d5e");
    }
  }
  for (let i = 0; i < 15; i++) {
    const x = rand(i * 9 + 3) * W;
    // Snow tufts for "winterfest". No row has that key now.
    if (key === "winterfest") p(x, ground - 1, 3, 1, "#e9f5f2");
    else p(x, ground - 1, 2, 1, edge);
  }
}

function drawProp(p: Px, s: Scene, kind: Prop, x: number): void {
  const y = s.ground;
  const brown = "#75533b";
  const green = "#315e3b";
  switch (kind) {
    case "tree":
    case "cherry":
    case "appletree": {
      p(x + 5, y - 13, 3, 13, brown);
      const c = kind === "cherry" ? "#e8a1bd" : "#376d3f";
      p(x + 1, y - 17, 12, 9, c);
      p(x + 3, y - 20, 8, 5, c);
      if (kind === "appletree") {
        p(x + 3, y - 13, 2, 2, "#de6d42");
        p(x + 9, y - 17, 2, 2, "#de6d42");
      }
      break;
    }
    case "pine":
      p(x + 5, y - 15, 3, 15, brown);
      p(x + 4, y - 20, 5, 7, "#315d48");
      p(x + 2, y - 16, 9, 7, "#24513c");
      p(x, y - 11, 13, 7, "#204832");
      // Only a row of "winterfest" puts snow on a pine. No row has that key now.
      if (s.key === "winterfest") {
        p(x + 4, y - 20, 5, 1, "#ecf5f1");
        p(x + 2, y - 16, 9, 1, "#d8ebea");
      }
      break;
    case "bare":
      p(x + 6, y - 18, 2, 18, "#503a30");
      p(x + 2, y - 15, 4, 2, "#503a30");
      p(x + 1, y - 19, 2, 6, "#503a30");
      p(x + 8, y - 13, 5, 2, "#503a30");
      p(x + 11, y - 17, 2, 6, "#503a30");
      break;
    case "house":
    case "cabin":
    case "manor":
    case "stall": {
      const big = kind === "manor";
      const width = big ? 20 : 15;
      const height = big ? 15 : 10;
      const lit = big ? (Math.floor(s.time * 3) % 5 === 0 ? "#6b5a3a" : "#efc574") : "#efc574";
      p(x, y - height, width, height, big ? "#303047" : brown);
      p(x - 2, y - height - 3, width + 4, 3, "#413b45");
      if (isSnowy(s)) p(x - 2, y - height - 3, width + 4, 1, "#e6f4f0");
      p(x + 3, y - height + 3, 3, 3, lit);
      p(x + width - 6, y - height + 3, 3, 3, lit);
      // No row has a cabin now. The chimney smoke stays for later tuning.
      if (kind === "cabin") {
        p(x + 11, y - height - 6, 3, 4, "#413b45");
        for (let i = 0; i < 6; i++) {
          const phase = (s.time * 0.5 + i / 6) % 1;
          p(x + 12 + Math.sin(s.time + i) * 2 + phase * 6, y - height - 7 - phase * 7, 2, 1, "#9aa6a6");
        }
      }
      p(x + Math.floor(width / 2) - 2, y - 5, 4, 5, "#27352c");
      break;
    }
    case "tower":
    case "clock":
    case "windmill":
      p(x + 4, y - 17, 9, 17, "#515465");
      p(x + 2, y - 19, 13, 3, "#333d51");
      if (kind === "clock") {
        p(x + 7, y - 15, 5, 5, "#e2c581");
        p(x + 9, y - 14, 1, 3, "#413a31");
      }
      if (kind === "windmill") {
        if (Math.floor(s.time * 3) % 2) {
          p(x + 8, y - 20, 2, 12, "#dac9a0");
          p(x + 3, y - 15, 12, 2, "#dac9a0");
        } else {
          for (let i = -4; i <= 4; i++) {
            p(x + 8 + i, y - 15 + i, 2, 2, "#dac9a0");
            p(x + 8 + i, y - 15 - i, 2, 2, "#dac9a0");
          }
        }
      }
      break;
    case "lamp":
    case "lantern":
      p(x + 5, y - 14, 2, 14, "#6b6951");
      p(x + 3, y - 16, 6, 5, "#f4bb64");
      p(x + 4, y - 15, 4, 3, Math.sin(s.time * 7 + x) > 0.6 ? "#f7cf7e" : "#ffe19b");
      break;
    case "snowman":
      p(x + 2, y - 6, 9, 6, "#eaf3ed");
      p(x + 4, y - 11, 6, 6, "#ffffff");
      p(x + 8, y - 8, 1, 1, "#e49a45");
      p(x + 5, y - 9, 1, 1, "#26373f");
      break;
    case "scarecrow":
      p(x + 6, y - 17, 2, 17, brown);
      p(x + 1, y - 13, 12, 2, brown);
      p(x + 4, y - 18, 6, 5, "#d2ac67");
      p(x + 3, y - 19, 8, 2, "#80603e");
      break;
    case "bridge":
      p(x - 2, y - 4, 16, 2, "#8a6543");
      p(x - 2, y - 2, 2, 2, "#5f4530");
      p(x + 12, y - 2, 2, 2, "#5f4530");
      p(x, y - 8, 1, 4, "#5f4530");
      p(x + 11, y - 8, 1, 4, "#5f4530");
      p(x, y - 8, 12, 1, "#a07a52");
      break;
    case "lilypad":
      p(x + 1, y - 4, 9, 2, "#4f8f4a");
      p(x + 4, y - 6, 3, 2, "#e8b3cf");
      break;
    case "reeds":
      for (let i = 0; i < 4; i++) p(x + i * 3, y - 4 - (i % 3), 1, 5, green);
      break;
    case "flower":
      p(x + 6, y - 6, 1, 6, green);
      p(x + 4, y - 9, 5, 4, "#f3b0aa");
      p(x + 6, y - 8, 1, 2, "#ffe08b");
      break;
    case "flag":
      p(x + 3, y - 15, 1, 15, "#c1c5b3");
      p(x + 4, y - 15, 9, 5, "#d69c54");
      break;
    case "boat":
      p(x, y - 5, 16, 3, "#875d41");
      p(x + 3, y - 2, 10, 2, "#a47850");
      p(x + 8, y - 14, 1, 9, "#c2bda5");
      p(x + 9, y - 13, 6, 8, "#ddd5ac");
      break;
    case "grave":
      p(x + 2, y - 8, 8, 8, "#536459");
      p(x + 4, y - 9, 4, 1, "#718477");
      p(x + 6, y - 7, 1, 5, "#a0a99c");
      p(x + 5, y - 6, 3, 1, "#a0a99c");
      break;
    case "pumpkin":
      p(x + 5, y - 9, 2, 3, green);
      p(x + 1, y - 6, 10, 6, "#c56b27");
      p(x + 3, y - 7, 6, 7, "#ed8b33");
      p(x + 4, y - 4, 1, 1, "#24170d");
      p(x + 8, y - 4, 1, 1, "#24170d");
      p(x + 5, y - 2, 3, 1, Math.sin(s.time * 6 + x) > 0.5 ? "#ffa640" : "#ffdb67");
      break;
    case "mushroom":
      p(x + 5, y - 5, 4, 5, "#e2d2ae");
      p(x + 2, y - 8, 10, 5, "#bd5945");
      p(x + 5, y - 7, 2, 2, "#fff0cb");
      break;
    case "cauldron":
      p(x + 1, y - 7, 12, 6, "#333b3c");
      p(x + 3, y - 8, 8, 2, "#79ae58");
      p(x + 4, y - 10 - Math.sin(s.time * 3) * 2, 2, 2, "#9bc96c");
      break;
    case "campfire":
      p(x + 2, y - 2, 10, 2, brown);
      p(x + 5, y - 8 - (Math.floor(s.time * 6) % 2), 4, 6, "#f3ae3e");
      p(x + 6, y - 6, 2, 4, "#ffe48b");
      for (let i = 0; i < 4; i++) {
        const phase = (s.time * 0.5 + i / 4) % 1;
        p(x + 6 + Math.sin(s.time + i) * 2, y - 10 - phase * 8, 1, 1, "#8f9a94");
      }
      break;
    case "ice":
    case "snowball":
    case "stone": {
      const c = kind === "stone" ? "#87958c" : kind === "ice" ? "#a6e1e9" : "#edf4f2";
      p(x + 2, y - 6, 7, 6, c);
      p(x, y - 4, 11, 4, c);
      break;
    }
    case "log":
    case "stump":
    case "crate":
    case "barrel":
    case "basket":
    case "hay":
    case "gift":
    case "flowerpot": {
      const c = {
        log: "#7f5638",
        stump: "#70543e",
        crate: "#9c704a",
        barrel: "#765c47",
        basket: "#ad814d",
        hay: "#d0a84e",
        gift: "#b76c9b",
        flowerpot: "#b46a50",
      }[kind];
      p(x + 1, y - 6, 10, 6, c);
      p(x, y - 5, 12, 2, c);
      if (kind === "gift") p(x + 5, y - 6, 2, 6, "#e9d59e");
      if (kind === "flowerpot") {
        p(x + 5, y - 11, 1, 5, green);
        p(x + 3, y - 12, 5, 3, "#f4b0b1");
      }
      if (kind === "hay") p(x + 4, y - 6, 1, 6, "#97702e");
      break;
    }
  }
}

function drawEffects(p: Px, s: Scene): void {
  const { W, ground } = s;
  const t = s.time;
  const effect = s.row.effect;
  if (effect === "fireworks") {
    const colors = ["#ffcd61", "#f584aa", "#85cfff", "#d4a5f2"];
    for (let burst = 0; burst < 4; burst++) {
      const phase = (t * 0.27 + burst * 0.24) % 1;
      if (phase > 0.75) continue;
      const cx = burst % 2 ? W - 38 : 38;
      const cy = 5 + (burst % 2) * 4;
      const radius = phase * 24;
      for (let i = 0; i < 12; i++) {
        const a = (i * Math.PI) / 6;
        p(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius * 0.65, 1, 1, colors[(i + burst) % colors.length]);
      }
    }
    return;
  }
  if (effect === "aurora") {
    for (let i = 0; i < 35; i++) {
      p((i * W) / 35, 2 + Math.sin(t + i * 0.3) * 3, 3, 9, i % 2 ? "#497e8c" : "#4c9a76");
    }
    return;
  }
  if (effect === "fog") {
    for (let i = 0; i < 7; i++) {
      p(((i * 53 + t * 3) % (W + 35)) - 20, ground - 5 - (i % 3), 25, 2, "#65766b");
    }
    return;
  }
  if (effect === "ghosts" || effect === "bats") {
    for (let i = 0; i < 2; i++) {
      const x = ((t * (9 + i * 5) + i * 87) % (W + 20)) - 10;
      const y = 3 + Math.sin(t * 2 + i) * 2;
      if (effect === "ghosts") {
        p(x + 2, y, 6, 2, "#dcebd9");
        p(x, y + 2, 10, 6, "#dcebd9");
        p(x + 2, y + 4, 1, 2, "#1d2930");
        p(x + 7, y + 4, 1, 2, "#1d2930");
      } else {
        const flap = Math.floor(t * 9 + i) % 2;
        p(x + 4, y + 2, 3, 2, "#9b81a3");
        p(x, y + (flap ? 0 : 3), 4, 1, "#9b81a3");
        p(x + 7, y + (flap ? 0 : 3), 4, 1, "#9b81a3");
      }
    }
    return;
  }
  if (effect === "clouds") {
    for (let i = 0; i < 4; i++) {
      const x = ((i * 83 + t * 3) % (W + 35)) - 20;
      const y = 2 + (i % 3) * 3;
      p(x + 3, y, 12, 2, "#9caf9d");
      p(x, y + 2, 20, 2, "#9caf9d");
    }
    return;
  }
  const count = effect === "snow" ? 35 : 18;
  for (let i = 0; i < count; i++) {
    const sx = rand(i + 25) * W;
    const sy = rand(i + 75) * ground;
    const speed = 3 + rand(i + 125) * 9;
    if (
      effect === "snow" ||
      effect === "rain" ||
      effect === "petals" ||
      effect === "leaves" ||
      effect === "confetti"
    ) {
      const x = (sx + Math.sin(t + i) * 3 + (effect === "leaves" ? t * 5 : 0) + W * 10) % W;
      const y = (sy + t * speed) % ground;
      if (effect === "snow") p(x, y, 1, 1, "#ecf7f4");
      if (effect === "rain") p(x, y, 1, 3, "#a2b8cb");
      if (effect === "petals") p(x, y, 2, 1, i % 2 ? "#f6c3d8" : "#f1a9bf");
      if (effect === "leaves") p(x, y, 2, 2, i % 2 ? "#c98938" : "#e2ae51");
      if (effect === "confetti") p(x, y, 2, 1, ["#ffb766", "#a7ccff", "#f39cbc"][i % 3]);
    }
    if (effect === "fireflies" || effect === "sparkles") {
      const x = sx + Math.sin(t + i) * 5;
      const y = 3 + sy * 0.7 + Math.sin(t * 2 + i) * 2;
      if (Math.sin(t * 4 + i * 7) > 0.45) p(x, y, 1, 1, "#fff3a2");
    }
    if (effect === "butterflies" && i < 7) {
      const x = (sx + t * (3 + i)) % W;
      const y = 5 + sy * 0.5 + Math.sin(t * 4 + i) * 3;
      const c = i % 2 ? "#ffd784" : "#edb1db";
      p(x, y, 1, 2, c);
      p(x + 2, y, 1, 2, c);
    }
    if (effect === "embers" || effect === "lanterns") {
      const x = sx + Math.sin(t + i) * 3;
      const y = ground - ((sy + t * speed) % ground);
      if (effect === "embers") {
        p(x, y, 1, 1, "#ffcf6d");
      } else if (i < 8) {
        p(x, y, 3, 4, "#f6bd68");
        p(x + 1, y + 1, 1, 2, "#fff0a1");
      }
    }
  }
}

const CAST_COLORS: Record<Cast, string> = {
  cat: "#45354c",
  fox: "#d68d4f",
  rabbit: "#e7e4d5",
  hedgehog: "#805e48",
  frog: "#78b65e",
  chick: "#f3d775",
  penguin: "#344653",
  skeleton: "#e0e9d6",
  witch: "#80659a",
  person: "#b69c76",
  ghost: "#dfefdf",
};

function drawActor(p: Px, s: Scene, a: Actor): void {
  const t = s.time;
  const x = Math.round(a.x);
  const step = Math.floor(t * 8) % 2;
  const y = Math.round(s.ground - a.lift - 10);
  const jumping = a.lift > 0.5;
  const c = CAST_COLORS[a.type];
  switch (a.type) {
    case "ghost": {
      const gy = y + Math.sin(t * 2) * 3;
      p(x + 2, gy + 1, 6, 2, c);
      p(x, gy + 3, 10, 7, c);
      p(x + 2, gy + 5, 1, 2, "#182520");
      p(x + 7, gy + 5, 1, 2, "#182520");
      break;
    }
    case "skeleton":
      p(x + 2, y, 6, 4, c);
      p(x + 3, y + 2, 1, 1, "#162119");
      p(x + 6, y + 2, 1, 1, "#162119");
      p(x + 4, y + 4, 2, 1, c);
      p(x + 2, y + 5, 6, 1, c);
      p(x + 3, y + 6, 4, 1, c);
      p(x + 1, y + (jumping ? 3 : 5 + step), 1, 3, c);
      p(x + 8, y + (jumping ? 3 : 6 - step), 1, 3, c);
      p(x + 3 + step, y + 7, 1, 3, c);
      p(x + 6 - step, y + 7, 1, 3, c);
      break;
    case "cat":
    case "fox":
    case "rabbit":
    case "hedgehog": {
      const headX = a.dir > 0 ? x + 6 : x;
      p(x + 1, y + 5, 8, 3, c);
      p(headX, y + 3, 4, 5, c);
      if (a.type === "rabbit") {
        p(headX, y, 1, 4, c);
        p(headX + 3, y, 1, 4, c);
      } else {
        p(headX, y + 2, 2, 2, c);
        p(headX + 2, y + 2, 2, 2, c);
      }
      if (a.type === "hedgehog") {
        for (let i = 0; i < 5; i++) p(x + i * 2, y + 3 - (i % 2), 2, 3, "#a17e5a");
      }
      p(headX + (a.dir > 0 ? 3 : 0), y + 5, 1, 1, a.type === "cat" ? "#ffd267" : "#263128");
      if (a.type === "cat" || a.type === "fox") {
        p(a.dir > 0 ? x : x + 9, y + 3 + step, 2, 4, c);
      }
      p(x + 2 + step, y + 8, 2, 2, c);
      p(x + 6 - step, y + 8, 2, 2, c);
      break;
    }
    case "frog":
      p(x + 1, y + 5, 9, 5, c);
      p(x + 1, y + 3, 3, 3, c);
      p(x + 7, y + 3, 3, 3, c);
      p(x + 2, y + 4, 1, 1, "#172c1d");
      p(x + 8, y + 4, 1, 1, "#172c1d");
      break;
    case "chick":
      p(x + 2, y + 3, 7, 7, c);
      p(x + 3, y + 1, 5, 4, c);
      p(x + (a.dir > 0 ? 7 : 3), y + 4, 1, 1, "#233127");
      p(x + (a.dir > 0 ? 9 : 1), y + 6, 2, 1, "#db9142");
      break;
    case "penguin":
      p(x + 2, y + 1, 7, 9, c);
      p(x + 3, y + 4, 5, 6, "#e8ede5");
      p(x + 4, y + 3, 1, 1, "#ffffff");
      p(x + 7, y + 3, 1, 1, "#ffffff");
      p(x + 5, y + 5, 3, 1, "#e7a049");
      break;
    case "person":
    case "witch": {
      const coat = a.type === "witch" ? "#694778" : "#a17c64";
      p(x + 3, y + 1, 5, 4, "#d9ad8c");
      p(x + 2, y + 5, 7, 3, coat);
      p(x + 1, y + (jumping ? 3 : 5 + step), 2, 3, coat);
      p(x + 9, y + (jumping ? 3 : 6 - step), 2, 3, coat);
      p(x + 3 + step, y + 8, 2, 2, "#343849");
      p(x + 7 - step, y + 8, 2, 2, "#343849");
      if (a.type === "witch") {
        p(x + 1, y, 9, 2, "#34273f");
        p(x + 4, y - 4, 3, 4, "#34273f");
      } else {
        p(x + 2, y, 7, 2, "#493e39");
      }
      break;
    }
  }
}

// A 5 by 7 pixel font for the capital letters of the titles. Each glyph is
// seven rows that are joined with "/". In a row, "1" is a painted pixel and
// "0" is an empty pixel.
const FONT: Record<string, string> = {
  A: "01110/10001/10001/11111/10001/10001/10001",
  B: "11110/10001/10001/11110/10001/10001/11110",
  C: "01111/10000/10000/10000/10000/10000/01111",
  D: "11110/10001/10001/10001/10001/10001/11110",
  E: "11111/10000/10000/11110/10000/10000/11111",
  F: "11111/10000/10000/11110/10000/10000/10000",
  G: "01111/10000/10000/10111/10001/10001/01111",
  H: "10001/10001/10001/11111/10001/10001/10001",
  I: "11111/00100/00100/00100/00100/00100/11111",
  J: "00111/00010/00010/00010/10010/10010/01100",
  K: "10001/10010/10100/11000/10100/10010/10001",
  L: "10000/10000/10000/10000/10000/10000/11111",
  M: "10001/11011/10101/10101/10001/10001/10001",
  N: "10001/11001/10101/10011/10001/10001/10001",
  O: "01110/10001/10001/10001/10001/10001/01110",
  P: "11110/10001/10001/11110/10000/10000/10000",
  Q: "01110/10001/10001/10001/10101/10010/01101",
  R: "11110/10001/10001/11110/10100/10010/10001",
  S: "01111/10000/10000/01110/00001/00001/11110",
  T: "11111/00100/00100/00100/00100/00100/00100",
  U: "10001/10001/10001/10001/10001/10001/01110",
  V: "10001/10001/10001/10001/10001/01010/00100",
  W: "10001/10001/10001/10101/10101/10101/01010",
  X: "10001/10001/01010/00100/01010/10001/10001",
  Y: "10001/10001/01010/00100/00100/00100/00100",
  Z: "11111/00001/00010/00100/01000/10000/11111",
};

/** titleFor returns the title that the sign shows for `key`. */
export function titleFor(key: SceneKey): string {
  return PALETTES[key].title;
}

/** hasGlyph reports whether the font can draw `ch`. A space counts as drawable. */
export function hasGlyph(ch: string): boolean {
  return ch === " " || ch in FONT;
}

// Draws the title of the scene on a sign that is centred in the strip. The sign
// is a panel 11 scene pixels high, from row 0, with an edge line at row 0 and
// at row 10. The letters are at single size, in rows 2 to 8. The sign is high,
// so the walkers can run under it. If the sign does not fit in the width of
// the strip, the function draws nothing. A character that the font does not
// have is skipped.
function drawTitle(p: Px, s: Scene): void {
  const { title, ink, panel, edge } = PALETTES[s.key];
  const width = title.length * 6 - 1;
  if (width + 10 > s.W) return;
  const x = Math.floor((s.W - width) / 2);
  const y = 2;
  p(x - 5, y - 2, width + 10, 11, panel);
  p(x - 5, y - 2, width + 10, 1, edge);
  p(x - 5, y + 8, width + 10, 1, edge);
  for (let i = 0; i < title.length; i++) {
    const glyph = FONT[title[i]]?.split("/");
    if (!glyph) continue;
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] === "1") p(x + i * 6 + col, y + row, 1, 1, ink);
      }
    }
  }
}

/**
 * drawScene paints the scene on `ctx`. It does not clear the canvas. If the
 * scene has a script, the script paints the strip at the bottom of the canvas,
 * and drawTitle does not run, because a script draws its own CHALK sign. It sets
 * ctx.globalAlpha to the value of [sceneAlpha] for the frame, and sets it back
 * to 1 at the end. The title sign is the last item drawn, so the walkers pass
 * behind it, and it fades with the scene.
 */
export function drawScene(ctx: Painter, s: Scene): void {
  const p: Px = (x, y, w, h, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), Math.ceil(w), Math.ceil(h));
  };
  const base = sceneAlpha(s);
  ctx.globalAlpha = base;
  if (s.script) {
    // A script draws for a strip STRIP_H high, at the bottom of the canvas. Its
    // own alpha is multiplied with the alpha of the scene.
    const dy = s.H - STRIP_H;
    s.script.draw(
      (x, y, w, h, color) => p(x, y + dy, w, h, color),
      (v) => {
        ctx.globalAlpha = base * Math.max(0, Math.min(1, v));
      },
      s.W,
      s.sceneTime,
    );
    ctx.globalAlpha = 1;
    return;
  }
  drawSky(p, s);
  drawBackground(p, s);
  const at = positions(s.W);
  s.row.props.forEach((kind, i) => drawProp(p, s, kind, at[i]));
  drawEffects(p, s);
  for (const a of s.actors) drawActor(p, s, a);
  drawTitle(p, s);
  ctx.globalAlpha = 1;
}
