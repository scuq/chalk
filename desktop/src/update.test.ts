import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchLatestRelease,
  isDevBuild,
  isNewer,
  parseLatestRelease,
  parseVersion,
  shouldAnnounce,
} from "./update";

test("parseVersion", () => {
  assert.deepEqual(parseVersion("v1.2.3"), { nums: [1, 2, 3], pre: false });
  assert.deepEqual(parseVersion("1.2.3"), { nums: [1, 2, 3], pre: false });
  assert.deepEqual(parseVersion("0.0.0-dev"), { nums: [0, 0, 0], pre: true });
  assert.deepEqual(parseVersion("1.2.3-rc1"), { nums: [1, 2, 3], pre: true });
  assert.equal(parseVersion("1.2"), null);
  assert.equal(parseVersion("latest"), null);
  assert.equal(parseVersion(""), null);
});

test("isNewer compares numerically, prerelease loses to its release", () => {
  assert.equal(isNewer("0.8.2", "0.9.0"), true);
  assert.equal(isNewer("0.9.0", "0.9.0"), false);
  assert.equal(isNewer("0.10.0", "0.9.9"), false);
  assert.equal(isNewer("0.9.0", "0.10.0"), true);
  assert.equal(isNewer("1.0.0", "0.99.99"), false);
  assert.equal(isNewer("0.9.0-rc1", "0.9.0"), true);
  assert.equal(isNewer("0.9.0", "0.9.0-rc2"), false);
  assert.equal(isNewer("junk", "1.0.0"), false);
  assert.equal(isNewer("1.0.0", "junk"), false);
});

test("isDevBuild", () => {
  assert.equal(isDevBuild("0.0.0-dev"), true);
  assert.equal(isDevBuild("0.9.0"), false);
  assert.equal(isDevBuild("0.9.0-rc1"), false);
});

test("parseLatestRelease accepts a GitHub release and rejects the rest", () => {
  assert.deepEqual(
    parseLatestRelease({ tag_name: "v0.9.1", html_url: "https://github.com/scuq/chalk/releases/tag/v0.9.1" }),
    { version: "0.9.1", url: "https://github.com/scuq/chalk/releases/tag/v0.9.1" },
  );
  assert.equal(parseLatestRelease({ tag_name: "v0.9.1", html_url: "https://github.com/x", draft: true }), null);
  assert.equal(parseLatestRelease({ tag_name: "v0.9.1", html_url: "https://github.com/x", prerelease: true }), null);
  assert.equal(parseLatestRelease({ tag_name: "v0.9.1", html_url: "http://github.com/x" }), null);
  assert.equal(parseLatestRelease({ tag_name: "v0.9.1", html_url: "https://evil.example/x" }), null);
  assert.equal(parseLatestRelease({ tag_name: "nightly", html_url: "https://github.com/x" }), null);
  assert.equal(parseLatestRelease(null), null);
  assert.equal(parseLatestRelease("v1"), null);
});

test("shouldAnnounce once per version", () => {
  assert.equal(shouldAnnounce(undefined, "0.9.1"), true);
  assert.equal(shouldAnnounce("0.9.0", "0.9.1"), true);
  assert.equal(shouldAnnounce("0.9.1", "0.9.1"), false);
});

test("fetchLatestRelease never throws", async () => {
  const ok = async () => ({ ok: true, json: async () => ({ tag_name: "v2.0.0", html_url: "https://github.com/scuq/chalk/releases/tag/v2.0.0" }) });
  assert.deepEqual(await fetchLatestRelease(ok, "ua"), { version: "2.0.0", url: "https://github.com/scuq/chalk/releases/tag/v2.0.0" });
  const bad = async () => ({ ok: false, json: async () => ({}) });
  assert.equal(await fetchLatestRelease(bad, "ua"), null);
  const boom = async () => { throw new Error("offline"); };
  assert.equal(await fetchLatestRelease(boom, "ua"), null);
  const garbage = async () => ({ ok: true, json: async () => { throw new Error("not json"); } });
  assert.equal(await fetchLatestRelease(garbage, "ua"), null);
});
