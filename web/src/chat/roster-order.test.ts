// 114-1: the order model. Every drift case the phase doc names has a test
// here, because a manual list is a preference ABOUT the roster and the roster
// moves under it constantly.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CHANNEL_SORT_CHOICES,
  PREFS_MAX_BYTES,
  activityWhen,
  compareByActivity,
  moveInList,
  normalizeAutoSortMode,
  normalizeSortMode,
  orderChannels,
  orderGroups,
  placeInList,
  prefsPatchBytes,
  prefsPatchFits,
  pruneRosterOrder,
  resolveRosterOrder,
  type RosterOrderState,
} from "./roster-order";

function ch(id: string, createdAtMs = 0) {
  return { id, createdAt: new Date(createdAtMs) };
}
const ids = (list: { id: string }[]) => list.map((c) => c.id);

// ---- created ---------------------------------------------------------------

test("created mode is the input order, untouched", () => {
  const list = [ch("c"), ch("a"), ch("b")];
  assert.deepEqual(ids(orderChannels(list, "created", undefined)), ["c", "a", "b"]);
});

test("created mode ignores a manual list and the activity map", () => {
  const list = [ch("c"), ch("a")];
  const out = orderChannels(list, "created", ["a", "c"], { a: { ts: 9 } });
  assert.deepEqual(ids(out), ["c", "a"]);
});

test("ordering never mutates its input", () => {
  const list = [ch("c"), ch("a"), ch("b")];
  orderChannels(list, "manual", ["b"]);
  orderChannels(list, "activity", undefined, { a: { ts: 5 } });
  assert.deepEqual(ids(list), ["c", "a", "b"]);
});

// ---- activity --------------------------------------------------------------

test("activity mode is newest message first", () => {
  const list = [ch("a"), ch("b"), ch("c")];
  const out = orderChannels(list, "activity", undefined, {
    a: { ts: 100 },
    b: { ts: 300 },
    c: { ts: 200 },
  });
  assert.deepEqual(ids(out), ["b", "c", "a"]);
});

test("a channel that never said anything falls back to its creation time", () => {
  const list = [ch("quiet", 500), ch("loud", 1)];
  const out = orderChannels(list, "activity", undefined, { loud: { ts: 400 } });
  assert.deepEqual(ids(out), ["quiet", "loud"]);
});

test("same-millisecond activity breaks the tie by id, not by input order", () => {
  const forward = orderChannels([ch("b"), ch("a")], "activity", undefined, {
    a: { ts: 7 },
    b: { ts: 7 },
  });
  const backward = orderChannels([ch("a"), ch("b")], "activity", undefined, {
    a: { ts: 7 },
    b: { ts: 7 },
  });
  assert.deepEqual(ids(forward), ["a", "b"]);
  assert.deepEqual(ids(backward), ["a", "b"]);
});

test("activityWhen and compareByActivity are the shared comparator", () => {
  assert.equal(activityWhen(ch("a", 42), {}), 42);
  assert.equal(activityWhen(ch("a", 42), { a: { ts: 99 } }), 99);
  assert.ok(compareByActivity({ id: "a", when: 2 }, { id: "b", when: 1 }) < 0);
  assert.ok(compareByActivity({ id: "b", when: 1 }, { id: "a", when: 1 }) > 0);
});

// ---- manual ----------------------------------------------------------------

test("manual mode renders the list's order", () => {
  const list = [ch("a"), ch("b"), ch("c")];
  assert.deepEqual(ids(orderChannels(list, "manual", ["c", "a", "b"])), ["c", "a", "b"]);
});

test("an empty or absent manual list is exactly today's order", () => {
  const list = [ch("a"), ch("b")];
  assert.deepEqual(ids(orderChannels(list, "manual", [])), ["a", "b"]);
  assert.deepEqual(ids(orderChannels(list, "manual", undefined)), ["a", "b"]);
});

test("a channel the list has never heard of appends at the bottom", () => {
  const list = [ch("new"), ch("a"), ch("b")]; // newest-created first
  assert.deepEqual(ids(orderChannels(list, "manual", ["b", "a"])), ["b", "a", "new"]);
});

test("several unlisted channels keep the automatic order among themselves", () => {
  const list = [ch("n2"), ch("n1"), ch("a")];
  assert.deepEqual(ids(orderChannels(list, "manual", ["a"])), ["a", "n2", "n1"]);
});

