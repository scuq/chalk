import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, toggle, ownSet, type ReactionSet } from "./reactions";

const ME = "user-me";
const A = "user-a";
const B = "user-b";

const sets: ReactionSet[] = [
  { userID: A, emoji: ["👍", "🎉"] },
  { userID: ME, emoji: ["👍"] },
  { userID: B, emoji: ["🎉"] },
];

test("counts each emoji across members and flags your own", () => {
  const out = aggregate(sets, ME);
  assert.deepEqual(
    out.map((t) => [t.emoji, t.count, t.mine]),
    [
      ["👍", 2, true],
      ["🎉", 2, false],
    ],
  );
});

test("chips keep first-appearance order, not count order", () => {
  // 🎉 ends up more popular, but 👍 was seen first and must stay first --
  // chips that reorder under the pointer are the bug this prevents.
  const s: ReactionSet[] = [
    { userID: A, emoji: ["👍"] },
    { userID: B, emoji: ["🎉"] },
    { userID: ME, emoji: ["🎉"] },
  ];
  assert.deepEqual(aggregate(s, ME).map((t) => t.emoji), ["👍", "🎉"]);
});

test("a duplicated emoji within one member's set counts once", () => {
  const s: ReactionSet[] = [{ userID: A, emoji: ["👍", "👍", "👍"] }];
  const out = aggregate(s, ME);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.count, 1);
  assert.deepEqual(out[0]!.userIDs, [A]);
});

test("empty and blank inputs tally to nothing", () => {
  assert.deepEqual(aggregate([], ME), []);
  assert.deepEqual(aggregate([{ userID: A, emoji: [] }], ME), []);
  assert.deepEqual(aggregate([{ userID: A, emoji: [""] }], ME), []);
});

test("with no session nothing is marked as yours", () => {
  assert.equal(aggregate(sets, null).every((t) => !t.mine), true);
});

test("reactor ids ride along in first-seen order", () => {
  assert.deepEqual(aggregate(sets, ME)[0]!.userIDs, [A, ME]);
});

test("toggle adds when absent and removes when present", () => {
  assert.deepEqual(toggle([], "👍"), ["👍"]);
  assert.deepEqual(toggle(["👍"], "🎉"), ["👍", "🎉"]);
  assert.deepEqual(toggle(["👍", "🎉"], "👍"), ["🎉"]);
  assert.deepEqual(toggle(["👍"], "👍"), []);
});

test("toggle does not mutate the input", () => {
  const before = ["👍"];
  toggle(before, "🎉");
  assert.deepEqual(before, ["👍"]);
});

test("ownSet finds your set, or nothing", () => {
  assert.deepEqual(ownSet(sets, ME), ["👍"]);
  assert.deepEqual(ownSet(sets, "nobody"), []);
  assert.deepEqual(ownSet(sets, null), []);
});
