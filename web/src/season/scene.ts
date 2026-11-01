// chalk-web -- 129-9: the pixel scene.
//
// The scene is a small animation for the empty middle of the top header.
// Each season in THEMES has a landscape, two obstacles, two walkers, and one
// effect: fireworks, snow, petals, butterflies, fireflies, leaves, or ghosts
// with bats. The two walkers enter from the two edges and jump over the
// obstacles.
// Pure apart from the Painter it gets: no timer, no DOM, and no random source.
// The effects take their places from a hash of an index and from the time of
// the scene, so a test uses a fake Painter and gets the same picture each time.
// The component in SeasonScene.tsx owns the canvas, the clock, and the loop.
// This code is a port of a reference scene. It differs from the reference on
// purpose in these parts:
//
//   - It draws no sky fill, no haze, and no ground block. The canvas is
//     transparent, so the scene blends with all 15 themes.
//   - It draws no title panel and uses no pixel font.
//   - The ground is the bottom line of the header: ground = H - 1.

import type { SeasonId } from "./seasons";

/** SCALE is the number of CSS pixels for one pixel of the scene. */
export const SCALE = 2;

/** FPS is the number of frames the scene draws each second. */
export const FPS = 12;
const GRAVITY = 105;
const JUMP_VELOCITY = 40;

type Effect = "fireworks" | "snow" | "petals" | "butterflies" | "fireflies" | "leaves" | "ghosts";
type Landscape =
  | "city"
  | "pine"
  | "blossom"
  | "forest"
  | "meadow"
  | "harvest"
  | "graveyard"
  | "bare";
type ObstacleKind =
  | "crate"
  | "snowball"
  | "stump"
  | "flowerpot"
  | "stone"
  | "log"
  | "mushroom"
  | "hay"
  | "pumpkin"
  | "grave";
type ActorKind =
  | "person"
  | "cat"
  | "penguin"
  | "fox"
  | "rabbit"
  | "chick"
  | "frog"
  | "hedgehog"
  | "skeleton";

// What one season looks like. `edge` is the colour of the flecks on the
// ground. If `moon` is null, the scene draws a sun in its place.
interface SceneTheme {
  edge: string;
  effect: Effect;
  landscape: Landscape;
  obstacles: [ObstacleKind, ObstacleKind];
  actors: [ActorKind, ActorKind];
  stars: boolean;
  moon: string | null;
}

const SUN = null;

/** THEMES holds the look of the scene for each season, keyed by the season id. */
export const THEMES: Record<SeasonId, SceneTheme> = {
  "new-year": {
    edge: "#51658a",
    effect: "fireworks",
    landscape: "city",
    obstacles: ["crate", "crate"],
    actors: ["person", "cat"],
    stars: true,
    moon: "#d8ddd3",
  },
  winterfest: {
    edge: "#edf5ef",
    effect: "snow",
    landscape: "pine",
    obstacles: ["snowball", "stump"],
    actors: ["penguin", "fox"],
    stars: true,
    moon: "#d8ddd3",
  },
  "spring-bloom": {
    edge: "#75b568",
    effect: "petals",
    landscape: "blossom",
    obstacles: ["flowerpot", "stone"],
    actors: ["rabbit", "chick"],
    stars: false,
    moon: SUN,
  },
  "green-season": {
    edge: "#62a744",
    effect: "butterflies",
    landscape: "forest",
    obstacles: ["log", "stone"],
    actors: ["frog", "fox"],
    stars: false,
    moon: SUN,
  },
  midsummer: {
    edge: "#a8ba57",
    effect: "fireflies",
    landscape: "meadow",
    obstacles: ["stone", "flowerpot"],
    actors: ["person", "rabbit"],
    stars: false,
    moon: SUN,
  },
  "harvest-festival": {
    edge: "#b99a4a",
    effect: "leaves",
    landscape: "harvest",
    obstacles: ["mushroom", "hay"],
    actors: ["hedgehog", "fox"],
    stars: false,
    moon: SUN,
  },
  "spooky-season": {
    edge: "#3e6932",
    effect: "ghosts",
    landscape: "graveyard",
    obstacles: ["pumpkin", "grave"],
    actors: ["skeleton", "cat"],
    stars: true,
    moon: "#e6a34c",
  },
  "late-autumn": {
    edge: "#a16d35",
    effect: "leaves",
    landscape: "bare",
    obstacles: ["mushroom", "log"],
    actors: ["fox", "hedgehog"],
    stars: false,
    moon: "#d8ddd3",
  },
};

