// The parking lot's stored title (account pref, normalized on read).
//
// The title matters more than it looks: it's the only label on the row, so
// "empty" or "forty lines of whitespace" has to resolve to something a person
// can click, whatever ends up in the prefs blob.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PARKING_LOT_DEFAULT_NAME,
  PARKING_LOT_NAME_MAX,
  parkingLotName,
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
    screen: false,
  });
  assert.deepEqual(selectParkingLotPrefs({}), {
    name: PARKING_LOT_DEFAULT_NAME,
    hidden: false,
    screen: false,
  });
});

test("selectParkingLotPrefs reads a stored name and hide flag", () => {
  assert.deepEqual(
    selectParkingLotPrefs({ parkingLot: { name: " away ", hidden: true, screen: true } }),
    { name: "away", hidden: true, screen: true },
  );
});

test("only a literal true hides the row", () => {
  for (const v of ["true", 1, null, undefined]) {
    assert.equal(
      selectParkingLotPrefs({ parkingLot: { hidden: v as unknown as boolean } }).hidden,
      false,
    );
  }
});

// 53-5: same rule for the privacy screen, and for the same reason -- junk in
// the prefs blob must resolve to the quiet default, not to a blurred window
// nobody asked for.
test("the privacy screen is off unless it was literally turned on", () => {
  for (const v of ["true", 1, null, undefined, {}]) {
    assert.equal(
      selectParkingLotPrefs({ parkingLot: { screen: v as unknown as boolean } }).screen,
      false,
    );
  }
  assert.equal(selectParkingLotPrefs({ parkingLot: { screen: true } }).screen, true);
});
