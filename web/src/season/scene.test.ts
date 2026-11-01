// 129-9: the pixel scene, tested with a fake Painter that records each call.
//
// The tests hold these facts: every season has a scene, a scene paints whole
// pixels and no sky fill, the walkers enter from the edges and jump over the
// obstacles, a long frame cannot throw a walker across the strip, and a
// resize or a narrow strip does not break a scene.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createScene, drawScene, resizeScene, stepScene, THEMES, type Painter } from "./scene";
import { SEASONS, type SeasonId } from "./seasons";

const W = 300;
const H = 22;

function recorder() {
  const rects: { x: number; y: number; w: number; h: number; color: string }[] = [];
  const ctx: Painter = {
    fillStyle: "",
    fillRect(x, y, w, h) {
      rects.push({ x, y, w, h, color: String(ctx.fillStyle) });
    },
  };
  return { ctx, rects };
}

test("every season in the registry has a scene and every scene has a season", () => {
  const ids = new Set(SEASONS.map((s) => s.id));
  assert.deepEqual(new Set(Object.keys(THEMES)), ids);
});

test("every season draws whole pixels with no sky fill, at every step of a visit", () => {
  for (const id of Object.keys(THEMES) as SeasonId[]) {
    const scene = createScene(id, W, H);
    for (let i = 0; i < 900; i++) {
      stepScene(scene, 1 / 12);
      const { ctx, rects } = recorder();
      drawScene(ctx, scene);
      assert.ok(rects.length > 0, `${id} drew nothing`);
      for (const r of rects) {
        for (const n of [r.x, r.y, r.w, r.h]) assert.ok(Number.isInteger(n), `${id}: ${n}`);
        assert.ok(r.w < W, `${id} painted a rect as wide as the strip, so the header shows no more`);
      }
    }
  }
});

test("the walkers enter from the edges and walk in opposite directions", () => {
  const scene = createScene("spooky-season", W, H);
  assert.ok(scene.actors[0].x < 0);
  assert.ok(scene.actors[1].x > W);
  stepScene(scene, 0.1);
  assert.ok(scene.actors[0].x > -12);
  assert.ok(scene.actors[1].x < W + 12);
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
  assert.ok(a.x >= -12 && a.x <= W + 12);
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

test("a very narrow strip still draws every season", () => {
  for (const id of Object.keys(THEMES) as SeasonId[]) {
    const scene = createScene(id, 40, 16);
    stepScene(scene, 1 / 12);
    drawScene(recorder().ctx, scene);
  }
});
