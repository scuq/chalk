// 129-9: tests for the scene. 129-12: five scenes for each of eight row keys.
// The neutral key has ten scripts since 129-18, the christmas key has seven
// scripts since 129-19, the new-year key has seven scripts since 129-20, and
// the winterfest key has eight scripts since 129-21, and the black-week key
// has nine scripts since 129-22, and the late-autumn key has seven scripts since
// 129-23.
//
// A fake Painter records the rectangles, so a test needs no canvas. The tests
// check the table (73 scenes: the rows of the SEASONS ids except "christmas",
// "new-year", "winterfest", "black-week", and "late-autumn", the ten scripts of
// "neutral", the seven scripts of "christmas", the seven scripts of "new-year",
// the eight scripts of "winterfest", the nine scripts of "black-week", and the
// seven scripts of "late-autumn"), whole
// pixels and a see-through strip in every scene of a season, a paint for
// each prop, the rotation and its wrap, the fade, a start index outside the
// range, the walkers, a ghost that floats, a long frame, and a resize. 129-13:
// the title of each key, the font, the sign, and a strip that is too narrow.
// 129-14: a walker under the sign, water and no ice in a warm season, the named
// detail (blossom), and no animal out of season.
// 129-15: a scene that does not rotate holds its row and has no fade.
// 129-18: sceneCount gives 10 for "neutral". The ten off-season scripts draw
// whole pixels, in a budget of rectangles, at three widths. A script holds
// through a visit, a rotating script moves on to the next one, and the fade of
// a rotating scene caps the alpha of a script. A script draws at the bottom of
// a taller canvas. holdStill moves a script to its still frame, which is inside
// its loop.
// 129-19: sceneCount gives 7 for "christmas". The christmas key runs its
// scripts and holds one through a visit.
// 129-20: sceneCount gives 7 for "new-year". The script tests run over all three
// sets of scripts. The prop test checks the eight props that no row uses. The
// new-year key runs its scripts and holds one through a visit.
// 129-21: sceneCount gives 8 for "winterfest". The script tests run over all
// four sets of scripts. The prop test checks the twelve props that no row uses.
// The winterfest key runs its scripts and holds one through a visit.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createScene,
  drawScene,
  FADE_SECONDS,
  hasGlyph,
  holdStill,
  sceneWeights,
  resizeScene,
  SCENE_SECONDS,
  SCENES,
  SCENES_PER_KEY,
  sceneAlpha,
  sceneCount,
  stepScene,
  titleFor,
  type Painter,
  type SceneKey,
} from "./scene";
import { CHRISTMAS } from "./christmas";
import { NEWYEAR } from "./newyear";
import { WINTERFEST } from "./winterfest";
import { BLACKWEEK } from "./blackweek";
import { LATEAUTUMN } from "./lateautumn";
import { OFFSEASON } from "./offseason";
import type { Script } from "./strip";
import { SEASONS } from "./seasons";

const W = 300;
const H = 24;
const KEYS = Object.keys(SCENES) as SceneKey[];
const ALL_KEYS: SceneKey[] = [...KEYS, "neutral", "christmas", "new-year", "winterfest", "black-week", "late-autumn"];
// 129-19: the keys that run scripts, with their scripts.
const SCRIPT_SETS: [SceneKey, Script[]][] = [
  ["neutral", OFFSEASON],
  ["christmas", CHRISTMAS],
  ["new-year", NEWYEAR],
  ["winterfest", WINTERFEST],
  ["black-week", BLACKWEEK],
  ["late-autumn", LATEAUTUMN],
];

function recorder() {
  const rects: { x: number; y: number; w: number; h: number; color: string }[] = [];
  const ctx: Painter = {
    fillStyle: "",
    globalAlpha: 1,
    fillRect(x, y, w, h) {
      rects.push({ x, y, w, h, color: String(ctx.fillStyle) });
    },
  };
  return { ctx, rects };
}

