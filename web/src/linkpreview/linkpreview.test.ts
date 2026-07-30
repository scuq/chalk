import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectLinkPreviewPref,
  effectiveLinkPreviewDomains,
  isWhitelistedURL,
  findPreviewableURL,
  LINKPREVIEW_SENTINEL,
  LINKPREVIEW_MAX_TITLE,
  LINKPREVIEW_MAX_DESC,
  encodeLinkPreviewBody,
  parseLinkPreviewBody,
  sanitizeLinkPreviewPayload,
  decideLinkPreviewOffer,
  decideLinkPreviewRender,
  type LinkPreviewPayload,
} from "./linkpreview";
import type { UserPrefs } from "../state/types";

const DOMAINS = ["youtube.com", "youtu.be", "store.steampowered.com"];

const PREVIEW: LinkPreviewPayload = {
  url: "https://www.youtube.com/watch?v=abc",
  title: "A Video",
  description: "About things",
  site_name: "YouTube",
};

// ---- selectLinkPreviewPref ---------------------------------------------

test("selectLinkPreviewPref defaults to unset", () => {
  assert.equal(selectLinkPreviewPref(undefined), "unset");
  assert.equal(selectLinkPreviewPref({} as UserPrefs), "unset");
});

test("selectLinkPreviewPref passes through valid values, coerces garbage", () => {
  assert.equal(selectLinkPreviewPref({ linkpreview: "enabled" } as UserPrefs), "enabled");
  assert.equal(selectLinkPreviewPref({ linkpreview: "disabled" } as UserPrefs), "disabled");
  assert.equal(selectLinkPreviewPref({ linkpreview: "yes" } as unknown as UserPrefs), "unset");
});

// ---- effectiveLinkPreviewDomains ---------------------------------------

test("effectiveLinkPreviewDomains: server list passes through", () => {
  assert.deepEqual(effectiveLinkPreviewDomains(DOMAINS, undefined), DOMAINS);
});

test("effectiveLinkPreviewDomains: user adds and removes", () => {
  const prefs = {
    linkpreviewDomains: { added: ["Example.COM", "youtube.com"], removed: ["youtu.be"] },
  } as UserPrefs;
  assert.deepEqual(effectiveLinkPreviewDomains(DOMAINS, prefs), [
    "youtube.com",
    "store.steampowered.com",
    "example.com",
  ]);
});

test("effectiveLinkPreviewDomains: garbage entries dropped", () => {
  const prefs = {
    linkpreviewDomains: { added: ["https://x.com", "a b.com", "", 5, "ok.com"] },
  } as unknown as UserPrefs;
  assert.deepEqual(effectiveLinkPreviewDomains([], prefs), ["ok.com"]);
});

// ---- whitelist matching ------------------------------------------------

test("isWhitelistedURL matches exact host and subdomains only", () => {
  assert.ok(isWhitelistedURL("https://youtube.com/watch", DOMAINS));
  assert.ok(isWhitelistedURL("https://www.youtube.com/watch", DOMAINS));
  assert.ok(isWhitelistedURL("https://YOUTU.BE/abc", DOMAINS));
  assert.ok(!isWhitelistedURL("https://notyoutube.com/", DOMAINS));
  assert.ok(!isWhitelistedURL("https://youtube.com.evil.com/", DOMAINS));
  assert.ok(!isWhitelistedURL("https://steampowered.com/", DOMAINS)); // parent of an entry
});

test("isWhitelistedURL fails closed on scheme, userinfo, garbage", () => {
  assert.ok(!isWhitelistedURL("http://youtube.com/", DOMAINS));
  assert.ok(!isWhitelistedURL("https://user:pw@youtube.com/", DOMAINS));
  assert.ok(!isWhitelistedURL("not a url", DOMAINS));
  assert.ok(!isWhitelistedURL("https://youtube.com/", []));
});

test("findPreviewableURL finds the first whitelisted url, strips punctuation", () => {
  assert.equal(
    findPreviewableURL("look: https://youtu.be/abc, amazing", DOMAINS),
    "https://youtu.be/abc",
  );
  assert.equal(
    findPreviewableURL("(see https://en.wikipedia.org/x and https://youtube.com/watch?v=1)", DOMAINS),
    "https://youtube.com/watch?v=1",
  );
  assert.equal(findPreviewableURL("no links here", DOMAINS), null);
  assert.equal(findPreviewableURL("https://example.com only", DOMAINS), null);
});

// ---- encode / parse round-trip -----------------------------------------

test("encode/parse round-trips preview and text", () => {
  const body = encodeLinkPreviewBody(PREVIEW, "check this out");
  assert.ok(body.startsWith(LINKPREVIEW_SENTINEL));
  const parsed = parseLinkPreviewBody(body);
  assert.ok(parsed);
  assert.equal(parsed.text, "check this out");
  assert.equal(parsed.preview.title, "A Video");
  assert.equal(parsed.preview.url, "https://www.youtube.com/watch?v=abc");
});

