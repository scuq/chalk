// 53-3: the boss key. What matters is that it fires on the bare key and stays
// out of the way of every combination somebody else owns.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isParkingHotkey, PARKING_HOTKEY_CODE } from "./parking-hotkey.ts";

function ev(over: Partial<Record<string, unknown>> = {}) {
  return {
    code: PARKING_HOTKEY_CODE,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...over,
  } as { code: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean };
}

test("a bare F9 parks", () => {
  assert.equal(isParkingHotkey(ev()), true);
});

test("any other key is not the boss key", () => {
  assert.equal(isParkingHotkey(ev({ code: "F8" })), false);
  assert.equal(isParkingHotkey(ev({ code: "KeyF" })), false);
});

test("a modified F9 belongs to the browser or the OS", () => {
  for (const mod of ["ctrlKey", "altKey", "metaKey", "shiftKey"]) {
    assert.equal(isParkingHotkey(ev({ [mod]: true })), false, mod);
  }
});
