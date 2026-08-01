import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findLinks,
  linkDisplayText,
  linkHref,
  LINK_LABEL_MAX,
  LINK_LABEL_THRESHOLD,
  splitBodyParts,
} from "./links.ts";

const known = new Set(["alice", "bob"]);

const hrefs = (body: string) => findLinks(body).map((l) => l.href);
const texts = (body: string) => findLinks(body).map((l) => body.slice(l.start, l.end));

test("finds http and https urls", () => {
  assert.deepEqual(hrefs("see https://example.com/x"), ["https://example.com/x"]);
  assert.deepEqual(hrefs("see http://example.com"), ["http://example.com"]);
});

test("finds several urls in one body, in order", () => {
  assert.deepEqual(hrefs("a https://one.example b https://two.example c"), [
    "https://one.example",
    "https://two.example",
  ]);
});

test("a body with no url yields nothing", () => {
  assert.deepEqual(findLinks("just talking about example.com really"), []);
  assert.deepEqual(findLinks(""), []);
});

test("only http(s) is recognised -- no script or local-file schemes", () => {
  // The pattern cannot match these at all, which is the point.
  assert.deepEqual(findLinks("javascript:alert(1)"), []);
  assert.deepEqual(findLinks("data:text/html;base64,PHNjcmlwdD4="), []);
  assert.deepEqual(findLinks("file:///etc/passwd"), []);
  assert.deepEqual(findLinks("ftp://example.com/x"), []);
  // ...including when one is glued to the end of a real link.
  assert.deepEqual(hrefs("https://example.com javascript:alert(1)"), ["https://example.com"]);
});

test("linkHref rejects malformed leftovers the pattern can still match", () => {
  assert.equal(linkHref("https://"), null);
  assert.equal(linkHref("http://"), null);
  assert.equal(linkHref("https://example.com"), "https://example.com");
});

test("sentence punctuation after a url is not part of it", () => {
  assert.deepEqual(hrefs("read https://example.com/page."), ["https://example.com/page"]);
  assert.deepEqual(hrefs("really? https://example.com/x?!"), ["https://example.com/x"]);
  assert.deepEqual(hrefs('he said "https://example.com/x"'), ["https://example.com/x"]);
  assert.deepEqual(hrefs("<https://example.com/x>"), ["https://example.com/x"]);
});

test("a query string survives -- only trailing punctuation goes", () => {
  assert.deepEqual(hrefs("https://example.com/s?q=a&b=c"), ["https://example.com/s?q=a&b=c"]);
});

test("balanced brackets stay in the url, unbalanced ones do not", () => {
  assert.deepEqual(hrefs("https://en.wikipedia.org/wiki/Foo_(bar)"), [
    "https://en.wikipedia.org/wiki/Foo_(bar)",
  ]);
  assert.deepEqual(hrefs("(see https://example.com/x)"), ["https://example.com/x"]);
});

test("the linked text is exactly the matched substring", () => {
  const body = "read https://example.com/page. thanks";
  assert.deepEqual(texts(body), ["https://example.com/page"]);
});

test("splitBodyParts rejoins to the original body", () => {
  for (const body of [
    "plain text",
    "hi @alice see https://example.com/x ok",
    "https://example.com",
    "@alice",
    "",
  ]) {
    assert.equal(
      splitBodyParts(body, known)
        .map((p) => p.text)
        .join(""),
      body,
    );
  }
});

test("splitBodyParts marks links and mentions side by side", () => {
  const parts = splitBodyParts("hi @alice see https://example.com/x", known);
  assert.deepEqual(
    parts.map((p) => [p.text, p.handle ?? null, p.href ?? null]),
    [
      ["hi ", null, null],
      ["@alice", "alice", null],
      [" see ", null, null],
      ["https://example.com/x", null, "https://example.com/x"],
    ],
  );
});

test("a mention-shaped path inside a url stays part of the link", () => {
  // The regression this ordering exists for: /@alice is a real URL shape
  // (Mastodon, Medium, YouTube), and splitting it would break the link.
  const parts = splitBodyParts("look at https://social.example/@alice/109", known);
  assert.equal(parts.filter((p) => p.handle).length, 0);
  assert.deepEqual(
    parts.filter((p) => p.href).map((p) => p.text),
    ["https://social.example/@alice/109"],
  );
});

