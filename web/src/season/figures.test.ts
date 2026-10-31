// 129-5: the figures in the registry and the files on disk agree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { SEASONS } from "./seasons";
import { FIGURES } from "./figures";

const assets = join(resolve(process.cwd()), "assets", "season");

test("every figure in the registry has a file, a URL and a label", () => {
  for (const s of SEASONS) {
    for (const f of s.figures) {
      const key = `${s.id}/${f}`;
      const fig = FIGURES[key];
      assert.ok(fig, `${key} is not in FIGURES`);
      assert.ok(fig.src.length > 0, `${key} has no URL`);
      assert.match(fig.label, /^(a|an) |^[a-z]/, `${key} has no label`);
      assert.ok(existsSync(join(assets, s.id, `${f}.png`)), `${key}.png is missing`);
    }
  }
});

test("no figure file is listed that the registry does not use", () => {
  const used = new Set(SEASONS.flatMap((s) => s.figures.map((f) => `${s.id}/${f}`)));
  for (const key of Object.keys(FIGURES)) assert.ok(used.has(key), `${key} is in FIGURES but in no season`);
});
