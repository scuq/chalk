// The parking lot's two stored values: the title (account pref, normalized on
// read) and whether this device is parked (localStorage, survives a reload).
//
// The title matters more than it looks: it's the only label on the row, so
// "empty" or "forty lines of whitespace" has to resolve to something a person
// can click, whatever ends up in the prefs blob.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PARKING_LOT_DEFAULT_NAME,
  PARKING_LOT_NAME_MAX,
  loadParked,
  parkingLotName,
  saveParked,
} from "./parking.ts";
import { selectParkingLotPrefs } from "./state/types.ts";

test("a normal name is kept as typed", () => {
  assert.equal(parkingLotName("Coffee"), "Coffee");
});

test("blank, whitespace and non-strings fall back to the default", () => {
  for (const junk of ["", "   ", "\n\t", null, undefined, 42, {}, ["nope"]]) {
    assert.equal(parkingLotName(junk), PARKING_LOT_DEFAULT_NAME);
  }
});

test("names are collapsed to one trimmed line", () => {
  assert.equal(parkingLotName("  the   quiet\nplace  "), "the quiet place");
});

test("an over-long name is capped rather than rejected", () => {
  const name = parkingLotName("x".repeat(200));
  assert.equal(name.length, PARKING_LOT_NAME_MAX);
});

test("selectParkingLotPrefs defaults to a visible, default-named row", () => {
  assert.deepEqual(selectParkingLotPrefs(undefined), {
    name: PARKING_LOT_DEFAULT_NAME,
    hidden: false,
  });
  assert.deepEqual(selectParkingLotPrefs({}), {
    name: PARKING_LOT_DEFAULT_NAME,
    hidden: false,
  });
});

test("selectParkingLotPrefs reads a stored name and hide flag", () => {
  assert.deepEqual(selectParkingLotPrefs({ parkingLot: { name: " away ", hidden: true } }), {
    name: "away",
    hidden: true,
  });
});

test("only a literal true hides the row", () => {
  for (const v of ["true", 1, null, undefined]) {
    assert.equal(
      selectParkingLotPrefs({ parkingLot: { hidden: v as unknown as boolean } }).hidden,
      false,
    );
  }
});

// The parked flag. Stubbed storage rather than a DOM: what's being tested is
// that a missing or junk entry reads as "not parked" and that saving false
// clears the entry instead of leaving a falsey string behind.
function withStorage(store: Map<string, string> | null, fn: () => void) {
  const g = globalThis as { window?: unknown };
  const prev = g.window;
  g.window = {
    localStorage: {
      getItem(k: string) {
        if (!store) throw new Error("storage disabled");
        return store.has(k) ? store.get(k)! : null;
      },
      setItem(k: string, v: string) {
        if (!store) throw new Error("storage disabled");
        store.set(k, v);
      },
      removeItem(k: string) {
        if (!store) throw new Error("storage disabled");
        store.delete(k);
      },
    },
  };
  try {
    fn();
  } finally {
    g.window = prev;
  }
}

test("parked survives a save/load round trip", () => {
  const store = new Map<string, string>();
  withStorage(store, () => {
    assert.equal(loadParked(), false);
    saveParked(true);
    assert.equal(loadParked(), true);
    saveParked(false);
    assert.equal(store.size, 0);
    assert.equal(loadParked(), false);
  });
});

test("a junk entry reads as not parked", () => {
  const store = new Map<string, string>([["chalk.parked.v1", "yes"]]);
  withStorage(store, () => {
    assert.equal(loadParked(), false);
  });
});

test("storage that throws does not break startup", () => {
  withStorage(null, () => {
    assert.equal(loadParked(), false);
    saveParked(true); // must not throw
  });
});
