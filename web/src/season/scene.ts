// chalk-web -- 129-9: the scene. 129-12: five scenes for each key, and the
// neutral key.
//
// This module draws a small pixel scene and moves it. SCENES has nine keys:
// the eight seasons of seasons.ts, and "neutral" for a date in no season. Each
// key has five rows (SCENES_PER_KEY), so there are 45 scenes. A row names an
// environment, an effect, four props, and two cast members. A scene shows its
// row for SCENE_SECONDS. Then it shows the next row of the same key, and the
// first row comes after the last.
// Pure: the module uses no timer, no DOM, and no random source. The Painter is
// a parameter. Each effect takes its places from a hash of an index and from
// the time of the scene. So a test uses a fake Painter and gets the same
// picture each time. SeasonScene.tsx owns the loop and the start index.
// The scene differs from the engine that the user supplied, on purpose:
//   - It paints no sky, no haze, no earth block, no title, no panel, and no
//     pixel font. The canvas stays transparent, so the scene blends with all
//     themes. It draws no stars and no moon, because the supplied engine has
//     none.
//   - The ground is H - 1. The bottom line of the header is the ground.
//     Scattered tufts of grass on the ground stay.
//   - It has no preview API on window, because that would be a global in
//     production.
//   - A scene fades to transparent, not to black.

import type { SeasonId } from "./seasons";

/** SCALE is the number of CSS pixels in one scene pixel. */
export const SCALE = 2;

/** FPS is the number of frames each second that the component paints. */
export const FPS = 12;

/** SCENE_SECONDS is the time in seconds that a scene shows one row before it rotates. */
export const SCENE_SECONDS = 35;

/**
 * FADE_SECONDS is the length in seconds of the fade at the end of a row, and
 * of the fade in after a rotation. See [sceneAlpha].
 */
export const FADE_SECONDS = 0.7;

/** SCENES_PER_KEY is the number of rows that each key of SCENES has. */
export const SCENES_PER_KEY = 5;

// The downward pull on a jump, and the upward speed at the start of a jump, in
// scene pixels and seconds.
const GRAVITY = 105;
const JUMP = 40;

/**
 * A SceneKey names a set of five scenes: a season id, or "neutral" for a date
 * in no season.
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
type Prop =
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
 * right edge.
 */
export interface SceneRow {
  name: string;
  environment: Environment;
  effect: Effect;
  props: [Prop, Prop, Prop, Prop];
  cast: [Cast, Cast];
}

function row(
  name: string,
  environment: Environment,
  effect: Effect,
  props: [Prop, Prop, Prop, Prop],
  cast: [Cast, Cast],
): SceneRow {
  return { name, environment, effect, props, cast };
}

/**
 * SCENES holds the rows of each key, in the order of rotation. Each key has
 * SCENES_PER_KEY rows. Two names promise what the scene does not draw: Cabin
 * Smoke has no smoke, and Bridge Walk has no bridge.
 */
