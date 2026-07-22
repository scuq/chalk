import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SELF_HUE,
  clampHue,
  hueFromString,
  hueFromHex,
  hexFromHue,
  resolveNickHue,
} from "./nickcolor.ts";

test("clampHue normalises range and rejects junk", () => {
  assert.equal(clampHue(0), 0);
  assert.equal(clampHue(359), 359);
  assert.equal(clampHue(360), 0);
  assert.equal(clampHue(-30), 330);
  assert.equal(clampHue(725), 5);
  // Non-finite must not leak NaN into a CSS custom property.
  assert.equal(clampHue(NaN), DEFAULT_SELF_HUE);
  assert.equal(clampHue(Infinity), DEFAULT_SELF_HUE);
});

test("hueFromString is stable, case-insensitive, and in range", () => {
  const a = hueFromString("alice9");
  assert.equal(a, hueFromString("alice9"), "same input, same hue");
  assert.equal(a, hueFromString("ALICE9"), "case-insensitive");
  assert.ok(a >= 0 && a < 360);
});

test("hueFromString separates typical handles", () => {
  const hues = ["alice9", "craigtester", "andowin", "scuq"].map(hueFromString);
  assert.equal(new Set(hues).size, hues.length, "no collisions on these");
});

test("hueFromHex reads primaries and tolerates a missing #", () => {
  assert.equal(hueFromHex("#ff0000"), 0);
  assert.equal(hueFromHex("#00ff00"), 120);
  assert.equal(hueFromHex("#0000ff"), 240);
  assert.equal(hueFromHex("00ff00"), 120);
});

test("hueFromHex returns null for unparseable input, 0 for greyscale", () => {
  assert.equal(hueFromHex("nope"), null);
  assert.equal(hueFromHex("#ff"), null);
  assert.equal(hueFromHex(""), null);
  assert.equal(hueFromHex("#808080"), 0, "grey has no hue but is a real pick");
});

test("hexFromHue round-trips back through hueFromHex", () => {
  for (const h of [0, 45, 120, 210, 300, 359]) {
    const back = hueFromHex(hexFromHue(h));
    assert.ok(back !== null);
    // Allow 1 degree of 8-bit rounding slack.
    assert.ok(Math.abs((back as number) - h) <= 1, `${h} -> ${back}`);
  }
});

test("resolveNickHue returns null when the feature is off", () => {
  assert.equal(
    resolveNickHue({
      enabled: false,
      own: false,
      handle: "alice9",
      selfHue: DEFAULT_SELF_HUE,
      userHues: {},
    }),
    null,
  );
});

test("resolveNickHue uses the self colour for own messages", () => {
  assert.equal(
    resolveNickHue({
      enabled: true,
      own: true,
      handle: "scuq",
      selfHue: 200,
      userHues: {},
    }),
    200,
  );
});

test("resolveNickHue precedence: explicit pick beats legacy hex beats hash", () => {
  const base = {
    enabled: true,
    own: false,
    handle: "alice9",
    selfHue: DEFAULT_SELF_HUE,
  };
  const legacy = new Map([["alice9", "#00ff00"]]); // hue 120

  // explicit wins
  assert.equal(
    resolveNickHue({ ...base, userHues: { alice9: 42 }, legacyColorByHandle: legacy }),
    42,
  );
  // legacy wins over the hash
  assert.equal(
    resolveNickHue({ ...base, userHues: {}, legacyColorByHandle: legacy }),
    120,
  );
  // hash is the fallback
  assert.equal(
    resolveNickHue({ ...base, userHues: {} }),
    hueFromString("alice9"),
  );
});

test("resolveNickHue matches handles case-insensitively", () => {
  assert.equal(
    resolveNickHue({
      enabled: true,
      own: false,
      handle: "Alice9",
      selfHue: DEFAULT_SELF_HUE,
      userHues: { alice9: 77 },
    }),
    77,
  );
});

test("resolveNickHue returns null when there is no handle to key off", () => {
  for (const handle of [null, undefined, "", "   "]) {
    assert.equal(
      resolveNickHue({
        enabled: true,
        own: false,
        handle,
        selfHue: DEFAULT_SELF_HUE,
        userHues: {},
      }),
      null,
    );
  }
});