test("an id no longer in the group is skipped on read", () => {
  const list = [ch("a"), ch("b")];
  assert.deepEqual(ids(orderChannels(list, "manual", ["gone", "b", "left", "a"])), [
    "b",
    "a",
  ]);
});

test("a duplicated id in the list renders once", () => {
  const list = [ch("a"), ch("b")];
  assert.deepEqual(ids(orderChannels(list, "manual", ["b", "b", "a"])), ["b", "a"]);
});

test("the result is always a complete permutation of the input", () => {
  const list = [ch("a"), ch("b"), ch("c")];
  for (const manual of [["c"], ["x"], [], ["c", "c", "a"], ["b", "a", "c"]]) {
    const out = ids(orderChannels(list, "manual", manual));
    assert.equal(out.length, 3);
    assert.deepEqual([...out].sort(), ["a", "b", "c"]);
  }
});

// ---- groups ----------------------------------------------------------------

const group = (key: string) => ({ key });

test("groups on the list render first, the rest in today's order", () => {
  const groups = [group("general"), group("apps"), group("dev")];
  assert.deepEqual(
    orderGroups(groups, ["dev"]).map((g) => g.key),
    ["dev", "general", "apps"],
  );
});

test("an absent group list is exactly today", () => {
  const groups = [group("general"), group("dev")];
  assert.deepEqual(
    orderGroups(groups, undefined).map((g) => g.key),
    ["general", "dev"],
  );
});

test("a group on the list that no longer exists is skipped", () => {
  const groups = [group("general"), group("dev")];
  assert.deepEqual(
    orderGroups(groups, ["gone", "dev", "general"]).map((g) => g.key),
    ["dev", "general"],
  );
});

// ---- moves -----------------------------------------------------------------

test("moveInList moves one step and to the ends", () => {
  const list = ["a", "b", "c", "d"];
  assert.deepEqual(moveInList(list, "c", "up"), ["a", "c", "b", "d"]);
  assert.deepEqual(moveInList(list, "c", "down"), ["a", "b", "d", "c"]);
  assert.deepEqual(moveInList(list, "c", "top"), ["c", "a", "b", "d"]);
  assert.deepEqual(moveInList(list, "b", "bottom"), ["a", "c", "d", "b"]);
});

test("moving past an end is a no-op, not a wrap", () => {
  const list = ["a", "b"];
  assert.deepEqual(moveInList(list, "a", "up"), ["a", "b"]);
  assert.deepEqual(moveInList(list, "b", "down"), ["a", "b"]);
  assert.deepEqual(moveInList(list, "nope", "top"), ["a", "b"]);
});

test("moveInList does not mutate its input", () => {
  const list = ["a", "b", "c"];
  moveInList(list, "a", "bottom");
  assert.deepEqual(list, ["a", "b", "c"]);
});

test("placeInList drops before a row, or at the end", () => {
  const list = ["a", "b", "c"];
  assert.deepEqual(placeInList(list, "c", "a"), ["c", "a", "b"]);
  assert.deepEqual(placeInList(list, "a", "c"), ["b", "a", "c"]);
  assert.deepEqual(placeInList(list, "a", null), ["b", "c", "a"]);
  assert.deepEqual(placeInList(list, "b", "b"), ["a", "c", "b"]);
  assert.deepEqual(placeInList(list, "new", "b"), ["a", "new", "b", "c"]);
});

// ---- pruning ---------------------------------------------------------------

function order(over: Partial<RosterOrderState> = {}): RosterOrderState {
  return {
    channelSort: "created",
    groupSort: {},
    channelOrder: {},
    groupOrder: [],
    ...over,
  };
}

test("pruning drops ids no longer in their group", () => {
  const out = pruneRosterOrder(order({ channelOrder: { dev: ["a", "gone", "b"] } }), [
    { key: "dev", channelIDs: ["a", "b", "c"] },
  ]);
  assert.deepEqual(out.channelOrder, { dev: ["a", "b"] });
});

test("pruning drops lists, sorts and entries for groups that no longer exist", () => {
  const out = pruneRosterOrder(
    order({
      channelOrder: { dev: ["a"], gone: ["x"] },
      groupSort: { dev: "manual", gone: "activity" },
      groupOrder: ["gone", "dev"],
    }),
    [{ key: "dev", channelIDs: ["a"] }],
  );
  assert.deepEqual(out.channelOrder, { dev: ["a"] });
  assert.deepEqual(out.groupSort, { dev: "manual" });
  assert.deepEqual(out.groupOrder, ["dev"]);
});

