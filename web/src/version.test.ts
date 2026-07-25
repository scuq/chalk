import { test } from "node:test";
import assert from "node:assert/strict";

import { changelogURL, isReleaseBuild, versionLabel, versionTitle } from "./version";

test("a release build labels and links at its own tag", () => {
  assert.equal(versionLabel("v0.3.27"), "v0.3.27");
  assert.equal(
    changelogURL("v0.3.27"),
    "https://github.com/scuq/chalk/blob/v0.3.27/CHANGELOG.md",
  );
  assert.equal(isReleaseBuild("v0.3.27"), true);
});

test("a bare semver is treated as the tag it corresponds to", () => {
  // The Makefile stamps VERSION without a leading v; CI stamps the tag with
  // one. Both name the same release.
  assert.equal(versionLabel("1.2.3"), "v1.2.3");
  assert.equal(changelogURL("1.2.3"), "https://github.com/scuq/chalk/blob/v1.2.3/CHANGELOG.md");
});

test("dev and unknown builds fall back to main", () => {
  const main = "https://github.com/scuq/chalk/blob/main/CHANGELOG.md";
  for (const v of ["0.0.0-dev", "", "   ", null, undefined, "garbage"]) {
    assert.equal(versionLabel(v), "dev", `label for ${JSON.stringify(v)}`);
    assert.equal(changelogURL(v), main, `url for ${JSON.stringify(v)}`);
    assert.equal(isReleaseBuild(v), false, `release for ${JSON.stringify(v)}`);
  }
});

test("the tag must be a plain X.Y.Z", () => {
  // No tag exists for a pre-release stamp, so linking at one would 404.
  assert.equal(changelogURL("v1.2.3-rc1"), "https://github.com/scuq/chalk/blob/main/CHANGELOG.md");
  assert.equal(versionLabel("v1.2"), "dev");
});

test("the hover title carries the commit when there is one", () => {
  assert.equal(versionTitle("v0.3.27", "717fc5d"), "chalk v0.3.27 (717fc5d) -- open the changelog");
  assert.equal(versionTitle("v0.3.27", "unknown"), "chalk v0.3.27 -- open the changelog");
  assert.equal(versionTitle("v0.3.27", ""), "chalk v0.3.27 -- open the changelog");
  assert.equal(versionTitle("", ""), "chalk unknown version -- open the changelog");
});
