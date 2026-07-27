import { test } from "node:test";
import assert from "node:assert/strict";
import { threadTitle, THREAD_TITLE_MAX } from "./threadtitle";

test("short body passes through untouched", () => {
  assert.equal(threadTitle("deploy friday?"), "deploy friday?");
});

test("undefined body (not decrypted) is null", () => {
  assert.equal(threadTitle(undefined), null);
});

test("empty and whitespace-only bodies are null", () => {
  assert.equal(threadTitle(""), null);
  assert.equal(threadTitle("   \n\t "), null);
});

test("newlines and runs of whitespace collapse to single spaces", () => {
  assert.equal(threadTitle("a\nb\t\tc   d"), "a b c d");
});

test("long body clips at a word boundary with an ellipsis", () => {
  const t = threadTitle(
    "so I was thinking we should probably rotate the signing keys before the next release goes out",
  );
  assert.ok(t !== null && t.endsWith("…"));
  assert.ok(t!.length <= THREAD_TITLE_MAX + 1); // +1 for the ellipsis
  // Never ends mid-word: strip the ellipsis and the remainder must be a
  // prefix of the flattened body ending at a space.
  assert.equal(t, "so I was thinking we should probably rotate the…");
});

test("a single giant word clips mid-word rather than vanishing", () => {
  const t = threadTitle("x".repeat(100), 10);
  assert.equal(t, "x".repeat(10) + "…");
});

test("exactly max length is not clipped", () => {
  const body = "y".repeat(THREAD_TITLE_MAX);
  assert.equal(threadTitle(body), body);
});