// A walker. `x` is the left edge in scene pixels. `speed` is in scene pixels
// each second. `lift` is the height above the ground, and `vy` is the speed
// of the jump. `lastObstacle` is the id of the obstacle the walker jumped
// over last, or -1.
interface Actor {
  kind: ActorKind;
  x: number;
  dir: 1 | -1;
  speed: number;
  width: number;
  lift: number;
  vy: number;
  lastObstacle: number;
}

interface Obstacle {
  id: number;
  kind: ObstacleKind;
  x: number;
  width: number;
}

/**
 * A Scene is the state of one visit. W and H are the size in scene pixels.
 * ground is the row of the ground line, H - 1. time is the seconds that
 * stepScene has added up. A visit makes a new Scene, and the state does not
 * pass from one visit to the next.
 */
export interface Scene {
  season: SeasonId;
  theme: SceneTheme;
  W: number;
  H: number;
  ground: number;
  time: number;
  actors: Actor[];
  obstacles: Obstacle[];
}

/**
 * A Painter is the part of CanvasRenderingContext2D that drawScene uses. A
 * test passes a fake that records the calls.
 */
export type Painter = Pick<CanvasRenderingContext2D, "fillStyle" | "fillRect">;

type Px = (x: number, y: number, w: number, h: number, color: string) => void;

function obstacleX(W: number, i: number): number {
  return Math.round(W * (i === 0 ? 0.2 : 0.8));
}

/**
 * createScene returns the scene for the season, W by H scene pixels. The
 * first walker starts left of the left edge and walks right. The second starts
 * right of the right edge and walks left. The two obstacles stand at 20 percent
 * and 80 percent of W.
 */
export function createScene(season: SeasonId, W: number, H: number): Scene {
  const theme = THEMES[season];
  return {
    season,
    theme,
    W,
    H,
    ground: H - 1,
    time: 0,
    actors: [
      {
        kind: theme.actors[0],
        x: -12,
        dir: 1,
        speed: 17,
        width: 9,
        lift: 0,
        vy: 0,
        lastObstacle: -1,
      },
      {
        kind: theme.actors[1],
        x: W + 12,
        dir: -1,
        speed: 21,
        width: 9,
        lift: 0,
        vy: 0,
        lastObstacle: -1,
      },
    ],
    obstacles: theme.obstacles.map((kind, i) => ({ id: i, kind, x: obstacleX(W, i), width: 9 })),
  };
}

/**
 * resizeScene changes the size of s to W by H scene pixels. It moves the
 * ground and the obstacles to fit. It does not move the walkers.
 */
export function resizeScene(s: Scene, W: number, H: number): void {
  s.W = W;
  s.H = H;
  s.ground = H - 1;
  s.obstacles.forEach((o, i) => {
    o.x = obstacleX(W, i);
  });
}

/**
 * stepScene moves the scene forward by `elapsed` seconds. A walker on the
 * ground starts a jump when an obstacle is 0 to 9 scene pixels ahead. It jumps
 * over each obstacle once for each pass. A walker that leaves one edge comes back at the
 * other edge. stepScene counts at most 0.1 s of `elapsed`, so a long frame
 * cannot throw a walker across the strip.
 */
