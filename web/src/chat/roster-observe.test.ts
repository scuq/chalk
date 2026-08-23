// Tests for chat/roster-observe.ts -- 83-7 (D.6).
//
// The properties under test are the doc's own words: the first observation
// baselines silently; a later observation surfaces additions, removals and
// fingerprint changes this client did not already render from a membership
// event; a chained rotation reads softer than an unlinked change; and
// observe() resolves only after the baseline + notices are PERSISTED (the
// frozen diff-before-reshare ordering).

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { RosterObserver, diffRoster, noticeText, type RosterObserverDeps } from "./roster-observe";
import type { ObservedRosterRecord } from "../crypto/idb";
import type { VerifiedGeneration } from "../crypto/idgen";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";

function gen(fpHex: string, generation: number): VerifiedGeneration {
  return { generation, ed25519Public: new Uint8Array(32), x25519Public: new Uint8Array(32), fpHex, hash: new Uint8Array(32) };
}

function makeDeps(over: Partial<RosterObserverDeps> = {}) {
  const store = new Map<string, ObservedRosterRecord>();
  const saves: ObservedRosterRecord[] = [];
  const deps: RosterObserverDeps = {
    resolveFp: async (id) => `fp-${id.slice(0, 8)}`,
    chainFor: async () => [],
    load: async (cid) => store.get(cid) ?? null,
    save: async (rec) => {
      store.set(rec.channelID, rec);
      saves.push(rec);
    },
    ...over,
  };
  return { deps, store, saves };
}

test("diffRoster: added, removed, changed; unresolved fingerprints never read as changes", () => {
  const prev = [
    { userID: A, fpHex: "1" },
    { userID: B, fpHex: "2" },
    { userID: C, fpHex: "" },
  ];
  const next = [
    { userID: A, fpHex: "9" }, // changed
    { userID: C, fpHex: "3" }, // was unresolved: NOT a change
    { userID: "d", fpHex: "4" }, // added
  ];
  const d = diffRoster(prev, next);
  assert.deepEqual(d.added.map((m) => m.userID), ["d"]);
  assert.deepEqual(d.removed.map((m) => m.userID), [B]);
  assert.deepEqual(d.changed, [{ userID: A, oldFp: "1", newFp: "9" }]);
});

test("first observation baselines silently; the second surfaces the diff", async () => {
  const { deps, store } = makeDeps();
  const obs = new RosterObserver(deps);
  assert.deepEqual(await obs.observe("ch", [A, B]), []);
  assert.equal(store.get("ch")!.members.length, 2);

  const notices = await obs.observe("ch", [A, C], new Map([[C, "carol"]]));
  const kinds = notices.map((n) => `${n.kind}:${n.userID}`).sort();
  assert.deepEqual(kinds, [`added:${C}`, `removed:${B}`]);
  assert.equal(notices.find((n) => n.userID === C)?.handle, "carol");
  // persisted before observe resolved -- the record precedes the key
  assert.deepEqual(store.get("ch")!.notices.map((n) => n.kind).sort(), ["added", "removed"]);
});

test("an event-sourced change is expected and stays quiet; the next unexpected one does not", async () => {
  const { deps } = makeDeps();
  const obs = new RosterObserver(deps);
  await obs.observe("ch", [A]);
  obs.expectChange("ch", "add", B); // the member_added push already told the UI
  assert.deepEqual(await obs.observe("ch", [A, B]), []);
  // the expectation was consumed: a LATER silent insert of the same user
  // (removed then re-inserted by a DB write) is surfaced
  const n1 = await obs.observe("ch", [A]);
  assert.deepEqual(n1.map((x) => x.kind), ["removed"]);
  const n2 = await obs.observe("ch", [A, B]);
  assert.deepEqual(n2.map((x) => x.kind).sort(), ["added", "removed"]);
});

test("a chained rotation reads key-rotated; an unlinked change reads key-changed", async () => {
  let fp = "old";
  const { deps } = makeDeps({
    resolveFp: async () => fp,
    chainFor: async () => [gen("old", 1), gen("new", 2)],
  });
  const obs = new RosterObserver(deps);
  await obs.observe("ch", [A]);
  fp = "new";
  const rotated = await obs.observe("ch", [A]);
  assert.deepEqual(rotated.map((n) => n.kind), ["key-rotated"]);

  // unlinked: the chain never reaches the new fingerprint
  let fp2 = "old";
  const { deps: deps2 } = makeDeps({
    resolveFp: async () => fp2,
    chainFor: async () => [gen("old", 1)],
  });
  const obs2 = new RosterObserver(deps2);
  await obs2.observe("ch", [A]);
  fp2 = "mallory";
  const walled = await obs2.observe("ch", [A]);
  assert.deepEqual(walled.map((n) => n.kind), ["key-changed"]);
  assert.match(noticeText(walled[0]), /cannot be linked/);
});

test("notices accumulate until dismissed, and dismissal persists", async () => {
  const { deps, store } = makeDeps();
  const obs = new RosterObserver(deps);
  await obs.observe("ch", [A]);
  await obs.observe("ch", [A, B]);
  const more = await obs.observe("ch", [A, B, C]);
  assert.equal(more.length, 2); // both additions still pending
  await obs.dismiss("ch");
  assert.deepEqual(store.get("ch")!.notices, []);
  assert.deepEqual(await obs.observe("ch", [A, B, C]), []); // nothing new, nothing stored
});

test("observe() persists BEFORE resolving even when the caller races a wrap", async () => {
  // the ordering property, mechanically: by the time observe's promise
  // settles, the save has happened -- a wrap gated on observe can never
  // precede the record.
  let savedAt = 0;
  let resolvedAt = 0;
  const { deps } = makeDeps({
    save: async () => {
      await new Promise((r) => setTimeout(r, 5));
      savedAt = performance.now();
    },
  });
  const obs = new RosterObserver(deps);
  await obs.observe("ch", [A]).then(() => {
    resolvedAt = performance.now();
  });
  assert.ok(savedAt > 0 && resolvedAt >= savedAt);
});

test("concurrent observations of one channel coalesce", async () => {
  let loads = 0;
  const { deps } = makeDeps();
  const base = deps.load;
  deps.load = async (cid) => {
    loads++;
    return base(cid);
  };
  const obs = new RosterObserver(deps);
  const [x, y] = await Promise.all([obs.observe("ch", [A]), obs.observe("ch", [A])]);
  assert.deepEqual(x, y);
  assert.equal(loads, 1);
});