test("a list pruned to nothing leaves no key behind", () => {
  const out = pruneRosterOrder(order({ channelOrder: { dev: ["gone"] } }), [
    { key: "dev", channelIDs: ["a"] },
  ]);
  assert.deepEqual(out.channelOrder, {});
});

test("pruning keeps a manual list for a group now sorted automatically", () => {
  const out = pruneRosterOrder(
    order({ channelOrder: { dev: ["a"] }, groupSort: { dev: "activity" } }),
    [{ key: "dev", channelIDs: ["a"] }],
  );
  assert.deepEqual(out.channelOrder, { dev: ["a"] });
});

test("pruning de-duplicates both lists and keeps the account default", () => {
  const out = pruneRosterOrder(
    order({
      channelSort: "activity",
      channelOrder: { dev: ["a", "a", "b"] },
      groupOrder: ["dev", "dev"],
    }),
    [{ key: "dev", channelIDs: ["a", "b"] }],
  );
  assert.deepEqual(out.channelOrder, { dev: ["a", "b"] });
  assert.deepEqual(out.groupOrder, ["dev"]);
  assert.equal(out.channelSort, "activity");
});

// ---- the resolver ----------------------------------------------------------

test("empty prefs resolve to exactly today's roster", () => {
  assert.deepEqual(resolveRosterOrder({}), {
    channelSort: "created",
    groupSort: {},
    channelOrder: {},
    groupOrder: [],
  });
});

test("the resolver drops junk rather than trusting the blob", () => {
  const out = resolveRosterOrder({
    channelSort: 7,
    groupSort: { dev: "activity", ops: "sideways", bad: 3 },
    channelOrder: { dev: ["a", 5, "", "a", "b"], ops: "nope", empty: [] },
    groupOrder: ["dev", 1, "dev", ""],
  });
  assert.equal(out.channelSort, "created");
  assert.deepEqual(out.groupSort, { dev: "activity" });
  assert.deepEqual(out.channelOrder, { dev: ["a", "b"] });
  assert.deepEqual(out.groupOrder, ["dev"]);
});

test("the resolver survives arrays and nulls where objects were expected", () => {
  const out = resolveRosterOrder({
    groupSort: ["nope"],
    channelOrder: null,
    groupOrder: { dev: 1 },
  });
  assert.deepEqual(out.groupSort, {});
  assert.deepEqual(out.channelOrder, {});
  assert.deepEqual(out.groupOrder, []);
});

// ---- modes and the cap -----------------------------------------------------

test("junk sort modes read as the fallback", () => {
  assert.equal(normalizeSortMode("activity"), "activity");
  assert.equal(normalizeSortMode("manual"), "manual");
  assert.equal(normalizeSortMode(undefined), "created");
  assert.equal(normalizeSortMode({ nope: 1 }), "created");
  assert.equal(normalizeSortMode("nope", "activity"), "activity");
});

test("the account default has no manual setting", () => {
  assert.equal(normalizeAutoSortMode("manual"), "created");
  assert.equal(normalizeAutoSortMode("activity"), "activity");
  assert.equal(normalizeAutoSortMode(undefined), "created");
  assert.deepEqual(
    CHANNEL_SORT_CHOICES.map((c) => c.value),
    ["created", "activity"],
  );
});

test("the size check counts the bytes the server will count", () => {
  assert.equal(prefsPatchBytes({}), 2);
  // Go's json.Marshal escapes <, > and & to six bytes each.
  assert.equal(prefsPatchBytes({ a: "<" }), prefsPatchBytes({ a: "xxxxxx" }));
  assert.ok(prefsPatchFits({ roster: { groupOrder: ["dev"] } }));
});

test("a hundred hand-ordered channels fit; a thousand do not", () => {
  const uuids = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
  const hundred = { roster: { channelOrder: { dev: uuids(100) } } };
  assert.ok(prefsPatchFits(hundred));
  assert.ok(prefsPatchBytes(hundred) < PREFS_MAX_BYTES);
  assert.ok(!prefsPatchFits({ roster: { channelOrder: { dev: uuids(1000) } } }));
});