export const SCENES: Record<SceneKey, SceneRow[]> = {
  "new-year": [
    row("Midnight Skyline", "city", "fireworks", ["tower", "crate", "barrel", "lamp"], ["person", "cat"]),
    row("Rooftop Countdown", "city", "confetti", ["clock", "crate", "gift", "flag"], ["person", "fox"]),
    row("Harbor Lights", "lake", "fireworks", ["boat", "barrel", "crate", "lamp"], ["person", "cat"]),
    row("Town Celebration", "town", "confetti", ["house", "gift", "crate", "lantern"], ["person", "rabbit"]),
    row("First Sunrise", "hills", "sparkles", ["tree", "stone", "log", "flag"], ["fox", "person"]),
  ],
  winterfest: [
    row("Snowy Pines", "forest", "snow", ["pine", "snowball", "log", "pine"], ["penguin", "fox"]),
    row("Cabin Smoke", "town", "snow", ["cabin", "snowball", "stump", "pine"], ["fox", "rabbit"]),
    row("Frozen Lake", "lake", "snow", ["pine", "ice", "snowball", "snowman"], ["penguin", "cat"]),
    row("Aurora Ridge", "mountain", "aurora", ["pine", "stone", "snowball", "pine"], ["fox", "penguin"]),
    row("Lantern Walk", "forest", "snow", ["lantern", "snowball", "stump", "snowman"], ["person", "fox"]),
  ],
  "spring-bloom": [
    row("Cherry Blossom", "orchard", "petals", ["cherry", "flowerpot", "stone", "cherry"], ["rabbit", "chick"]),
    row("Rain Garden", "garden", "rain", ["tree", "flowerpot", "log", "flower"], ["frog", "rabbit"]),
    row("Pond Hopping", "lake", "butterflies", ["reeds", "stone", "flowerpot", "reeds"], ["frog", "chick"]),
    row("Flower Trail", "meadow", "petals", ["flower", "flowerpot", "stone", "flower"], ["rabbit", "fox"]),
    row("Butterfly Orchard", "orchard", "butterflies", ["cherry", "log", "flowerpot", "cherry"], ["chick", "rabbit"]),
  ],
  "green-season": [
    row("Deep Woods", "forest", "fireflies", ["tree", "log", "stone", "tree"], ["fox", "cat"]),
    row("Stream Crossing", "lake", "butterflies", ["reeds", "log", "stone", "tree"], ["frog", "fox"]),
    row("Fern Garden", "garden", "fireflies", ["flower", "flowerpot", "log", "tree"], ["frog", "rabbit"]),
    row("Hillside Run", "hills", "butterflies", ["tree", "stone", "log", "tree"], ["rabbit", "fox"]),
    row("Summer Rain", "forest", "rain", ["tree", "log", "stump", "tree"], ["frog", "cat"]),
  ],
  midsummer: [
    row("Golden Meadow", "meadow", "butterflies", ["flower", "stone", "flowerpot", "flower"], ["rabbit", "fox"]),
    row("Lakeside Sunset", "lake", "fireflies", ["reeds", "log", "stone", "reeds"], ["frog", "person"]),
    row("Campfire Evening", "forest", "embers", ["pine", "log", "stone", "campfire"], ["person", "fox"]),
    row("Firefly Night", "hills", "fireflies", ["tree", "stone", "log", "tree"], ["cat", "rabbit"]),
    row("Festival Lanterns", "town", "lanterns", ["lantern", "crate", "flowerpot", "lantern"], ["person", "chick"]),
  ],
  "harvest-festival": [
    row("Mushroom Grove", "forest", "leaves", ["tree", "mushroom", "log", "tree"], ["hedgehog", "fox"]),
    row("Apple Orchard", "orchard", "leaves", ["appletree", "basket", "crate", "appletree"], ["fox", "rabbit"]),
    row("Hayfield Run", "farm", "leaves", ["hay", "hay", "crate", "scarecrow"], ["hedgehog", "person"]),
    row("Village Market", "town", "sparkles", ["stall", "basket", "mushroom", "lantern"], ["person", "fox"]),
    row("Golden Fields", "farm", "leaves", ["scarecrow", "stump", "hay", "windmill"], ["fox", "hedgehog"]),
  ],
  "spooky-season": [
    row("Old Graveyard", "graveyard", "ghosts", ["bare", "grave", "pumpkin", "bare"], ["skeleton", "cat"]),
    row("Haunted Manor", "town", "bats", ["manor", "grave", "pumpkin", "bare"], ["skeleton", "ghost"]),
    row("Witchwood", "forest", "bats", ["bare", "mushroom", "cauldron", "bare"], ["witch", "cat"]),
    row("Foggy Marsh", "swamp", "fog", ["bare", "stone", "grave", "reeds"], ["ghost", "skeleton"]),
    row("Pumpkin Patch", "farm", "ghosts", ["pumpkin", "pumpkin", "pumpkin", "scarecrow"], ["cat", "witch"]),
  ],
  "late-autumn": [
    row("Windy Avenue", "orchard", "leaves", ["bare", "log", "stone", "bare"], ["fox", "hedgehog"]),
    row("Rainy Village", "town", "rain", ["house", "crate", "mushroom", "lantern"], ["cat", "person"]),
    row("Forest Floor", "forest", "leaves", ["bare", "mushroom", "stump", "bare"], ["hedgehog", "fox"]),
    row("Creek Crossing", "lake", "fog", ["bare", "stone", "log", "reeds"], ["fox", "rabbit"]),
    row("Lantern Path", "hills", "embers", ["lantern", "stump", "stone", "bare"], ["person", "cat"]),
  ],
  neutral: [
    row("Green Alley", "town", "sparkles", ["lamp", "crate", "log", "house"], ["person", "cat"]),
    row("Quiet Forest", "forest", "fireflies", ["tree", "log", "stone", "tree"], ["fox", "rabbit"]),
    row("Little Workshop", "town", "sparkles", ["house", "crate", "barrel", "lamp"], ["person", "cat"]),
    row("Bridge Walk", "lake", "fireflies", ["reeds", "stone", "log", "reeds"], ["frog", "fox"]),
    row("Morning Hills", "hills", "clouds", ["tree", "stone", "log", "tree"], ["rabbit", "chick"]),
  ],
};

// The colours of the ground tufts and of the hills, meadow, and farm, for each key.
const PALETTES: Record<SceneKey, { earth: string; edge: string }> = {
  "new-year": { earth: "#29344d", edge: "#576d95" },
  winterfest: { earth: "#b3cdd4", edge: "#e6f4f0" },
  "spring-bloom": { earth: "#467849", edge: "#81ba70" },
  "green-season": { earth: "#285b33", edge: "#68a94e" },
  midsummer: { earth: "#607c35", edge: "#afbd60" },
  "harvest-festival": { earth: "#64512c", edge: "#b49a4c" },
  "spooky-season": { earth: "#152d1d", edge: "#467442" },
  "late-autumn": { earth: "#493d30", edge: "#a27743" },
  neutral: { earth: "#193d28", edge: "#397a4b" },
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
 * `index` pick the current row, `row`. `time` is the time of the scene in
 * seconds, and `sceneTime` is the time since the current row started.
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
  actors: Actor[];
  obstacles: Obstacle[];
}

