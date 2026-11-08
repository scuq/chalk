// 129-7: the log of visits. A fake localStorage shows that pages share one log,
// that a corrupt entry is replaced, and that the cap holds without storage.
// 129-15: the next row differs from the last row. 129-16: the neutral log is
// separate from the log of the cap.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GAP_MS, MAX_VISITS_PER_DAY } from "./peek";
import { nextRow, takeVisit } from "./visits";

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

test("129-15: the next row is never the last row of the same key", () => {
  const items = fakeStorage();
  const LAST = "chalk.season.last.v1";
  for (const r of [0, 0.3, 0.6, 0.99, 1]) {
    items.set(LAST, JSON.stringify({ neutral: 2, midsummer: 0 }));
    const i = nextRow("neutral", 5, () => r);
    assert.notEqual(i, 2, String(r));
    assert.ok(i >= 0 && i < 5);
    assert.equal(JSON.parse(items.get(LAST)!).neutral, i);
    assert.equal(JSON.parse(items.get(LAST)!).midsummer, 0);
  }
});

test("129-15: a corrupt last row lets any row come", () => {
  const items = fakeStorage();
  for (const bad of ['{"neutral":"2"}', '{"neutral":9}', '{"neutral":-1}']) {
    items.set("chalk.season.last.v1", bad);
    assert.equal(nextRow("neutral", 5, () => 0.5), 2, bad);
  }
});

test("129-16: a neutral claim keeps the season log and the windows hold across pages", () => {
  const items = fakeStorage(JSON.stringify({ day: "", count: 0, nextAt: 0 }));
  const morning = new Date(2026, 10, 10, 11, 58).getTime();
  assert.equal(takeVisit(morning, true), true);
  assert.equal(takeVisit(morning + 1, true), false);
  assert.equal(JSON.parse(items.get(KEY)!).count, 0);
  assert.deepEqual(JSON.parse(items.get("chalk.season.neutral.v1")!).done, [true, false]);
  assert.equal(takeVisit(morning, false), true);
});

test("129-16: a corrupt neutral entry is replaced", () => {
  const bads = ["{", '{"day":"d","at":[1],"done":[]}', '{"day":"d","at":["x"],"done":[true]}'];
  bads.forEach((bad, i) => {
    const morning = new Date(2026, 10, 11 + i, 11, 58).getTime();
    const items = fakeStorage();
    items.set("chalk.season.neutral.v1", bad);
    takeVisit(morning - 3 * HOUR, true);
    const log = JSON.parse(items.get("chalk.season.neutral.v1")!);
    assert.equal(log.day, `2026-11-${11 + i}`, bad);
    assert.equal(log.at.length, 2, bad);
  });
});
