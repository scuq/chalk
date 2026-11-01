// 129-9: tests for the scene. 129-12: five scenes for each of nine keys.
//
// A fake Painter records the rectangles, so a test needs no canvas. The tests
// check the table (45 scenes, nine keys, the same ids as SEASONS plus
// "neutral"), whole pixels and a see-through strip in every scene, a paint for
// each prop, the rotation and its wrap, the fade, a start index outside the
// range, the walkers, a ghost that floats, a long frame, and a resize. 129-13:
// the title of each key, the font, the sign, and a strip that is too narrow.
// 129-14: a walker under the sign, snow and ice in the cold seasons, the named
// details (sunrise, smoke, bridge, blossom), and no animal out of season.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createScene,
  drawScene,
  FADE_SECONDS,
  hasGlyph,
  resizeScene,
  SCENE_SECONDS,
  SCENES,
  SCENES_PER_KEY,
  sceneAlpha,
  stepScene,
  titleFor,
  type Painter,
  type SceneKey,
} from "./scene";
import { SEASONS } from "./seasons";

const W = 300;
const H = 24;
const KEYS = Object.keys(SCENES) as SceneKey[];

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

test("there are 45 scenes: five for each season and five for the neutral dates", () => {
  const ids = new Set<string>(SEASONS.map((s) => s.id));
  ids.add("neutral");
  assert.deepEqual(new Set(KEYS), ids);
  assert.equal(KEYS.length, 9);
  for (const key of KEYS) assert.equal(SCENES[key].length, SCENES_PER_KEY, key);
  const names = KEYS.flatMap((k) => SCENES[k].map((r) => r.name));
  assert.equal(names.length, 45);
  assert.equal(new Set(names).size, 45);
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
  const kinds = new Set(KEYS.flatMap((k) => SCENES[k].flatMap((r) => r.props)));
  assert.equal(kinds.size, 38);
  const bare = createScene("neutral", W, H);
  bare.row = { ...bare.row, props: [] as never };
  const base = recorder();
  drawScene(base.ctx, bare);
  for (const kind of kinds) {
    const scene = createScene("neutral", W, H);
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

test("the cold seasons have snow and ice, and the warm ones do not", () => {
  const colors = (key: SceneKey, index: number) => {
    const scene = createScene(key, W, H, index);
    const { ctx, rects } = recorder();
    drawScene(ctx, scene);
    return new Set(rects.map((r) => r.color));
  };
  assert.ok(colors("winterfest", 2).has("#a9cfdc"), "Frozen Lake has no ice");
  assert.ok(colors("midsummer", 1).has("#284f61"), "Lakeside Sunset has no water");
  assert.ok(!colors("midsummer", 1).has("#a9cfdc"));
  assert.ok(colors("winterfest", 1).has("#e6f4f0"), "the cabin roof has no snow");
  assert.ok(!colors("neutral", 2).has("#e6f4f0"));
});

test("a named thing is drawn: the sunrise, the smoke, the bridge, and the blossom", () => {
  const colors = (key: SceneKey, index: number) => {
    const scene = createScene(key, W, H, index);
    const { ctx, rects } = recorder();
    drawScene(ctx, scene);
    return new Set(rects.map((r) => r.color));
  };
  assert.equal(SCENES["new-year"][4].name, "First Sunrise");
  assert.ok(colors("new-year", 4).has("#ff9a4f"), "no sun in First Sunrise");
  assert.ok(colors("winterfest", 1).has("#9aa6a6"), "no smoke in Cabin Smoke");
  assert.ok(colors("neutral", 3).has("#8a6543"), "no bridge in Bridge Walk");
  assert.ok(colors("spring-bloom", 0).has("#d99ab4"), "no blossom in the orchard");
  assert.ok(!colors("late-autumn", 0).has("#d99ab4"));
});

test("no animal is out of season", () => {
  const cast = (key: SceneKey) => new Set(SCENES[key].flatMap((r) => r.cast));
  assert.ok(!cast("midsummer").has("chick"));
  for (const key of ["winterfest", "new-year"] as SceneKey[]) {
    assert.ok(!cast(key).has("frog"), key);
    assert.ok(!cast(key).has("hedgehog"), key);
  }
  assert.ok(!cast("winterfest").has("cat"));
});

test("a strip too narrow for the title leaves it out", () => {
  const scene = createScene("harvest-festival", 60, H);
  const { ctx, rects } = recorder();
  drawScene(ctx, scene);
  assert.ok(!rects.some((r) => r.color === "#453423"));
});

test("a title fades with its scene", () => {
  const scene = createScene("neutral", W, H);
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
  assert.equal(createScene("neutral", W, H, 7).index, 2);
  assert.equal(createScene("neutral", W, H, -1).index, 4);
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
  for (const key of KEYS) {
    for (let index = 0; index < SCENES_PER_KEY; index++) {
      const scene = createScene(key, 40, 16, index);
      stepScene(scene, 1 / 12);
      drawScene(recorder().ctx, scene);
    }
  }
});