test("encode with an unusable preview degrades to plain text", () => {
  const body = encodeLinkPreviewBody({ ...PREVIEW, url: "http://x.com" }, "hi");
  assert.equal(body, "hi");
});

test("parse returns null for ordinary text and bare sentinel", () => {
  assert.equal(parseLinkPreviewBody("hello"), null);
  assert.equal(parseLinkPreviewBody(""), null);
  assert.equal(parseLinkPreviewBody(LINKPREVIEW_SENTINEL), null); // no terminator
  assert.equal(parseLinkPreviewBody(LINKPREVIEW_SENTINEL + "{}"), null);
});

test("parse survives hostile payloads by degrading to text mode", () => {
  const bad = [
    "not json\u0001hi",
    "[]\u0001hi",
    "null\u0001hi",
    '{"url":"javascript:alert(1)","title":"x"}\u0001hi',
    '{"url":"https://x.com"}\u0001hi', // nothing to show
    '{"title":"no url"}\u0001hi',
  ];
  for (const b of bad) {
    assert.equal(parseLinkPreviewBody(LINKPREVIEW_SENTINEL + b), null, b);
  }
});

// ---- sanitize ----------------------------------------------------------

test("sanitize caps runaway strings and drops unknown fields", () => {
  const raw = {
    url: "https://youtube.com/x",
    title: "t".repeat(10_000),
    description: "d".repeat(10_000),
    site_name: 42,
    evil_extra: "<script>",
  };
  const p = sanitizeLinkPreviewPayload(raw);
  assert.ok(p);
  assert.equal([...p.title].length, LINKPREVIEW_MAX_TITLE);
  assert.equal([...p.description].length, LINKPREVIEW_MAX_DESC);
  assert.equal(p.site_name, "");
  assert.ok(!("evil_extra" in p));
});

test("sanitize validates attachment id and dimensions", () => {
  const base = { url: "https://youtube.com/x", title: "t" };
  const ok = sanitizeLinkPreviewPayload({
    ...base,
    attachment_id: "abc-123_XYZ",
    image_w: 640,
    image_h: 360,
  });
  assert.ok(ok);
  assert.equal(ok.attachment_id, "abc-123_XYZ");
  assert.equal(ok.image_w, 640);

  const badID = sanitizeLinkPreviewPayload({ ...base, attachment_id: "../../etc" });
  assert.ok(badID);
  assert.equal(badID.attachment_id, undefined);

  const badDims = sanitizeLinkPreviewPayload({
    ...base,
    attachment_id: "a1",
    image_w: -5,
    image_h: 1e9,
  });
  assert.ok(badDims);
  assert.equal(badDims.image_w, undefined);
  assert.equal(badDims.image_h, undefined);

  // dimensions without an attachment are meaningless -> dropped
  const noAttach = sanitizeLinkPreviewPayload({ ...base, image_w: 10, image_h: 10 });
  assert.ok(noAttach);
  assert.equal(noAttach.image_w, undefined);
});

// ---- compose decision --------------------------------------------------

test("decideLinkPreviewOffer gates on pref and whitelist", () => {
  const text = "watch https://youtu.be/abc";
  assert.deepEqual(decideLinkPreviewOffer(text, "enabled", DOMAINS), {
    mode: "generate",
    url: "https://youtu.be/abc",
  });
  assert.deepEqual(decideLinkPreviewOffer(text, "unset", DOMAINS), {
    mode: "consent",
    url: "https://youtu.be/abc",
  });
  assert.deepEqual(decideLinkPreviewOffer(text, "disabled", DOMAINS), { mode: "none" });
  assert.deepEqual(decideLinkPreviewOffer("https://example.com", "enabled", DOMAINS), {
    mode: "none",
  });
});

// ---- render decision ---------------------------------------------------

test("decideLinkPreviewRender: text / preview / hidden", () => {
  assert.deepEqual(decideLinkPreviewRender("plain message", false), { mode: "text" });

  const body = encodeLinkPreviewBody(PREVIEW, "the text");
  const shown = decideLinkPreviewRender(body, false);
  assert.equal(shown.mode, "preview");
  if (shown.mode === "preview") {
    assert.equal(shown.preview.title, "A Video");
    assert.equal(shown.text, "the text");
  }

  const hidden = decideLinkPreviewRender(body, true);
  assert.deepEqual(hidden, { mode: "hidden", text: "the text" });
});

test("decideLinkPreviewRender degrades a corrupt payload to text", () => {
  assert.deepEqual(decideLinkPreviewRender(LINKPREVIEW_SENTINEL + "garbage\u0001hi", false), {
    mode: "text",
  });
});
