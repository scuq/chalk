import { test } from "node:test";
import assert from "node:assert/strict";
import { permissionAllowed, originOfURL } from "./permissions";

const S = "https://chat.example.org";

test("permissionAllowed: the server origin gets the short list", () => {
  for (const p of ["media", "display-capture", "notifications", "clipboard-sanitized-write"]) {
    assert.equal(permissionAllowed(p, S, S), true, p);
  }
});

test("permissionAllowed: nothing outside the list", () => {
  for (const p of ["geolocation", "midi", "openExternal", "usb", "hid", "serial", "pointerLock"]) {
    assert.equal(permissionAllowed(p, S, S), false, p);
  }
});

test("permissionAllowed: other origins and the picker get nothing", () => {
  assert.equal(permissionAllowed("media", "https://evil.example", S), false);
  assert.equal(permissionAllowed("media", "http://chat.example.org", S), false);
  assert.equal(permissionAllowed("media", null, S), false);
  assert.equal(permissionAllowed("media", S, null), false);
  assert.equal(permissionAllowed("media", "file://", null), false);
});

test("originOfURL", () => {
  assert.equal(originOfURL("https://chat.example.org/x/y?z"), "https://chat.example.org");
  assert.equal(originOfURL(undefined), null);
  assert.equal(originOfURL(""), null);
  assert.equal(originOfURL("nope"), null);
});
