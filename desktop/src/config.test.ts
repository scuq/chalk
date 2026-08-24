import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeServerURL,
  rememberServer,
  forgetServer,
  parseConfig,
  hostLabel,
} from "./config";

test("normalizeServerURL: bare host becomes an https origin", () => {
  assert.equal(normalizeServerURL("chat.example.org"), "https://chat.example.org/");
  assert.equal(normalizeServerURL("  chat.example.org:8443  "), "https://chat.example.org:8443/");
});

test("normalizeServerURL: path, query and fragment are dropped", () => {
  assert.equal(
    normalizeServerURL("https://chat.example.org/join/abc?x=1#frag"),
    "https://chat.example.org/",
  );
});

test("normalizeServerURL: http only for loopback unless allowed", () => {
  assert.equal(normalizeServerURL("http://127.0.0.1:8080/"), "http://127.0.0.1:8080/");
  assert.equal(normalizeServerURL("http://localhost:8080"), "http://localhost:8080/");
  assert.equal(normalizeServerURL("http://chat.example.org"), null);
  assert.equal(normalizeServerURL("http://chat.example.org", true), "http://chat.example.org/");
});

test("normalizeServerURL: rejects other schemes, credentials and garbage", () => {
  assert.equal(normalizeServerURL("ftp://chat.example.org"), null);
  assert.equal(normalizeServerURL("file:///etc/passwd"), null);
  assert.equal(normalizeServerURL("https://user:pw@chat.example.org"), null);
  assert.equal(normalizeServerURL(""), null);
  assert.equal(normalizeServerURL("   "), null);
  assert.equal(normalizeServerURL("http://"), null);
});

test("rememberServer: dedupes, moves to front, sets last, does not mutate", () => {
  const a = { servers: [{ url: "https://a/" }, { url: "https://b/" }], last: "https://a/" };
  const b = rememberServer(a, "https://b/");
  assert.deepEqual(b, {
    servers: [{ url: "https://b/" }, { url: "https://a/" }],
    last: "https://b/",
  });
  assert.deepEqual(a.servers, [{ url: "https://a/" }, { url: "https://b/" }]);
  const c = rememberServer(b, "https://c/");
  assert.equal(c.servers.length, 3);
  assert.equal(c.servers[0].url, "https://c/");
});

test("forgetServer: removes and repoints last", () => {
  const a = { servers: [{ url: "https://a/" }, { url: "https://b/" }], last: "https://a/" };
  const b = forgetServer(a, "https://a/");
  assert.deepEqual(b, { servers: [{ url: "https://b/" }], last: "https://b/" });
  const c = forgetServer(b, "https://b/");
  assert.deepEqual(c, { servers: [] });
  assert.equal("last" in c, false);
});

test("parseConfig: tolerates garbage and drops bad entries", () => {
  assert.deepEqual(parseConfig("not json"), { servers: [] });
  assert.deepEqual(parseConfig("[]"), { servers: [] });
  assert.deepEqual(parseConfig("null"), { servers: [] });
  const cfg = parseConfig(
    JSON.stringify({
      servers: [{ url: "chat.example.org/x" }, { url: 5 }, "str", { url: "ftp://nope" }],
      last: "https://chat.example.org/",
      bounds: { x: 10.4, y: 20, width: 800.6, height: 600 },
    }),
  );
  assert.deepEqual(cfg, {
    servers: [{ url: "https://chat.example.org/" }],
    last: "https://chat.example.org/",
    bounds: { x: 10, y: 20, width: 801, height: 600 },
  });
});

test("parseConfig: last must be a known server, bounds must be sane", () => {
  const cfg = parseConfig(
    JSON.stringify({
      servers: [{ url: "https://a/" }],
      last: "https://b/",
      bounds: { width: 10, height: 10 },
    }),
  );
  assert.deepEqual(cfg, { servers: [{ url: "https://a/" }] });
});

test("hostLabel", () => {
  assert.equal(hostLabel("https://chat.example.org:8443/"), "chat.example.org:8443");
  assert.equal(hostLabel("junk"), "junk");
});
