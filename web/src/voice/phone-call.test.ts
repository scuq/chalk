import { test } from "node:test";
import assert from "node:assert/strict";
import { barLine, callLayout, canShareScreen, cardColumns, stageGrid } from "./phone-call";
import type { RailTile } from "./rail-tiles";

const tile = (key: string, o: Partial<RailTile> = {}): RailTile => ({
  key,
  userID: key.split(":")[0],
  deviceID: "d",
  isSelf: false,
  stream: null,
  hasLiveVideo: false,
  isScreen: false,
  hasAudio: false,
  connState: null,
  ...o,
});
const keys = (ts: RailTile[]) => ts.map((t) => t.key);

test("with no video from other people the call is cards, and your own share is left out", () => {
  const ts = [tile("me:d", { isSelf: true }), tile("bob:d"), tile("me:d:screen", { isSelf: true, isScreen: true, hasLiveVideo: true })];
  const l = callLayout(ts, null);
  assert.equal(l.mode, "audio");
  assert.deepEqual(keys(l.stage), ["me:d", "bob:d"]);
  assert.equal(l.corner, null);
});

test("your own camera alone does not make a video call: it shows on your card", () => {
  const l = callLayout([tile("me:d", { isSelf: true, hasLiveVideo: true }), tile("bob:d")], null);
  assert.equal(l.mode, "audio");
});

test("video takes the stage, people with audio only go to the strip, your camera to the corner", () => {
  const me = tile("me:d", { isSelf: true, hasLiveVideo: true });
  const bob = tile("bob:d", { hasLiveVideo: true });
  const cat = tile("cat:d");
  const l = callLayout([me, bob, cat], null);
  assert.equal(l.mode, "video");
  assert.deepEqual(keys(l.stage), ["bob:d"]);
  assert.deepEqual(keys(l.strip), ["cat:d"]);
  assert.equal(l.corner?.key, "me:d");
});

test("without a camera you are in the strip", () => {
  const l = callLayout([tile("me:d", { isSelf: true }), tile("bob:d", { hasLiveVideo: true })], null);
  assert.deepEqual(keys(l.strip), ["me:d"]);
  assert.equal(l.corner, null);
});

test("at most four videos fill the stage, the rest go to the strip", () => {
  const vids = ["a", "b", "c", "d", "e"].map((n) => tile(`${n}:d`, { hasLiveVideo: true }));
  const l = callLayout([tile("me:d", { isSelf: true }), ...vids], null);
  assert.deepEqual(keys(l.stage), ["a:d", "b:d", "c:d", "d:d"]);
  assert.deepEqual(keys(l.strip), ["me:d", "e:d"]);
});

test("show large puts one video alone on the stage, and an unknown key is ignored", () => {
  const vids = ["a", "b"].map((n) => tile(`${n}:d`, { hasLiveVideo: true }));
  assert.deepEqual(keys(callLayout(vids, "b:d").stage), ["b:d"]);
  assert.deepEqual(keys(callLayout(vids, "b:d").strip), ["a:d"]);
  assert.deepEqual(keys(callLayout(vids, "zz:d").stage), ["a:d", "b:d"]);
});

test("a remote screen share with video is a video", () => {
  const l = callLayout([tile("me:d", { isSelf: true }), tile("bob:d"), tile("bob:d:screen", { isScreen: true, hasLiveVideo: true })], null);
  assert.equal(l.mode, "video");
  assert.deepEqual(keys(l.stage), ["bob:d:screen"]);
});

test("grids: one fills, two stack, three and four are 2 by 2; cards are one column up to two people", () => {
  assert.deepEqual(stageGrid(1), { cols: 1, rows: 1 });
  assert.deepEqual(stageGrid(2), { cols: 1, rows: 2 });
  assert.deepEqual(stageGrid(3), { cols: 2, rows: 2 });
  assert.deepEqual(stageGrid(4), { cols: 2, rows: 2 });
  assert.equal(cardColumns(1), 1);
  assert.equal(cardColumns(2), 1);
  assert.equal(cardColumns(3), 2);
  assert.equal(cardColumns(8), 2);
});

test("the bar line: sound first, then joining, speakers, muted, and in the call", () => {
  const base = { phase: "in-call" as const, muted: false, audioBlocked: false, speaking: [] as string[] };
  assert.equal(barLine({ ...base, audioBlocked: true, speaking: ["bob"] }), "tap anywhere to turn on the sound");
  assert.equal(barLine({ ...base, phase: "joining" }), "joining…");
  assert.equal(barLine({ ...base, speaking: ["bob"] }), "bob is speaking");
  assert.equal(barLine({ ...base, speaking: ["bob", "cat"] }), "bob and cat are speaking");
  assert.equal(barLine({ ...base, speaking: ["bob", "cat", "dan"] }), "3 people are speaking");
  assert.equal(barLine({ ...base, muted: true }), "you are muted");
  assert.equal(barLine(base), "in the call");
});

test("screen share needs getDisplayMedia", () => {
  assert.equal(canShareScreen(undefined), false);
  assert.equal(canShareScreen({}), false);
  assert.equal(canShareScreen({ getDisplayMedia: () => null }), true);
});

test("iPhone and iPad are Apple mobile, a Mac without touch and Android are not", async () => {
  const { isAppleMobile } = await import("./phone-call");
  assert.equal(isAppleMobile("Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X)", "iPhone", 5), true);
  assert.equal(isAppleMobile("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 5), true);
  assert.equal(isAppleMobile("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 0), false);
  assert.equal(isAppleMobile("Mozilla/5.0 (Linux; Android 15; Pixel 9)", "Linux armv8l", 5), false);
});