test("there are 73 scenes: five rows for each row season, and the scripts of the six script keys", () => {
  const ids = new Set<string>(SEASONS.map((s) => s.id));
  ids.delete("christmas");
  ids.delete("new-year");
  ids.delete("winterfest");
  ids.delete("black-week");
  ids.delete("late-autumn");
  assert.deepEqual(new Set(KEYS), ids);
  assert.equal(KEYS.length, 5);
  for (const key of KEYS) {
    assert.equal(SCENES[key as keyof typeof SCENES].length, SCENES_PER_KEY, key);
    assert.equal(sceneCount(key), SCENES_PER_KEY, key);
  }
  assert.equal(sceneCount("neutral"), 10);
  assert.equal(sceneCount("christmas"), 7);
  assert.equal(sceneCount("new-year"), 7);
  assert.equal(sceneCount("winterfest"), 8);
  assert.equal(sceneCount("black-week"), 9);
  assert.equal(sceneCount("late-autumn"), 7);
  const names = [
    ...KEYS.flatMap((k) => SCENES[k as keyof typeof SCENES].map((r) => r.name)),
    ...OFFSEASON.map((x) => x.name),
    ...CHRISTMAS.map((x) => x.name),
    ...NEWYEAR.map((x) => x.name),
    ...WINTERFEST.map((x) => x.name),
    ...BLACKWEEK.map((x) => x.name),
    ...LATEAUTUMN.map((x) => x.name),
  ];
  assert.equal(names.length, 73);
  assert.equal(new Set(names).size, 73);
});

test("every scene draws whole pixels and leaves the strip see-through, at each step", () => {
  for (const key of KEYS) {
    for (let index = 0; index < SCENES_PER_KEY; index++) {
      const scene = createScene(key, W, H, index);
      for (let i = 0; i < 240; i++) {
        stepScene(scene, 1 / 12);
        const { ctx, rects } = recorder();
        drawScene(ctx, scene);
        assert.equal(ctx.globalAlpha, 1, "the alpha leaks past the frame");
        assert.ok(rects.length > 0, `${scene.row.name} drew nothing`);
        for (const r of rects) {
          for (const n of [r.x, r.y, r.w, r.h]) assert.ok(Number.isInteger(n), `${scene.row.name}: ${n}`);
          assert.ok(!(r.w >= W && r.h >= H), `${scene.row.name} filled the strip`);
        }
      }
    }
  }
});

test("each prop paints something of its own", () => {
  const used = new Set(KEYS.flatMap((k) => SCENES[k as keyof typeof SCENES].flatMap((r) => r.props)));
  assert.equal(used.size, 25);
  // 129-18, 129-20, 129-21, 129-23: no row uses these props since the neutral,
  // new-year, winterfest, and late-autumn rows became scripts. They stay in the
  // set of props, so each paint is still checked.
  const unused = ["barrel", "boat", "bridge", "cabin", "clock", "flag", "gift", "house", "ice", "lamp", "snowball", "snowman", "tower"] as const;
  for (const kind of unused) assert.ok(!used.has(kind), kind);
  const kinds = new Set([...used, ...unused]);
  assert.equal(kinds.size, 38);
  const bare = createScene("midsummer", W, H);
  bare.row = { ...bare.row, props: [] as never };
  const base = recorder();
  drawScene(base.ctx, bare);
  for (const kind of kinds) {
    const scene = createScene("midsummer", W, H);
    scene.row = { ...scene.row, props: [kind, kind, kind, kind] };
    const one = recorder();
    drawScene(one.ctx, scene);
    assert.ok(one.rects.length > base.rects.length, kind);
  }
});

test("the scene rotates after 35 seconds, wraps, and keeps the key", () => {
  const scene = createScene("midsummer", W, H, 4);
  assert.equal(scene.row.name, "Festival Lanterns");
  for (let t = 0; t < SCENE_SECONDS; t += 0.1) stepScene(scene, 0.1);
  stepScene(scene, 0.1);
  assert.equal(scene.index, 0);
  assert.equal(scene.key, "midsummer");
  assert.equal(scene.row.name, "Golden Meadow");
  assert.equal(scene.rotations, 1);
});

test("a rotation brings the walkers back to the edges", () => {
  const scene = createScene("midsummer", W, H);
  for (let t = 0; t < SCENE_SECONDS + 0.2; t += 0.1) stepScene(scene, 0.1);
  assert.ok(scene.actors[0].x < 0);
  assert.ok(scene.actors[1].x > W - 10);
});

