// 46-2: "the server was updated under this tab" detection.
//
// The properties that matter:
//   * the first welcome of a page load is the baseline, never an update
//   * a restart onto the SAME build is not an update
//   * a dismissal is per-build, so a reconnect doesn't undo it but a deploy does
//   * "the server reports no build" is not evidence of anything
//   * a disconnect must not lose the baseline or the pill

import { test } from "node:test";
import assert from "node:assert/strict";
import { reducer } from "./reducer.ts";
import { initialState, type Action, type AppState } from "./types.ts";

function welcome(version?: string, commit?: string): Action {
  return {
    kind: "welcome",
    userID: "user-1",
    deviceID: "dev-1",
    handle: "me",
    channels: [],
    voiceEnabled: false,
    serverVersion: version,
    serverCommit: commit,
  };
}

function connect(version?: string, commit?: string): AppState {
  return reducer(initialState, welcome(version, commit));
}

test("the first welcome records the baseline and does not flag an update", () => {
  const s = connect("v0.3.46", "abc1234");
  assert.equal(s.serverBuildAtLoad, "v0.3.46@abc1234");
  assert.equal(s.updateAvailable, false);
});

test("a reconnect on the same build does not flag", () => {
  let s = connect("v0.3.46", "abc1234");
  s = reducer(s, welcome("v0.3.46", "abc1234"));
  assert.equal(s.updateAvailable, false);
});

test("a reconnect on a different commit flags, so dev rebuilds are caught", () => {
  let s = connect("0.0.0-dev", "aaaaaaa");
  s = reducer(s, welcome("0.0.0-dev", "bbbbbbb"));
  assert.equal(s.updateAvailable, true);
});

test("a reconnect on a different version flags", () => {
  let s = connect("v0.3.46", "abc1234");
  s = reducer(s, welcome("v0.3.47", "def5678"));
  assert.equal(s.updateAvailable, true);
  // The baseline stays put: it is the build this tab's bundle came from.
  assert.equal(s.serverBuildAtLoad, "v0.3.46@abc1234");
});

test("a server that never reports a build never flags", () => {
  let s = connect(undefined, undefined);
  assert.equal(s.serverBuildAtLoad, "");
  s = reducer(s, welcome(undefined, undefined));
  assert.equal(s.updateAvailable, false);
});

test("a baseline with no build, then a build, flags", () => {
  let s = connect(undefined, undefined);
  s = reducer(s, welcome("v0.3.46", "abc1234"));
  assert.equal(s.updateAvailable, true);
});

test("dismissing hides the pill and records the build", () => {
  let s = connect("v0.3.46", "abc1234");
  s = reducer(s, welcome("v0.3.47", "def5678"));
  s = reducer(s, { kind: "update_dismissed" });
  assert.equal(s.updateAvailable, false);
  assert.equal(s.dismissedBuild, "v0.3.47@def5678");
});

test("a reconnect on the dismissed build does not bring the pill back", () => {
  let s = connect("v0.3.46", "abc1234");
  s = reducer(s, welcome("v0.3.47", "def5678"));
  s = reducer(s, { kind: "update_dismissed" });
  s = reducer(s, welcome("v0.3.47", "def5678"));
  assert.equal(s.updateAvailable, false);
});

test("a third build after a dismissal brings the pill back", () => {
  let s = connect("v0.3.46", "abc1234");
  s = reducer(s, welcome("v0.3.47", "def5678"));
  s = reducer(s, { kind: "update_dismissed" });
  s = reducer(s, welcome("v0.3.48", "999aaaa"));
  assert.equal(s.updateAvailable, true);
});

test("a rollback to the baseline build clears the pill on its own", () => {
  let s = connect("v0.3.46", "abc1234");
  s = reducer(s, welcome("v0.3.47", "def5678"));
  assert.equal(s.updateAvailable, true);
  s = reducer(s, welcome("v0.3.46", "abc1234"));
  assert.equal(s.updateAvailable, false);
});

test("server_restarting sets the hint and the next welcome clears it", () => {
  let s = connect("v0.3.46", "abc1234");
  s = reducer(s, { kind: "server_restarting" });
  assert.equal(s.serverRestarting, true);
  s = reducer(s, welcome("v0.3.46", "abc1234"));
  assert.equal(s.serverRestarting, false);
});

test("a restart onto the same build shows the hint but never the pill", () => {
  let s = connect("v0.3.46", "abc1234");
  s = reducer(s, { kind: "server_restarting" });
  s = reducer(s, { kind: "ws_state", state: "closed", detail: "1000" });
  s = reducer(s, welcome("v0.3.46", "abc1234"));
  assert.equal(s.updateAvailable, false);
});

// Regression guard: ws_state already nulls `user`, so it is the case most
// likely to grow a field reset it shouldn't have.
test("a disconnect keeps the baseline and the pill", () => {
  let s = connect("v0.3.46", "abc1234");
  s = reducer(s, welcome("v0.3.47", "def5678"));
  s = reducer(s, { kind: "ws_state", state: "closed", detail: "1006" });
  assert.equal(s.updateAvailable, true);
  assert.equal(s.serverBuildAtLoad, "v0.3.46@abc1234");
});
