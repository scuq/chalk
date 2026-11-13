import { test } from "node:test";
import assert from "node:assert/strict";
import { historyDepth, hasDepth, popSteps, reconcile, stackDepth, type PhoneLayers } from "./phone-stack";

const L = (screen: "list" | "chat", thread = false, panel = false): PhoneLayers => ({ screen, thread, panel });

test("the list is depth 1, and each open layer adds one", () => {
  assert.equal(stackDepth(L("list")), 1);
  assert.equal(stackDepth(L("chat")), 2);
  assert.equal(stackDepth(L("chat", true)), 3);
  assert.equal(stackDepth(L("chat", true, true)), 4);
  assert.equal(stackDepth(L("list", false, true)), 2);
});

test("an entry without a valid depth counts as the list", () => {
  assert.equal(historyDepth(null), 1);
  assert.equal(historyDepth({}), 1);
  assert.equal(historyDepth({ chalkDepth: "3" }), 1);
  assert.equal(historyDepth({ chalkDepth: 0 }), 1);
  assert.equal(historyDepth({ chalkDepth: 2.5 }), 1);
  assert.equal(historyDepth({ chalkDepth: 3 }), 3);
  assert.equal(hasDepth({}), false);
  assert.equal(hasDepth({ chalkDepth: 1, admin: true }), true);
});

test("back closes the top layer first: panel, then thread, then chat", () => {
  assert.deepEqual(popSteps(L("chat", true, true), 3), ["close-panel"]);
  assert.deepEqual(popSteps(L("chat", true, true), 2), ["close-panel", "close-thread"]);
  assert.deepEqual(popSteps(L("chat", true, true), 1), ["close-panel", "close-thread", "to-list"]);
  assert.deepEqual(popSteps(L("chat", true), 2), ["close-thread"]);
  assert.deepEqual(popSteps(L("chat"), 1), ["to-list"]);
  assert.deepEqual(popSteps(L("list", false, true), 1), ["close-panel"]);
});

test("nothing closes when the stack is already at the depth or below", () => {
  assert.deepEqual(popSteps(L("chat"), 2), []);
  assert.deepEqual(popSteps(L("list"), 1), []);
  assert.deepEqual(popSteps(L("chat"), 5), []);
});

test("reconcile pushes when the state is deeper and goes back when it is not", () => {
  assert.deepEqual(reconcile(2, 1), { push: 1 });
  assert.deepEqual(reconcile(4, 2), { push: 2 });
  assert.deepEqual(reconcile(1, 3), { go: -2 });
  assert.equal(reconcile(2, 2), null);
});