test("a first scene is whole at once, a rotation fades in, and each scene fades out", () => {
  const scene = createScene("midsummer", W, H);
  assert.equal(sceneAlpha(scene), 1);
  scene.sceneTime = SCENE_SECONDS - FADE_SECONDS / 2;
  assert.ok(Math.abs(sceneAlpha(scene) - 0.5) < 1e-9);
  scene.rotations = 1;
  scene.sceneTime = 0;
  assert.equal(sceneAlpha(scene), 0);
  scene.sceneTime = FADE_SECONDS / 2;
  assert.ok(Math.abs(sceneAlpha(scene) - 0.5) < 1e-9);
});

test("129-15: a visit holds one row, with no rotation and no fade", () => {
  const scene = createScene("midsummer", W, H, 2, false);
  for (let t = 0; t < 80; t += 0.1) {
    stepScene(scene, 0.1);
    assert.equal(sceneAlpha(scene), 1);
  }
  assert.equal(scene.index, 2);
  assert.equal(scene.rotations, 0);
  assert.equal(scene.row.name, "Campfire Evening");
});

test("each season has its title, and the font holds every letter", () => {
  assert.equal(titleFor("spooky-season"), "SPOOKY SEASON");
  assert.equal(titleFor("neutral"), "CHALK");
  const titles = KEYS.map(titleFor);
  assert.equal(new Set(titles).size, KEYS.length);
  for (const title of titles) {
    for (const ch of title) assert.ok(hasGlyph(ch), `${title}: ${ch}`);
  }
});

test("the title sits on a centred sign, painted after the walkers", () => {
  const scene = createScene("harvest-festival", W, H);
  scene.actors[0].x = W / 2;
  const { ctx, rects } = recorder();
  drawScene(ctx, scene);
  const panel = rects.findIndex((r) => r.color === "#453423");
  assert.ok(panel >= 0, "no title sign");
  const width = "HARVEST FESTIVAL".length * 6 - 1 + 10;
  assert.equal(rects[panel].w, width);
  assert.equal(rects[panel].h, 11);
  assert.equal(rects[panel].y, 0);
  assert.equal(rects[panel].x, Math.floor((W - (width - 10)) / 2) - 5);
  assert.ok(rects[panel].y + rects[panel].h <= H);
  const ink = rects.filter((r) => r.color === "#ffdc92");
  assert.ok(ink.length > 50, "no letters");
  assert.ok(rects.slice(0, panel).some((r) => r.color === "#d68d4f"), "the walkers are not under the sign");
});

test("a walker runs under the sign without touching it", () => {
  const scene = createScene("midsummer", W, H);
  const a = scene.actors[0];
  assert.ok(a.lift === 0);
  const top = scene.ground - 10;
  assert.ok(top >= 11, `a walker's head reaches row ${top}, and the sign ends at row 10`);
});

test("a warm season has water and no ice", () => {
  const colors = (key: SceneKey, index: number) => {
    const scene = createScene(key, W, H, index);
    const { ctx, rects } = recorder();
    drawScene(ctx, scene);
    return new Set(rects.map((r) => r.color));
  };
  assert.ok(colors("midsummer", 1).has("#284f61"), "Lakeside Sunset has no water");
  assert.ok(!colors("midsummer", 1).has("#a9cfdc"));
});

test("a named thing is drawn: the blossom", () => {
  const colors = (key: SceneKey, index: number) => {
    const scene = createScene(key, W, H, index);
    const { ctx, rects } = recorder();
    drawScene(ctx, scene);
    return new Set(rects.map((r) => r.color));
  };
  assert.ok(colors("spring-bloom", 0).has("#d99ab4"), "no blossom in the orchard");
  assert.ok(!colors("harvest-festival", 0).has("#d99ab4"));
});

test("no animal is out of season", () => {
  const cast = (key: SceneKey) => new Set(SCENES[key as keyof typeof SCENES].flatMap((r) => r.cast));
  assert.ok(!cast("midsummer").has("chick"));
});

test("a strip too narrow for the title leaves it out", () => {
  const scene = createScene("harvest-festival", 60, H);
  const { ctx, rects } = recorder();
  drawScene(ctx, scene);
  assert.ok(!rects.some((r) => r.color === "#453423"));
});

