// 129-7: the log of visits. A fake localStorage shows that pages share one log,
// that a corrupt entry is replaced, and that the cap holds without storage.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GAP_MS, MAX_VISITS_PER_DAY } from "./peek";
import { takeVisit } from "./visits";

const KEY = "chalk.season.visits.v1";
const HOUR = 3_600_000;
const holder = globalThis as unknown as { window?: unknown };

function fakeStorage(seed?: string) {
  const items = new Map<string, string>(seed === undefined ? [] : [[KEY, seed]]);
  holder.window = {
    localStorage: {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, v),
    },
  };
  return items;
}

afterEach(() => {
  delete holder.window;
});

test("a claim from one page holds a second page and a reload to the same log", () => {
  const now = new Date(2026, 9, 25, 12).getTime();
  const items = fakeStorage(JSON.stringify({ day: "", count: 0, nextAt: 0 }));
  assert.equal(takeVisit(now), true);
  assert.equal(JSON.parse(items.get(KEY)!).count, 1);
  assert.equal(takeVisit(now + 1), false);
  assert.equal(takeVisit(now + GAP_MS[1]), true);
  assert.equal(JSON.parse(items.get(KEY)!).count, 2);
});

test("a spent day survives in storage", () => {
  const now = new Date(2026, 9, 26, 12).getTime();
  fakeStorage(JSON.stringify({ day: "2026-10-26", count: MAX_VISITS_PER_DAY, nextAt: 0 }));
  assert.equal(takeVisit(now), false);
});

test("a corrupt entry does not stop the figure and is replaced", () => {
  const bads = ["{", '"x"', '{"day":1}', '{"day":"d","count":"9","nextAt":0}'];
  bads.forEach((bad, i) => {
    const now = new Date(2026, 10, 10 + i, 12).getTime();
    const items = fakeStorage(bad);
    assert.equal(takeVisit(now), true, bad);
    assert.equal(JSON.parse(items.get(KEY)!).day, `2026-11-${10 + i}`);
    assert.equal(takeVisit(now + 1), false, bad);
  });
});

test("without storage the cap still holds for the page", () => {
  const now = new Date(2026, 9, 29, 12).getTime();
  holder.window = {
    localStorage: {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
    },
  };
  assert.equal(takeVisit(now), true);
  assert.equal(takeVisit(now + HOUR / 2), false);
});
