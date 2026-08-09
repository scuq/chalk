// Tests for crypto/wseq.ts -- 83-2 writer sequence.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { nextWseq } from "./wseq";

function mapStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
    map: m,
  };
}

test("wseq starts at 1 and increases strictly per scope", () => {
  const s = mapStorage();
  assert.equal(nextWseq("scope-a", s), 1);
  assert.equal(nextWseq("scope-a", s), 2);
  assert.equal(nextWseq("scope-a", s), 3);
  // an independent scope has its own counter
  assert.equal(nextWseq("scope-b", s), 1);
});

test("wseq resumes from persisted high-water mark", () => {
  const s = mapStorage();
  s.setItem("chalk-wseq:scope-a", "41");
  assert.equal(nextWseq("scope-a", s), 42);
});

test("wseq treats garbage storage as fresh", () => {
  const s = mapStorage();
  s.setItem("chalk-wseq:scope-a", "not-a-number");
  assert.equal(nextWseq("scope-a", s), 1);
  s.setItem("chalk-wseq:scope-b", "-5");
  assert.equal(nextWseq("scope-b", s), 1);
});