/**
 * A Painter is the part of CanvasRenderingContext2D that drawScene uses, so a
 * test can pass a fake.
 */
export type Painter = Pick<CanvasRenderingContext2D, "fillStyle" | "fillRect" | "globalAlpha">;

type Px = (x: number, y: number, w: number, h: number, color: string) => void;

// The x places of the four props of a row, from left to right. The two inner
// places, at 20 percent and 80 percent of the width, hold the obstacles. The
// outer places are at fixed distances from the edges, where the walkers enter.
// The walkers jump over the inner props only.
function positions(W: number): number[] {
  return [12, Math.round(W * 0.2), Math.round(W * 0.8), W - 24];
}

// Loads the row at s.index. The walkers go back to the edges and the row timer
// starts again. The props at index 1 and 2 become the obstacles. The props at
// index 0 and 3 stand next to the edges, so they are not obstacles.
function loadRow(s: Scene): void {
  s.row = SCENES[s.key][s.index];
  s.sceneTime = 0;
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
 * starts at the row `index`. An index outside 0 to SCENES_PER_KEY - 1 wraps
 * around, also a negative one.
 */
export function createScene(key: SceneKey, W: number, H: number, index = 0): Scene {
  const start = ((index % SCENES_PER_KEY) + SCENES_PER_KEY) % SCENES_PER_KEY;
  const s: Scene = {
    key,
    index: start,
    row: SCENES[key][start],
    W,
    H,
    ground: H - 1,
    time: 0,
    sceneTime: 0,
    rotations: 0,
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
 * has shown for SCENE_SECONDS, the scene rotates to the next row of its key,
 * and the walkers start again at the edges.
 */
export function stepScene(s: Scene, elapsed: number): void {
  const dt = Math.min(elapsed, 0.1);
  s.time += dt;
  s.sceneTime += dt;
  if (s.sceneTime >= SCENE_SECONDS) {
    s.index = (s.index + 1) % SCENES_PER_KEY;
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
 * during the first FADE_SECONDS of the new row. The first row of a scene does
 * not fade in, so a frame at time zero is whole when the system asks for
 * reduced motion. The CSS fade of the canvas covers the start of the visit.
 */
export function sceneAlpha(s: Scene): number {
  const out = (SCENE_SECONDS - s.sceneTime) / FADE_SECONDS;
  const into = s.rotations > 0 ? s.sceneTime / FADE_SECONDS : 1;
  return Math.max(0, Math.min(1, into, out));
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
      p(x, ground - 14, 10, 8, env === "orchard" ? "#49604d" : "#264635");
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
    p(0, ground - 4, W, 4, env === "lake" ? "#284f61" : "#2a4940");
    for (let i = 0; i < 20; i++) {
      p((i * 31) % W, ground - 3 + (i % 2), 5, 1, "#739087");
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
      p(x, y - height, width, height, big ? "#303047" : brown);
      p(x - 2, y - height - 3, width + 4, 3, "#413b45");
      p(x + 3, y - height + 3, 3, 3, "#efc574");
      p(x + width - 6, y - height + 3, 3, 3, "#efc574");
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
        p(x + 8, y - 20, 2, 12, "#dac9a0");
        p(x + 3, y - 15, 12, 2, "#dac9a0");
      }
      break;
    case "lamp":
    case "lantern":
      p(x + 5, y - 14, 2, 14, "#6b6951");
      p(x + 3, y - 16, 6, 5, "#f4bb64");
      p(x + 4, y - 15, 4, 3, "#ffe19b");
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
      p(x + 5, y - 2, 3, 1, "#ffdb67");
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
      p(x + 5, y - 8, 4, 6, "#f3ae3e");
      p(x + 6, y - 6, 2, 4, "#ffe48b");
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

/**
 * drawScene paints the scene on `ctx`. It does not clear the canvas. It sets
 * ctx.globalAlpha to the value of [sceneAlpha] for the frame, and sets it back
 * to 1 at the end.
 */
export function drawScene(ctx: Painter, s: Scene): void {
  const p: Px = (x, y, w, h, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), Math.ceil(w), Math.ceil(h));
  };
  ctx.globalAlpha = sceneAlpha(s);
  drawBackground(p, s);
  const at = positions(s.W);
  s.row.props.forEach((kind, i) => drawProp(p, s, kind, at[i]));
  drawEffects(p, s);
  for (const a of s.actors) drawActor(p, s, a);
  ctx.globalAlpha = 1;
}