test("a title fades with its scene", () => {
  const scene = createScene("midsummer", W, H);
  scene.rotations = 1;
  scene.sceneTime = FADE_SECONDS / 2;
  const seen: number[] = [];
  const ctx: Painter = {
    fillStyle: "",
    globalAlpha: 1,
    fillRect() {
      seen.push(ctx.globalAlpha);
    },
  };
  drawScene(ctx, scene);
  assert.ok(seen.every((a) => Math.abs(a - 0.5) < 1e-9));
});

test("a start index outside the range still picks a scene", () => {
  assert.equal(createScene("midsummer", W, H, 7).index, 2);
  assert.equal(createScene("midsummer", W, H, -1).index, 4);
  assert.equal(createScene("neutral", W, H, 12).index, 2);
  assert.equal(createScene("neutral", W, H, -1).index, 9);
});

test("the walkers enter from the edges and walk in opposite directions", () => {
  const scene = createScene("spooky-season", W, H);
  assert.ok(scene.actors[0].x < 0);
  assert.ok(scene.actors[1].x > W);
  stepScene(scene, 0.1);
  assert.ok(scene.actors[0].x > -14);
  assert.ok(scene.actors[1].x < W + 14);
});

test("a walker jumps over an obstacle, lands, and comes back around", () => {
  const scene = createScene("midsummer", W, H);
  const a = scene.actors[0];
  let peak = 0;
  for (let i = 0; i < 120; i++) {
    stepScene(scene, 0.1);
    peak = Math.max(peak, a.lift);
    assert.ok(a.lift >= 0);
  }
  assert.ok(peak > 3, `peak ${peak}`);
  assert.ok(a.x >= -14 && a.x <= W + 14);
});

test("a ghost floats past an obstacle and never jumps", () => {
  const scene = createScene("spooky-season", W, H, 3);
  const ghost = scene.actors[0];
  assert.equal(ghost.type, "ghost");
  for (let i = 0; i < 120; i++) {
    stepScene(scene, 0.1);
    assert.equal(scene.actors[0].lift, 0);
  }
});

test("a long frame cannot throw a walker across the strip", () => {
  const scene = createScene("midsummer", W, H);
  const before = scene.actors[0].x;
  stepScene(scene, 60);
  assert.ok(scene.actors[0].x - before <= 17 * 0.1 + 0.001);
});

test("a resize moves the ground and the obstacles", () => {
  const scene = createScene("midsummer", W, H);
  resizeScene(scene, 100, 16);
  assert.equal(scene.ground, 15);
  assert.equal(scene.obstacles[0].x, 20);
  assert.equal(scene.obstacles[1].x, 80);
});

test("a very narrow strip still draws every scene", () => {
  for (const key of ALL_KEYS) {
    for (let index = 0; index < sceneCount(key); index++) {
      const scene = createScene(key, 40, 16, index);
      stepScene(scene, 1 / 12);
      drawScene(recorder().ctx, scene);
    }
  }
});

// 129-18: the off-season scripts.

test("129-18: each script draws whole pixels, on a budget, over its full loop", () => {
  for (const wide of [150, 300, 460]) {
    for (const [key, scripts] of SCRIPT_SETS) scripts.forEach((script, index) => {
      const scene = createScene(key, wide, H, index, false);
      assert.equal(scene.script, script);
      assert.equal(scene.row.name, script.name);
      for (let t = 0; t < Math.min(script.period, 30) + 1; t += 1 / 12) {
        stepScene(scene, 1 / 12);
        const alphas: number[] = [];
        const { ctx, rects } = recorder();
        const fill = ctx.fillRect;
        ctx.fillRect = (x, y, w, h) => {
          alphas.push(ctx.globalAlpha);
          fill(x, y, w, h);
        };
        drawScene(ctx, scene);
        assert.equal(ctx.globalAlpha, 1, `${script.name}: the alpha leaks past the frame`);
        assert.ok(rects.length > 0, `${script.name} drew nothing`);
        assert.ok(rects.length < 6000, `${script.name} at ${wide}: ${rects.length} rectangles in one frame`);
        for (const a of alphas) assert.ok(a >= 0 && a <= 1, `${script.name}: alpha ${a}`);
        for (const r of rects) {
          for (const n of [r.x, r.y, r.w, r.h]) assert.ok(Number.isInteger(n), `${script.name}: ${n}`);
          assert.ok(r.w >= 0 && r.h >= 0, `${script.name}: a negative size`);
        }
      }
    });
  }
});

