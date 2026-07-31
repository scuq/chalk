// Phase 61-1: the message-search decision.
//
// The properties that matter:
//   * sentinel bodies match on their real content, never on wire chrome --
//     a link preview's embedded JSON must not make "site_name" a hit
//   * tombstones and decrypt placeholders are chrome, not content
//   * terms AND together over body + sender handle + channel name
//   * newest first, capped, with an honest total
//   * snippets centre the first hit and mark every hit run

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isUndecryptableBody,
  searchableText,
  searchMessages,
  snippetSegments,
  SEARCH_RESULT_CAP,
  type SearchableMessage,
  type SearchLabels,
} from "./search.ts";
import { threadQueryTerms } from "./threadinbox.ts";
import {
  PLACEHOLDER_NO_KEY,
  PLACEHOLDER_FAILED,
  PLACEHOLDER_PLAINTEXT_BLOCKED,
} from "../crypto/channel-crypto.ts";
import { encodeGiphyBody } from "../giphy/giphy.ts";
import { encodeLinkPreviewBody } from "../linkpreview/linkpreview.ts";

function msg(over: Partial<SearchableMessage> = {}): SearchableMessage {
  return {
    id: "m1",
    channelID: "c1",
    seq: 1,
    senderUserID: "u1",
    ts: new Date(1000),
    body: "hello world",
    ...over,
  };
}

const noLabels: SearchLabels = { channelNames: {}, handles: {} };

// ---- searchableText ----------------------------------------------------

test("plain text passes through", () => {
  assert.equal(searchableText("hello world"), "hello world");
});

test("tombstones and placeholders are not searchable", () => {
  for (const body of [
    "[message deleted]",
    PLACEHOLDER_NO_KEY,
    PLACEHOLDER_FAILED,
    PLACEHOLDER_PLAINTEXT_BLOCKED,
    "[encrypted message -- key not available yet]",
  ]) {
    assert.equal(searchableText(body), null, body);
  }
});

test("undecryptable means missing key or failed open, not policy-blocked", () => {
  assert.equal(isUndecryptableBody(PLACEHOLDER_NO_KEY), true);
  assert.equal(isUndecryptableBody(PLACEHOLDER_FAILED), true);
  assert.equal(isUndecryptableBody("[encrypted message -- key not available yet]"), true);
  assert.equal(isUndecryptableBody(PLACEHOLDER_PLAINTEXT_BLOCKED), false);
  assert.equal(isUndecryptableBody("hello"), false);
});

test("giphy bodies search as their URL", () => {
  const body = encodeGiphyBody("https://media.giphy.com/media/abc/cat.gif");
  assert.equal(searchableText(body), "https://media.giphy.com/media/abc/cat.gif");
});

test("link-preview bodies search as text plus card fields, not raw JSON", () => {
  const body = encodeLinkPreviewBody(
    {
      url: "https://example.com/post",
      title: "Release notes",
      description: "everything new",
      site_name: "Example",
    },
    "have a look",
  );
  const text = searchableText(body);
  assert.ok(text !== null);
  for (const want of ["have a look", "Release notes", "everything new", "Example"]) {
    assert.ok(text.includes(want), want);
  }
  // The JSON chrome must not be matchable.
  assert.ok(!text.includes("site_name"));
  assert.ok(!text.includes("{"));
});

// ---- searchMessages ----------------------------------------------------

test("empty terms return nothing, not everything", () => {
  const r = searchMessages({ c1: [msg()] }, { kind: "all" }, [], noLabels);
  assert.equal(r.total, 0);
  assert.deepEqual(r.results, []);
});

test("terms AND together, case-insensitive", () => {
  const store = {
    c1: [
      msg({ id: "a", body: "Deploy the core service" }),
      msg({ id: "b", seq: 2, body: "deploy something else" }),
    ],
  };
  const r = searchMessages(store, { kind: "all" }, threadQueryTerms("core DEPLOY"), noLabels);
  assert.deepEqual(r.results.map((m) => m.id), ["a"]);
});

test("sender handle and channel name are part of the haystack", () => {
  const store = { c1: [msg({ body: "the numbers look fine" })] };
  const labels: SearchLabels = {
    channelNames: { c1: "ops-alerts" },
    handles: { u1: "ana" },
  };
  const bySender = searchMessages(store, { kind: "all" }, ["ana", "numbers"], labels);
  assert.equal(bySender.total, 1);
  const byChannel = searchMessages(store, { kind: "all" }, ["ops-alerts"], labels);
  assert.equal(byChannel.total, 1);
});