export function stepScene(s: Scene, elapsed: number): void {
  const dt = Math.min(elapsed, 0.1);
  s.time += dt;
  for (const a of s.actors) {
    if (a.lift === 0 && a.vy === 0) {
      for (const o of s.obstacles) {
        const gap = a.dir > 0 ? o.x - (a.x + a.width) : a.x - (o.x + o.width);
        if (gap >= 0 && gap <= 9 && a.lastObstacle !== o.id) {
          a.vy = JUMP_VELOCITY;
          a.lastObstacle = o.id;
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
    if (a.dir > 0 && a.x > s.W + 12) {
      a.x = -12;
      a.lastObstacle = -1;
    }
    if (a.dir < 0 && a.x < -12) {
      a.x = s.W + 12;
      a.lastObstacle = -1;
    }
  }
}

function hash(n: number): number {
  const v = Math.sin(n * 127.1 + 78.233) * 43758.5453;
  return v - Math.floor(v);
}

function drawSky(p: Px, s: Scene): void {
  const { W, ground, theme, time } = s;
  if (theme.stars) {
    for (let i = 0; i < 29; i++) {
      const x = hash(i + 11) * W;
      const y = hash(i + 81) * (ground - 8);
      const lit = Math.floor(time * 2 + i * 0.7) % 4 === 0;
      p(x, y, 1, 1, lit ? "#b9bba0" : "#475668");
    }
  }
  const x = W - 28;
  const y = 4;
  if (theme.moon) {
    p(x + 2, y, 7, 1, theme.moon);
    p(x, y + 1, 11, 5, theme.moon);
    p(x + 2, y + 6, 7, 1, theme.moon);
    p(x + 3, y + 2, 2, 2, "#a7a493");
  } else {
    p(x + 2, y, 7, 1, "#ffda76");
    p(x, y + 1, 11, 6, "#ffda76");
    p(x + 2, y + 7, 7, 1, "#ffda76");
  }
}

function pine(p: Px, s: Scene, x: number): void {
  const g = s.ground;
  p(x + 4, g - 8, 2, 8, "#574934");
  p(x + 3, g - 17, 4, 7, "#23513f");
  p(x + 1, g - 13, 8, 5, "#24533e");
  p(x, g - 9, 10, 5, "#1b4936");
  if (s.season === "winterfest") {
    p(x + 3, g - 17, 4, 1, "#e7f3ee");
    p(x + 1, g - 13, 8, 1, "#d8e9e7");
    p(x, g - 9, 10, 1, "#d8e9e7");
  }
}

function leafyTree(p: Px, s: Scene, x: number, blossom = false): void {
  const g = s.ground;
  const c1 = blossom ? "#e59ab5" : "#315f36";
  const c2 = blossom ? "#f5c2d4" : "#468c46";
  p(x + 4, g - 12, 2, 12, "#55452c");
  p(x + 1, g - 17, 9, 8, c1);
  p(x + 3, g - 20, 5, 5, c2);
  p(x, g - 13, 11, 5, c1);
  p(x + 2, g - 15, 3, 2, c2);
}

function bareTree(p: Px, s: Scene, x: number): void {
  const g = s.ground;
  const c = "#4b342b";
  p(x + 5, g - 15, 2, 15, c);
  p(x + 2, g - 13, 3, 2, c);
  p(x + 1, g - 17, 2, 5, c);
  p(x + 7, g - 14, 4, 2, c);
  p(x + 10, g - 18, 2, 5, c);
}

function flower(p: Px, s: Scene, x: number, color: string): void {
  const y = s.ground - 5;
  p(x + 2, y + 2, 1, 3, "#31783a");
  p(x + 1, y, 3, 3, color);
  p(x + 2, y + 1, 1, 1, "#ffe28d");
}

function mushroom(p: Px, s: Scene, x: number): void {
  const y = s.ground - 6;
  p(x + 3, y + 3, 3, 3, "#e4d3a5");
  p(x + 1, y + 1, 7, 3, "#b54935");
  p(x + 3, y, 3, 1, "#cc6146");
  p(x + 3, y + 2, 1, 1, "#fff2ca");
  p(x + 6, y + 2, 1, 1, "#fff2ca");
}

function drawLandscape(p: Px, s: Scene): void {
  const { W, ground, theme } = s;
  switch (theme.landscape) {
    case "city":
      for (let i = 0; i < 6; i++) {
        const x = i < 3 ? 9 + i * 17 : W - 60 + (i - 3) * 17;
        const bh = 9 + ((i * 7) % 8);
        p(x, ground - bh, 13, bh, "#1b213a");
        for (let j = 2; j < bh - 2; j += 4) {
          p(x + 3, ground - bh + j, 2, 1, "#d6a967");
          p(x + 8, ground - bh + j, 2, 1, "#9aa5cc");
        }
      }
      break;
    case "pine":
      pine(p, s, 8);
      pine(p, s, 28);
      pine(p, s, W - 19);
      pine(p, s, W - 44);
      break;
    case "blossom":
      leafyTree(p, s, 8, true);
      leafyTree(p, s, W - 20, true);
      flower(p, s, 35, "#ffc2db");
      flower(p, s, W - 43, "#ffc2db");
      break;
    case "forest":
      leafyTree(p, s, 8);
      leafyTree(p, s, 28);
      leafyTree(p, s, W - 22);
      flower(p, s, 43, "#ffe580");
      flower(p, s, W - 42, "#f9d768");
      break;
    case "meadow":
      flower(p, s, 13, "#ffe06f");
      flower(p, s, 37, "#ffc0a1");
      flower(p, s, W - 15, "#fff1a0");
      flower(p, s, W - 44, "#ffcf62");
      break;
    case "harvest":
      bareTree(p, s, 10);
      leafyTree(p, s, W - 21);
      mushroom(p, s, 32);
      mushroom(p, s, W - 43);
      break;
    case "graveyard":
      bareTree(p, s, 10);
      bareTree(p, s, W - 20);
      p(25, ground - 6, 5, 6, "#465448");
      p(W - 39, ground - 8, 6, 8, "#465448");
      break;
    case "bare":
      bareTree(p, s, 9);
      bareTree(p, s, 31);
      bareTree(p, s, W - 19);
      mushroom(p, s, W - 42);
      break;
  }
  for (let i = 0; i < 15; i++) {
    const x = hash(i * 9 + 3) * W;
    if (s.season === "winterfest") p(x, ground - 1, 3, 1, "#e9f5f2");
    else p(x, ground - 1, 2, 1, theme.edge);
  }
}

function drawObstacle(p: Px, s: Scene, o: Obstacle): void {
  const x = o.x;
  const y = s.ground;
  switch (o.kind) {
    case "pumpkin":
      p(x + 4, y - 9, 2, 3, "#477d34");
      p(x + 1, y - 6, 8, 6, "#c86b23");
      p(x + 3, y - 7, 4, 7, "#ed8a31");
      p(x + 3, y - 4, 1, 1, "#23150e");
      p(x + 6, y - 4, 1, 1, "#23150e");
      p(x + 4, y - 2, 2, 1, "#ffe069");
      break;
    case "grave":
      p(x + 1, y - 7, 7, 7, "#44564b");
      p(x + 2, y - 8, 5, 1, "#748477");
      p(x + 4, y - 6, 1, 4, "#889b8a");
      p(x + 3, y - 5, 3, 1, "#889b8a");
      break;
    case "mushroom":
      mushroom(p, s, x);
      break;
    case "snowball":
      p(x + 2, y - 5, 5, 5, "#d8e9ed");
      p(x + 1, y - 3, 8, 3, "#f0f7f4");
      break;
    case "stump":
      p(x + 1, y - 5, 8, 5, "#765b45");
      p(x, y - 6, 10, 2, "#b49b78");
      break;
    case "log":
      p(x, y - 4, 10, 4, "#755034");
      p(x + 1, y - 3, 8, 1, "#aa7650");
      break;
    case "stone":
      p(x + 2, y - 5, 6, 5, "#788378");
      p(x, y - 3, 10, 3, "#9ba395");
      break;
    case "flowerpot":
      p(x + 3, y - 9, 1, 5, "#39854b");
      p(x + 2, y - 10, 4, 3, "#f4bd76");
      p(x + 1, y - 4, 8, 4, "#ae6448");
      break;
    case "hay":
      p(x + 1, y - 6, 8, 6, "#bd9341");
      p(x, y - 3, 10, 3, "#d4aa54");
      p(x + 4, y - 6, 1, 6, "#7b5928");
      break;
    case "crate":
      p(x, y - 6, 10, 6, "#74543e");
      p(x + 1, y - 5, 8, 4, "#ad8054");
      p(x + 2, y - 5, 1, 4, "#6b4839");
      p(x + 7, y - 5, 1, 4, "#6b4839");
      break;
  }
}

function drawParticles(p: Px, s: Scene): void {
  const { W, ground, time, theme } = s;
  const effect = theme.effect;
  if (effect === "fireworks") {
    const colors = ["#ffcf60", "#ff698f", "#8bcfff", "#b18cff"];
    for (let b = 0; b < 4; b++) {
      const phase = (time * 0.27 + b * 0.29) % 1;
      if (phase > 0.77) continue;
      const bx = b % 2 === 0 ? 25 + b * 15 : W - 30 - b * 13;
      const by = 4 + (b % 2) * 4;
      const radius = phase * 19;
      for (let i = 0; i < 12; i++) {
        const angle = (i * Math.PI) / 6;
        const x = bx + Math.cos(angle) * radius;
        const y = by + Math.sin(angle) * radius * 0.65;
        p(x, y, 1, 1, colors[(i + b) % colors.length]);
      }
    }
    return;
  }
  if (effect === "ghosts") {
    const x = W - ((time * 10 + 50) % (W + 30));
    const y = 3 + Math.sin(time * 2) * 2;
    p(x + 2, y, 6, 1, "#c6d9c7");
    p(x, y + 1, 10, 5, "#deefd9");
    p(x, y + 6, 3, 2, "#deefd9");
    p(x + 5, y + 6, 3, 2, "#deefd9");
    p(x + 2, y + 3, 1, 2, "#1b2920");
    p(x + 7, y + 3, 1, 2, "#1b2920");
    for (let i = 0; i < 2; i++) {
      const bx = ((time * (16 + i * 7) + i * 125) % (W + 20)) - 10;
      const by = 3 + i * 4 + Math.sin(time * 4 + i) * 2;
      const flap = Math.floor(time * 9 + i * 2) % 2;
      p(bx + 4, by + 2, 3, 2, "#947d9c");
      if (flap) {
        p(bx, by, 4, 1, "#947d9c");
        p(bx + 7, by, 4, 1, "#947d9c");
      } else {
        p(bx, by + 3, 4, 1, "#947d9c");
        p(bx + 7, by + 3, 4, 1, "#947d9c");
      }
    }
    return;
  }
  const count = effect === "snow" ? 35 : 18;
  for (let i = 0; i < count; i++) {
    const seedX = hash(i + 120) * W;
    const seedY = hash(i + 220) * ground;
    const speed = 3 + hash(i + 320) * 9;
    if (effect === "snow") {
      const x = (seedX + Math.sin(time + i) * 5 + W) % W;
      const y = (seedY + time * speed) % ground;
      p(x, y, 1, 1, i % 3 ? "#dcefeb" : "#ffffff");
    } else if (effect === "petals") {
      const x = (seedX + time * 4 + Math.sin(time + i) * 6) % W;
      const y = (seedY + time * speed * 0.55) % ground;
      p(x, y, 2, 1, i % 2 ? "#f6c2d6" : "#e99ebc");
    } else if (effect === "leaves") {
      const x = (seedX + time * (5 + (i % 4))) % W;
      const y = (seedY + time * speed * 0.6) % ground;
      const colors = ["#c58c36", "#a85c30", "#e2ab4b"];
      p(x + Math.sin(time * 2 + i) * 3, y, 2, 2, colors[i % colors.length]);
    } else if (effect === "fireflies") {
      const x = seedX + Math.sin(time + i * 2) * 7;
      const y = 5 + hash(i + 420) * (ground - 9) + Math.sin(time * 1.5 + i) * 2;
      if (Math.sin(time * 3 + i * 4) > 0.4) p(x, y, 1, 1, "#fff4a0");
    } else if (effect === "butterflies" && i < 5) {
      const x = (seedX + time * (4 + i)) % W;
      const y = 6 + hash(i + 210) * (ground - 12) + Math.sin(time * 3 + i) * 3;
      const color = i % 2 ? "#ffdc87" : "#b2d5a2";
      p(x, y, 1, 2, color);
      p(x + 2, y, 1, 2, color);
      p(x + 1, y + 1, 1, 1, "#445e36");
    }
  }
}

function drawActor(p: Px, s: Scene, a: Actor): void {
  const x = Math.round(a.x);
  const y = Math.round(s.ground - 10 - a.lift);
  const step = Math.floor(s.time * 8) % 2;
  const jumping = a.lift > 0.5;
  switch (a.kind) {
    case "skeleton": {
      const c = "#e0e8d1";
      p(x + 2, y, 5, 4, c);
      p(x + 3, y + 2, 1, 1, "#172018");
      p(x + 6, y + 2, 1, 1, "#172018");
      p(x + 4, y + 4, 1, 1, c);
      p(x + 2, y + 5, 5, 1, c);
      p(x + 3, y + 6, 3, 1, c);
      p(x + 4, y + 7, 1, 1, c);
      p(x + 1, y + (jumping ? 3 : 5 + step), 1, 3, c);
      p(x + 7, y + (jumping ? 3 : 6 - step), 1, 3, c);
      p(x + 3 - (jumping ? 1 : 0) + step, y + 8, 1, 2, c);
      p(x + 5 + (jumping ? 1 : 0) - step, y + 8, 1, 2, c);
      break;
    }
    case "cat":
    case "fox": {
      const c = a.kind === "cat" ? "#403248" : "#d78a4d";
      const eye = a.kind === "cat" ? "#ffd65a" : "#263023";
      const hx = a.dir > 0 ? x + 5 : x;
      p(x + 1, y + 5, 8, 3, c);
      p(hx, y + 3, 4, 4, c);
      p(hx, y + 1, 2, 3, c);
      p(hx + 2, y + 1, 2, 3, c);
      p(hx + (a.dir > 0 ? 3 : 0), y + 5, 1, 1, eye);
      p(a.dir > 0 ? x : x + 9, y + 3 + step, 1, 4, c);
      p(x + 2 + step, y + 8, 2, 2, c);
      p(x + 6 - step, y + 8, 2, 2, c);
      break;
    }
    case "rabbit": {
      const c = "#e9e4d2";
      p(x + 2, y, 2, 5, c);
      p(x + 5, y, 2, 5, c);
      p(x + 1, y + 4, 7, 4, c);
      p(x + 2, y + 7, 5, 3, c);
      p(x + (a.dir > 0 ? 6 : 2), y + 6, 1, 1, "#b36a75");
      p(x + 2 + step, y + 9, 2, 1, c);
      break;
    }
    case "penguin":
      p(x + 2, y + 1, 6, 9, "#263746");
      p(x + 3, y + 3, 4, 6, "#f1f2e7");
      p(x + 3, y + 2, 1, 1, "#ffffff");
      p(x + 6, y + 2, 1, 1, "#ffffff");
      p(x + 4, y + 4, 3, 1, "#e6a34b");
      p(x + 2 + step, y + 9, 2, 1, "#e6a34b");
      p(x + 6 - step, y + 9, 2, 1, "#e6a34b");
      break;
    case "frog": {
      const c = "#79b454";
      p(x + 1, y + 4, 8, 5, c);
      p(x + 1, y + 2, 2, 3, c);
      p(x + 7, y + 2, 2, 3, c);
      p(x + 2, y + 3, 1, 1, "#172919");
      p(x + 7, y + 3, 1, 1, "#172919");
      p(x, y + 8, 3, 2, c);
      p(x + 7, y + 8, 3, 2, c);
      break;
    }
    case "hedgehog": {
      const c = "#76543e";
      for (let i = 0; i < 7; i++) p(x + i, y + 3 - (i % 2), 2, 3, "#9d7952");
      p(x + 1, y + 5, 9, 4, c);
      p(x + (a.dir > 0 ? 8 : 1), y + 6, 1, 1, "#151613");
      p(x + 2 + step, y + 9, 2, 1, c);
      p(x + 7 - step, y + 9, 2, 1, c);
      break;
    }
    case "chick": {
      const c = "#f4d57b";
      p(x + 2, y + 3, 6, 6, c);
      p(x + 3, y + 1, 4, 4, c);
      p(x + (a.dir > 0 ? 6 : 3), y + 4, 1, 1, "#202b23");
      p(x + (a.dir > 0 ? 8 : 1), y + 5, 2, 1, "#e39551");
      p(x + 3 + step, y + 9, 1, 1, "#bb834b");
      p(x + 6 - step, y + 9, 1, 1, "#bb834b");
      break;
    }
    case "person": {
      const coat = s.season === "new-year" ? "#a07acc" : "#e6c477";
      p(x + 3, y, 4, 3, "#e4b38c");
      p(x + 2, y - 1, 6, 1, "#3a394a");
      p(x + 2, y + 3, 6, 4, coat);
      p(x + 1, y + (jumping ? 2 : 4 + step), 1, 3, coat);
      p(x + 8, y + (jumping ? 2 : 5 - step), 1, 3, coat);
      p(x + 3 + step, y + 7, 2, 3, "#30374a");
      p(x + 6 - step, y + 7, 2, 3, "#30374a");
      break;
    }
  }
}

/**
 * drawScene paints the scene with ctx.fillRect, in whole pixels. The order is
 * stars and moon or sun, landscape, obstacles, effect, walkers. It paints no
 * background, and it does not clear the canvas. The caller must clear it
 * before each frame.
 */
export function drawScene(ctx: Painter, s: Scene): void {
  const p: Px = (x, y, w, h, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), Math.ceil(w), Math.ceil(h));
  };
  drawSky(p, s);
  drawLandscape(p, s);
  for (const o of s.obstacles) drawObstacle(p, s, o);
  drawParticles(p, s);
  for (const a of s.actors) drawActor(p, s, a);
}
