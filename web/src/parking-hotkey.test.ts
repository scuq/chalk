// 53-3/53-4: the boss key. What matters is that it fires on the bare key, stays
// out of the way of every combination somebody else owns, and refuses to
// un-park while a panicked double-tap is still plausible.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideParkingPress,
  installParkingHotkey,
  isParkingHotkey,
  PARKING_HOTKEY_CODE,
  PARKING_UNPARK_GUARD_MS,
} from "./parking-hotkey.ts";

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

test("pressing it while unparked always parks, however recent the last one", () => {
  assert.equal(decideParkingPress(false, 0), "park");
  assert.equal(decideParkingPress(false, Infinity), "park");
});

test("a second press right after parking is swallowed", () => {
  assert.equal(decideParkingPress(true, 0), "ignore");
  assert.equal(decideParkingPress(true, PARKING_UNPARK_GUARD_MS - 1), "ignore");
});

test("once the guard has passed, the key is the way back", () => {
  assert.equal(decideParkingPress(true, PARKING_UNPARK_GUARD_MS), "unpark");
  assert.equal(decideParkingPress(true, 10_000), "unpark");
});

test("parking some other way does not arm the guard", () => {
  // Infinity is what the installed handler passes when the key itself has
  // never parked -- clicking the sidebar row leaves F9 free to bring you back.
  assert.equal(decideParkingPress(true, Infinity), "unpark");
});

// The handler itself: the guard is only worth anything if the clock actually
// starts when the key parks, so drive it through a fake window.
function withFakeDOM(): {
  press: (over?: Partial<Record<string, unknown>>) => { defaultPrevented: boolean };
  restore: () => void;
} {
  const listeners: ((e: KeyboardEvent) => void)[] = [];
  const g = globalThis as Record<string, unknown>;
  const hadWindow = "window" in g;
  const hadDocument = "document" in g;
  g.window = {
    addEventListener: (_type: string, fn: (e: KeyboardEvent) => void) => listeners.push(fn),
    removeEventListener: (_type: string, fn: (e: KeyboardEvent) => void) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  g.document = { activeElement: null };
  return {
    press: (over = {}) => {
      let defaultPrevented = false;
      const e = {
        ...ev(),
        repeat: false,
        preventDefault: () => {
          defaultPrevented = true;
        },
        ...over,
      };
      for (const fn of [...listeners]) fn(e as unknown as KeyboardEvent);
      return { defaultPrevented };
    },
    restore: () => {
      if (!hadWindow) delete g.window;
      if (!hadDocument) delete g.document;
    },
  };
}

test("the key parks, waits out the guard, then brings you back", (t) => {
  const dom = withFakeDOM();
  t.after(dom.restore);

  let parked = false;
  const calls: string[] = [];
  let clock = 1_000;
  const uninstall = installParkingHotkey(
    {
      isParked: () => parked,
      park: () => {
        parked = true;
        calls.push("park");
      },
      unpark: () => {
        parked = false;
        calls.push("unpark");
      },
    },
    () => clock,
  );

  dom.press();
  assert.deepEqual(calls, ["park"]);

  // The panicked double-tap.
  clock += 100;
  dom.press();
  assert.deepEqual(calls, ["park"]);

  clock += PARKING_UNPARK_GUARD_MS;
  dom.press();
  assert.deepEqual(calls, ["park", "unpark"]);

  // And parking again re-arms it.
  clock += 1;
  dom.press();
  clock += 1;
  dom.press();
  assert.deepEqual(calls, ["park", "unpark", "park"]);

  uninstall();
  clock += 10_000;
  dom.press();
  assert.deepEqual(calls, ["park", "unpark", "park"]);
});

test("the key is eaten even when it does nothing, and auto-repeat is not a press", (t) => {
  const dom = withFakeDOM();
  t.after(dom.restore);

  const calls: string[] = [];
  const uninstall = installParkingHotkey(
    {
      isParked: () => true,
      park: () => calls.push("park"),
      unpark: () => calls.push("unpark"),
    },
    () => 0,
  );

  // Parked, guard armed by nothing -> unparks; held down -> one press only.
  assert.equal(dom.press({ repeat: true }).defaultPrevented, true);
  assert.deepEqual(calls, []);
  // A modified F9 passes through untouched.
  assert.equal(dom.press({ ctrlKey: true }).defaultPrevented, false);
  uninstall();
});
