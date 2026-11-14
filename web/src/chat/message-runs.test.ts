import { test } from "node:test";
import assert from "node:assert/strict";

import { RUN_GAP_MS, continuesRun, type RunMessage } from "./message-runs";

const T0 = new Date("2026-11-14T10:00:00Z").getTime();
const msg = (over: Partial<RunMessage> = {}): RunMessage => ({
  sender: "dev-a",
  senderUserID: "user-a",
  ts: new Date(T0),
  ...over,
});

test("the same author a minute later continues the run", () => {
  assert.equal(continuesRun(msg(), msg({ ts: new Date(T0 + 60_000) })), true);
});

test("the gap limit is inclusive, and one millisecond past it starts a new run", () => {
  assert.equal(continuesRun(msg(), msg({ ts: new Date(T0 + RUN_GAP_MS) })), true);
  assert.equal(continuesRun(msg(), msg({ ts: new Date(T0 + RUN_GAP_MS + 1) })), false);
});

test("another author starts a new run", () => {
  assert.equal(continuesRun(msg(), msg({ senderUserID: "user-b", sender: "dev-b" })), false);
});

test("two devices of one account are one author", () => {
  assert.equal(continuesRun(msg(), msg({ sender: "dev-a2" })), true);
});

test("without a user id the device decides", () => {
  const a = msg({ senderUserID: "" });
  assert.equal(continuesRun(a, msg({ senderUserID: "" })), true);
  assert.equal(continuesRun(a, msg({ senderUserID: "", sender: "dev-b" })), false);
});

test("a purged sender with no user and no device never joins a run", () => {
  const purged = msg({ senderUserID: "", sender: "" });
  assert.equal(continuesRun(purged, purged), false);
});

test("a deleted message on either side starts a new run", () => {
  assert.equal(continuesRun(msg({ deleted: true }), msg()), false);
  assert.equal(continuesRun(msg(), msg({ deleted: true })), false);
});

test("a row older than the one above it starts a new run", () => {
  assert.equal(continuesRun(msg(), msg({ ts: new Date(T0 - 1000) })), false);
});

test("an invalid timestamp starts a new run", () => {
  assert.equal(continuesRun(msg(), msg({ ts: new Date(NaN) })), false);
});