test("channel scope only searches that channel", () => {
  const store = {
    c1: [msg({ id: "a", body: "needle here" })],
    c2: [msg({ id: "b", channelID: "c2", body: "needle there" })],
  };
  const r = searchMessages(store, { kind: "channel", channelID: "c2" }, ["needle"], noLabels);
  assert.deepEqual(r.results.map((m) => m.id), ["b"]);
});

test("deleted rows and placeholder bodies never match", () => {
  const store = {
    c1: [
      msg({ id: "a", body: "[message deleted]", deleted: true }),
      msg({ id: "b", seq: 2, body: PLACEHOLDER_NO_KEY }),
      msg({ id: "c", seq: 3, body: "message intact" }),
    ],
  };
  const r = searchMessages(store, { kind: "all" }, ["message"], noLabels);
  assert.deepEqual(r.results.map((m) => m.id), ["c"]);
});

test("results come newest-first across channels, capped with an honest total", () => {
  const store: Record<string, SearchableMessage[]> = { c1: [], c2: [] };
  for (let i = 0; i < SEARCH_RESULT_CAP; i++) {
    store.c1.push(msg({ id: `a${i}`, seq: i, ts: new Date(2000 + i), body: "needle" }));
  }
  store.c2.push(
    msg({ id: "newest", channelID: "c2", seq: 1, ts: new Date(9000), body: "needle" }),
  );
  const r = searchMessages(store, { kind: "all" }, ["needle"], noLabels);
  assert.equal(r.total, SEARCH_RESULT_CAP + 1);
  assert.equal(r.results.length, SEARCH_RESULT_CAP);
  assert.equal(r.results[0].id, "newest");
});

test("same-timestamp ties order by seq descending", () => {
  const store = {
    c1: [
      msg({ id: "lo", seq: 1, ts: new Date(5000), body: "needle" }),
      msg({ id: "hi", seq: 2, ts: new Date(5000), body: "needle" }),
    ],
  };
  const r = searchMessages(store, { kind: "all" }, ["needle"], noLabels);
  assert.deepEqual(r.results.map((m) => m.id), ["hi", "lo"]);
});

// ---- snippetSegments ---------------------------------------------------

function joined(segs: { text: string; hit: boolean }[]): string {
  return segs.map((s) => s.text).join("");
}

test("short text with one hit splits into miss/hit/miss", () => {
  const segs = snippetSegments("say hello there", ["hello"]);
  assert.deepEqual(segs, [
    { text: "say ", hit: false },
    { text: "hello", hit: true },
    { text: " there", hit: false },
  ]);
});

test("hits deep in a long body are centred with ellipses on both edges", () => {
  const text = "x".repeat(300) + " needle " + "y".repeat(300);
  const segs = snippetSegments(text, ["needle"], 80);
  const hit = segs.find((s) => s.hit);
  assert.ok(hit && hit.text === "needle");
  assert.ok(segs[0].text.startsWith("…"));
  assert.ok(segs[segs.length - 1].text.endsWith("…"));
  // Window stays near the requested size (plus the two ellipses).
  assert.ok(joined(segs).length <= 82, `${joined(segs).length}`);
});

test("overlapping term hits merge into one run", () => {
  const segs = snippetSegments("redeploy now", ["deploy", "dep", "red"]);
  assert.deepEqual(segs.filter((s) => s.hit), [{ text: "redeploy", hit: true }]);
});

test("every occurrence in the window is marked", () => {
  const segs = snippetSegments("cat and cat", ["cat"]);
  assert.equal(segs.filter((s) => s.hit).length, 2);
});

test("metadata-only matches fall back to the head of the text", () => {
  const text = "a".repeat(400);
  const segs = snippetSegments(text, ["nomatch"], 80);
  assert.deepEqual(segs.map((s) => s.hit), [false]);
  assert.equal(segs[0].text.length, 81); // 80 chars + trailing ellipsis
  assert.ok(segs[0].text.endsWith("…"));
});

test("matching is case-insensitive in the snippet too", () => {
  const segs = snippetSegments("Deploy went fine", ["deploy"]);
  assert.deepEqual(segs[0], { text: "Deploy", hit: true });
});