test("a mention immediately after a url is not a mention", () => {
  // Masking the URL with word characters is what keeps this consistent with
  // how the same body reads without any link handling at all.
  const body = "https://example.com/x@alice";
  assert.equal(splitBodyParts(body, known).filter((p) => p.handle).length, 0);
});

test("a body that is only a link is one part", () => {
  const parts = splitBodyParts("https://example.com", known);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].href, "https://example.com");
});

// A URL pushed just over the label threshold by query junk, so the
// host/path expectation stays readable in each test.
const long = (base: string) =>
  base + (base.includes("?") ? "&" : "?") + "t=" + "x".repeat(LINK_LABEL_THRESHOLD + 1 - base.length);

test("linkDisplayText leaves short urls and non-urls alone", () => {
  assert.equal(linkDisplayText("https://example.com/docs"), "https://example.com/docs");
  assert.equal(linkDisplayText(""), "");
});

test("linkDisplayText labels only past the threshold", () => {
  const base = "https://example.com/a?q=";
  const atLimit = base + "x".repeat(LINK_LABEL_THRESHOLD - base.length);
  assert.equal(atLimit.length, LINK_LABEL_THRESHOLD);
  assert.equal(linkDisplayText(atLimit), atLimit);
  assert.equal(linkDisplayText(atLimit + "x"), "example.com/a…");
});

test("linkDisplayText keeps the start of the path, drops query and fragment", () => {
  assert.equal(linkDisplayText(long("https://amazon.de/dp/B09DG3S8M9")), "amazon.de/dp/B09DG3S8M9…");
  assert.equal(
    linkDisplayText("https://example.com/watch#" + "x".repeat(LINK_LABEL_THRESHOLD)),
    "example.com/watch…",
  );
});

test("linkDisplayText clips a long path at LINK_LABEL_MAX", () => {
  const url = "https://example.com/" + "a".repeat(100);
  const label = linkDisplayText(url);
  assert.equal(label, ("example.com/" + "a".repeat(100)).slice(0, LINK_LABEL_MAX) + "…");
  assert.equal(label.length, LINK_LABEL_MAX + 1);
});

test("linkDisplayText shows no ellipsis when nothing meaningful is omitted", () => {
  // Only reachable with a port: dropping scheme+port is what gets a
  // 73-char URL down to a 60-char host+path with no query to lose.
  const path = "/" + "a".repeat(48);
  const url = "https://example.com:8443" + path;
  assert.ok(url.length > LINK_LABEL_THRESHOLD);
  assert.equal(linkDisplayText(url), "example.com" + path);
});

test("linkDisplayText collapses a bare / path to the host alone", () => {
  assert.equal(linkDisplayText(long("https://example.com/")), "example.com…");
});

test("linkDisplayText strips a leading www. and only that", () => {
  assert.equal(linkDisplayText(long("https://www.amazon.de/dp/x")), "amazon.de/dp/x…");
  assert.equal(linkDisplayText(long("https://wwwx.example/a")), "wwwx.example/a…");
});

test("linkDisplayText keeps punycode hosts as-is", () => {
  // Showing the punycode form is deliberate: no homograph prettifying.
  assert.equal(linkDisplayText(long("https://xn--mnchen-3ya.de/x")), "xn--mnchen-3ya.de/x…");
});

test("linkDisplayText drops the port", () => {
  assert.equal(linkDisplayText(long("https://example.com:8443/x")), "example.com/x…");
});

test("linkDisplayText labels the real host, not spoofed userinfo", () => {
  assert.equal(linkDisplayText(long("https://amazon.de@evil.example/x")), "evil.example/x…");
});

test("linkDisplayText handles an ip host", () => {
  assert.equal(linkDisplayText(long("http://192.168.0.1/x")), "192.168.0.1/x…");
});

test("linkDisplayText keeps the path undecoded", () => {
  assert.equal(linkDisplayText(long("https://example.com/a%20b%2Fc")), "example.com/a%20b%2Fc…");
});

test("linkDisplayText returns unparseable input unchanged", () => {
  const junk = "x".repeat(LINK_LABEL_THRESHOLD + 10);
  assert.equal(linkDisplayText(junk), junk);
});

test("splitBodyParts falls back to plain mention splitting with no links", () => {
  const parts = splitBodyParts("hey @bob", known);
  assert.deepEqual(
    parts.map((p) => [p.text, p.handle ?? null]),
    [
      ["hey ", null],
      ["@bob", "bob"],
    ],
  );
  assert.equal(parts.every((p) => p.href === undefined), true);
});
