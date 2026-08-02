import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregate,
  toggle,
  ownSet,
  reactorList,
  reactorSummary,
  REACTOR_LIST_MAX,
  type ReactionSet,
} from "./reactions";

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

const handles = new Map([[A, "alice"], [B, "bob"]]);
const handleOf = (u: string) => handles.get(u);

test("reactor names resolve you, the roster, then the bare id", () => {
  // "user-nobody" is not in the channel roster -- someone who has left. Its
  // tail still distinguishes it from the next departed member.
  const out = reactorList([A, ME, "user-nobody"], handleOf, ME);
  assert.deepEqual(out.names, ["alice", "you", "r-nobody"]);
  assert.equal(out.more, 0);
});

test("with no session nobody is you", () => {
  assert.deepEqual(reactorList([A, ME], handleOf, null).names, ["alice", "user-me"]);
});

test("a long reactor list is capped and the rest counted", () => {
  const ids = Array.from({ length: REACTOR_LIST_MAX + 4 }, (_, i) => `user-${i}`);
  const out = reactorList(ids, handleOf, null);
  assert.equal(out.names.length, REACTOR_LIST_MAX);
  assert.equal(out.more, 4);
});

test("no reactors lists nothing", () => {
  assert.deepEqual(reactorList([], handleOf, ME), { names: [], more: 0 });
  assert.equal(reactorSummary({ names: [], more: 0 }), "");
});

test("the summary joins with a final 'and', and folds the overflow in", () => {
  assert.equal(reactorSummary({ names: ["alice"], more: 0 }), "alice");
  assert.equal(reactorSummary({ names: ["alice", "you"], more: 0 }), "alice and you");
  assert.equal(
    reactorSummary({ names: ["alice", "bob", "you"], more: 0 }),
    "alice, bob and you",
  );
  assert.equal(
    reactorSummary({ names: ["alice", "bob"], more: 3 }),
    "alice, bob and 3 more",
  );
});
