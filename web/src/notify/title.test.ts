// The title formatter: one function, four states, no surprises.

import { test } from "node:test";
import assert from "node:assert/strict";
import { titleFor } from "./title.ts";

test("a quiet title is just the app", () => {
  assert.equal(titleFor({ base: "chalk", count: 0, blink: "off" }), "chalk");
});

test("a count prefixes the title", () => {
  assert.equal(titleFor({ base: "chalk", count: 3, blink: "off" }), "(3) chalk");
});

test("the blink marker starts at the left end", () => {
  assert.equal(titleFor({ base: "chalk", count: 3, blink: "left" }), "● chalk");
});

test("the blink marker crosses to the right end", () => {
  assert.equal(titleFor({ base: "chalk", count: 3, blink: "right" }), "chalk ●");
});

test("the travelling marker wins over the count on both phases", () => {
  // Alternation is the whole signal, so neither phase has room for the
  // count; it comes back when the blink stops.
  for (const blink of ["left", "right"] as const) {
    assert.ok(!titleFor({ base: "chalk", count: 3, blink }).includes("(3)"));
  }
});
