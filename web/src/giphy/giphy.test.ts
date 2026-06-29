import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectGiphyPref,
  GIPHY_SENTINEL,
  encodeGiphyBody,
  parseGiphyBody,
  isAllowedGiphyURL,
  decideGiphyRender,
} from "./giphy";
import type { UserPrefs } from "../state/types";

const GIF = "https://media2.giphy.com/media/abc123/giphy.gif";

// ---- selectGiphyPref ---------------------------------------------------

test("selectGiphyPref defaults to unset", () => {
  assert.equal(selectGiphyPref(undefined), "unset");
  assert.equal(selectGiphyPref({} as UserPrefs), "unset");
  assert.equal(selectGiphyPref({ giphy: undefined } as UserPrefs), "unset");
});

test("selectGiphyPref passes through valid values", () => {
  assert.equal(selectGiphyPref({ giphy: "enabled" } as UserPrefs), "enabled");
  assert.equal(selectGiphyPref({ giphy: "disabled" } as UserPrefs), "disabled");
  assert.equal(selectGiphyPref({ giphy: "unset" } as UserPrefs), "unset");
});

test("selectGiphyPref coerces garbage to unset", () => {
  assert.equal(selectGiphyPref({ giphy: "ENABLED" } as unknown as UserPrefs), "unset");
  assert.equal(selectGiphyPref({ giphy: "yes" } as unknown as UserPrefs), "unset");
  assert.equal(selectGiphyPref({ giphy: 1 } as unknown as UserPrefs), "unset");
});

// ---- marker encode/parse ----------------------------------------------

test("encode/parse round-trips the url", () => {
  const body = encodeGiphyBody(GIF);
  assert.ok(body.startsWith(GIPHY_SENTINEL));
  assert.deepEqual(parseGiphyBody(body), { url: GIF });
});

test("parseGiphyBody returns null for ordinary text", () => {
  assert.equal(parseGiphyBody("hello world"), null);
  assert.equal(parseGiphyBody("https://media.giphy.com/x.gif"), null); // bare url, no marker
  assert.equal(parseGiphyBody(""), null);
});

test("parseGiphyBody rejects a marker with empty url", () => {
  assert.equal(parseGiphyBody(GIPHY_SENTINEL), null);
});

test("a user typing the literal sentinel is still parsed as giphy (explicit marker, by design)", () => {
  // This is acceptable: the marker is unambiguous and the rendered URL is
  // still host-allowlisted before any fetch. Documenting the intent.
  const body = GIPHY_SENTINEL + GIF;
  assert.deepEqual(parseGiphyBody(body), { url: GIF });
});

// ---- host allowlist ----------------------------------------------------

test("isAllowedGiphyURL accepts known Giphy CDN hosts", () => {
  for (const h of [
    "media.giphy.com",
    "media0.giphy.com",
    "media1.giphy.com",
    "media2.giphy.com",
    "media3.giphy.com",
    "media4.giphy.com",
    "i.giphy.com",
  ]) {
    assert.equal(isAllowedGiphyURL(`https://${h}/media/x/giphy.gif`), true, h);
  }
});

test("isAllowedGiphyURL is case-insensitive on host", () => {
  assert.equal(isAllowedGiphyURL("https://Media2.Giphy.Com/x.gif"), true);
});

test("isAllowedGiphyURL rejects non-https", () => {
  assert.equal(isAllowedGiphyURL("http://media.giphy.com/x.gif"), false);
});

test("isAllowedGiphyURL rejects non-Giphy and spoofed hosts", () => {
  assert.equal(isAllowedGiphyURL("https://evil.com/x.gif"), false);
  assert.equal(isAllowedGiphyURL("https://giphy.com/x.gif"), false); // not a media host
  assert.equal(isAllowedGiphyURL("https://media.giphy.com.evil.com/x.gif"), false);
  assert.equal(isAllowedGiphyURL("https://notgiphy.com/media.giphy.com"), false);
});

test("isAllowedGiphyURL fails closed on malformed input", () => {
  assert.equal(isAllowedGiphyURL("not a url"), false);
  assert.equal(isAllowedGiphyURL(""), false);
  assert.equal(isAllowedGiphyURL("javascript:alert(1)"), false);
});

// ---- decideGiphyRender (the privacy invariant) ------------------------

test("decideGiphyRender: non-giphy body renders as text regardless of pref", () => {
  for (const p of ["unset", "enabled", "disabled"] as const) {
    assert.deepEqual(decideGiphyRender("just a message", p), { mode: "text" });
  }
});

test("decideGiphyRender: enabled + allowlisted => image (the only fetch path)", () => {
  assert.deepEqual(decideGiphyRender(encodeGiphyBody(GIF), "enabled"), {
    mode: "image",
    url: GIF,
  });
});

test("decideGiphyRender: enabled + bad host => blocked/bad_host (never fetched)", () => {
  const evil = encodeGiphyBody("https://evil.com/track.gif");
  assert.deepEqual(decideGiphyRender(evil, "enabled"), {
    mode: "blocked",
    url: "https://evil.com/track.gif",
    reason: "bad_host",
  });
});

test("decideGiphyRender: disabled => blocked/disabled even for a valid Giphy url", () => {
  assert.deepEqual(decideGiphyRender(encodeGiphyBody(GIF), "disabled"), {
    mode: "blocked",
    url: GIF,
    reason: "disabled",
  });
});

test("decideGiphyRender: unset => blocked/unset (offer consent, never auto-fetch)", () => {
  assert.deepEqual(decideGiphyRender(encodeGiphyBody(GIF), "unset"), {
    mode: "blocked",
    url: GIF,
    reason: "unset",
  });
});

test("two-sided gating: the same body resolves differently per viewer pref", () => {
  const body = encodeGiphyBody(GIF);
  assert.equal(decideGiphyRender(body, "enabled").mode, "image");
  assert.equal(decideGiphyRender(body, "disabled").mode, "blocked");
  assert.equal(decideGiphyRender(body, "unset").mode, "blocked");
});
