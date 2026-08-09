// Tests for crypto/replay.ts -- 83-2 replay-triple first-seen binding.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { ReplayGuard, type ReplayStorage } from "./replay";
import type { ReplayRecord } from "./idb";

function memStorage(opts: { failLoad?: boolean; failSave?: boolean; delayMs?: number } = {}) {
  const rows = new Map<string, ReplayRecord>();
  const storage: ReplayStorage = {
    async load(triple) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.failLoad) throw new Error("idb down");
      return rows.get(triple) ?? null;
    },
    async save(rec) {
      if (opts.failSave) throw new Error("idb down");
      rows.set(rec.triple, rec);
    },
  };
  return { storage, rows };
}

const T = "aaaa/bbbb/cccc";

test("first bind wins; same row is same; another row is duplicate", async () => {
  const { storage } = memStorage();
  const g = new ReplayGuard(storage);
  assert.equal(await g.bind(T, "row-1", "ch"), "first");
  assert.equal(await g.bind(T, "row-1", "ch"), "same");
  assert.equal(await g.bind(T, "row-2", "ch"), "duplicate");
});

test("binding persists to storage and is honoured by a fresh guard", async () => {
  const { storage, rows } = memStorage();
  const g1 = new ReplayGuard(storage);
  assert.equal(await g1.bind(T, "row-1", "ch"), "first");
  assert.equal(rows.get(T)?.serverID, "row-1");
  const g2 = new ReplayGuard(storage); // cold cache, same store
  assert.equal(await g2.bind(T, "row-2", "ch"), "duplicate");
  assert.equal(await g2.bind(T, "row-1", "ch"), "same");
});

test("concurrent binds for one triple serialize: exactly one first", async () => {
  const { storage } = memStorage({ delayMs: 5 }); // widen the race window
  const g = new ReplayGuard(storage);
  const [a, b, c] = await Promise.all([
    g.bind(T, "row-1", "ch"),
    g.bind(T, "row-2", "ch"),
    g.bind(T, "row-1", "ch"),
  ]);
  assert.deepEqual([a, b, c], ["first", "duplicate", "same"]);
});

test("storage failure fails open (renders), not closed", async () => {
  const { storage } = memStorage({ failLoad: true, failSave: true });
  const g = new ReplayGuard(storage);
  assert.equal(await g.bind(T, "row-1", "ch"), "first");
  // and the in-memory binding still catches the replay within the session
  assert.equal(await g.bind(T, "row-2", "ch"), "duplicate");
});
