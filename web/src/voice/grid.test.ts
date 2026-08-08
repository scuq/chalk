// 63-1: the group-call tile grid's geometry.

import test from "node:test";
import assert from "node:assert/strict";

import { gridPlan, useGrid, isCrowded, resolveGridMode } from "./grid";

test("1:1 and solo calls keep the spotlight", () => {
  assert.equal(useGrid(1), false);
  assert.equal(useGrid(2), false);
});

test("three or more participants use the grid", () => {
  assert.equal(useGrid(3), true);
  assert.equal(useGrid(8), true);
});

test("odd counts square off with a dummy tile", () => {
  assert.deepEqual(gridPlan(3), { cols: 2, rows: 2, dummies: 1 });
  assert.deepEqual(gridPlan(5), { cols: 2, rows: 3, dummies: 1 });
  assert.deepEqual(gridPlan(7), { cols: 2, rows: 4, dummies: 1 });
});

test("even counts need no dummy", () => {
  assert.deepEqual(gridPlan(4), { cols: 2, rows: 2, dummies: 0 });
  assert.deepEqual(gridPlan(6), { cols: 2, rows: 3, dummies: 0 });
});

test("growth is vertical: columns stay at 2, rows track the count", () => {
  for (let n = 3; n <= 12; n++) {
    const p = gridPlan(n);
    assert.equal(p.cols, 2);
    assert.equal(p.rows, Math.ceil(n / 2));
    assert.equal(p.rows * p.cols - p.dummies, n);
  }
});

test("crowded starts past four participants", () => {
  assert.equal(isCrowded(3), false);
  assert.equal(isCrowded(4), false);
  assert.equal(isCrowded(5), true);
});

// 96-1: the layout under a viewer's standing choice.

test("auto follows the 63-1 rule", () => {
  assert.equal(resolveGridMode("auto", 2, false), false);
  assert.equal(resolveGridMode("auto", 3, false), true);
  assert.equal(resolveGridMode("auto", 9, false), true);
});

test("auto yields the stage to a live share", () => {
  assert.equal(resolveGridMode("auto", 5, true), false);
});

test("an explicit choice outranks the rule and the share", () => {
  assert.equal(resolveGridMode("grid", 2, false), true);
  assert.equal(resolveGridMode("grid", 5, true), true);
  assert.equal(resolveGridMode("spotlight", 9, false), false);
});

test("an empty stage is never a grid", () => {
  assert.equal(resolveGridMode("auto", 0, false), false);
  assert.equal(resolveGridMode("grid", 0, false), false);
});

// The 96-1 bug: focusing a face in a 1:1 call (the only layout there IS the
// spotlight) left a pin behind that kept the grid from ever appearing when a
// third person joined. resolveGridMode does not consult the pin at all, so
// the arrival is decided by the count alone.
test("a pin made at two participants cannot suppress the grid at three", () => {
  assert.equal(resolveGridMode("auto", 3, false), true);
});
