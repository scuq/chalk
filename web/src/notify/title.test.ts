// The title formatter: one function, three states, no surprises.

import { test } from "node:test";
import assert from "node:assert/strict";
import { titleFor } from "./title.ts";

test("a quiet title is just the app", () => {
  assert.equal(titleFor({ base: "chalk", count: 0, blinkOn: false }), "chalk");
});

test("a count prefixes the title", () => {
  assert.equal(titleFor({ base: "chalk", count: 3, blinkOn: false }), "(3) chalk");
});

test("the blink phase wins over the count", () => {
  // While blinking, alternation is the signal; the count comes back on
  // the off-phase and when the blink stops.
  assert.equal(titleFor({ base: "chalk", count: 3, blinkOn: true }), "● chalk");
});