test("129-18: a script holds through a visit and does not rotate", () => {
  const scene = createScene("neutral", W, H, 4, false);
  for (let t = 0; t < 80; t += 0.1) stepScene(scene, 0.1);
  assert.equal(scene.index, 4);
  assert.equal(scene.rotations, 0);
  assert.equal(scene.row.name, "The Gate");
});

test("129-18: a rotating neutral scene moves on to the next script", () => {
  const scene = createScene("neutral", W, H, 9);
  for (let t = 0; t < SCENE_SECONDS; t += 0.1) stepScene(scene, 0.1);
  stepScene(scene, 0.1);
  assert.equal(scene.index, 0);
  assert.equal(scene.script, OFFSEASON[0]);
});

test("129-18: the fade of a rotating scene caps the alpha of a script", () => {
  const scene = createScene("neutral", W, H, 0);
  scene.rotations = 1;
  scene.sceneTime = FADE_SECONDS / 2;
  const seen: number[] = [];
  const ctx: Painter = {
    fillStyle: "",
    globalAlpha: 1,
    fillRect() {
      seen.push(ctx.globalAlpha);
    },
  };
  drawScene(ctx, scene);
  assert.ok(seen.length > 0);
  assert.ok(seen.every((a) => a <= 0.5 + 1e-9), "a script drew brighter than its fade");
  assert.equal(ctx.globalAlpha, 1);
});

test("129-18: a canvas taller than the strip draws the script at the bottom", () => {
  const scene = createScene("neutral", W, 30, 1, false);
  const { ctx, rects } = recorder();
  drawScene(ctx, scene);
  assert.ok(rects.every((r) => r.y >= 6), "a script drew above its strip");
});

test("129-18: a still frame is inside the loop of its script", () => {
  for (const [key, scripts] of SCRIPT_SETS) scripts.forEach((script, index) => {
    assert.ok(script.still >= 0 && script.still < script.period, script.name);
    const scene = createScene(key, W, H, index, false);
    holdStill(scene);
    assert.equal(scene.sceneTime, script.still);
  });
  const row = createScene("midsummer", W, H);
  holdStill(row);
  assert.equal(row.sceneTime, 0);
});

test("129-19: the christmas key runs its scripts and holds one through a visit", () => {
  const scene = createScene("christmas", W, H, 3, false);
  assert.equal(scene.script, CHRISTMAS[3]);
  assert.equal(scene.row.name, "Robot Santa");
  for (let t = 0; t < 80; t += 0.1) stepScene(scene, 0.1);
  assert.equal(scene.index, 3);
  assert.equal(createScene("christmas", W, H, 9).index, 2);
});

test("129-20: the new-year key runs its scripts and holds one through a visit", () => {
  const scene = createScene("new-year", W, H, 0, false);
  assert.equal(scene.script, NEWYEAR[0]);
  assert.equal(scene.row.name, "Year 3000");
  for (let t = 0; t < 80; t += 0.1) stepScene(scene, 0.1);
  assert.equal(scene.index, 0);
});

test("129-21: the winterfest key runs its scripts and holds one through a visit", () => {
  const scene = createScene("winterfest", W, H, 0, false);
  assert.equal(scene.script, WINTERFEST[0]);
  assert.equal(scene.row.name, "The Walker Falls");
  for (let t = 0; t < 80; t += 0.1) stepScene(scene, 0.1);
  assert.equal(scene.index, 0);
});

test("129-22: the bar weighs twice as much as each other black week scene, and every other key weighs one", () => {
  const w = sceneWeights("black-week");
  assert.equal(w.length, 9);
  assert.equal(w[0], 2);
  assert.ok(w.slice(1).every((v) => v === 1));
  for (const key of ALL_KEYS) {
    if (key === "black-week") continue;
    assert.ok(sceneWeights(key).every((v) => v === 1), key);
    assert.equal(sceneWeights(key).length, sceneCount(key), key);
  }
});

test("129-23: the late-autumn key runs its scripts and holds one through a visit", () => {
  const scene = createScene("late-autumn", W, H, 3, false);
  assert.equal(scene.script, LATEAUTUMN[3]);
  assert.equal(scene.row.name, "The Vineyard");
  for (let t = 0; t < 80; t += 0.1) stepScene(scene, 0.1);
  assert.equal(scene.index, 3);
});
