// 92-2: `lastSeen` is a sibling of `presence`, keyed the same way, and the two
// are only ever written by the three presence actions. That is what keeps them
// from drifting, so each of the three is asserted on both maps here -- a fourth
// presence action that touches only one of them should fail this file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { reducer } from "./reducer.ts";
import { initialState } from "./types.ts";

const A = "user-a";
const B = "user-b";

test("presence_set writes both maps", () => {
  const s = reducer(initialState, {
    kind: "presence_set",
    userID: A,
    state: "away",
    at: 1_700_000_000_000,
  });
  assert.equal(s.presence[A], "away");
  assert.equal(s.lastSeen[A], 1_700_000_000_000);
});

// The state is news; the missing timestamp is not. Erasing what we know would
// turn a card that said "last seen 4m ago" into one that says nothing.
test("presence_set without a timestamp keeps the last known one", () => {
  const seeded = reducer(initialState, {
    kind: "presence_set",
    userID: A,
    state: "online",
    at: 1_700_000_000_000,
  });
  const s = reducer(seeded, { kind: "presence_set", userID: A, state: "away" });
  assert.equal(s.presence[A], "away");
  assert.equal(s.lastSeen[A], 1_700_000_000_000);
});

// The going-offline case, and the reason the guard is `<= 0` rather than a
// presence check: the server deletes a device's presence row when its socket
// closes, so the very next push about that user aggregates zero devices and
// carries UnixMilli(time.Time{}). The timestamp we already hold is the last
// heartbeat from while they were online -- which is the answer the card wants.
test("a going-offline push does not erase the timestamp it cannot supply", () => {
  const seeded = reducer(initialState, {
    kind: "presence_set",
    userID: A,
    state: "online",
    at: 1_700_000_000_000,
  });
  const s = reducer(seeded, {
    kind: "presence_set",
    userID: A,
    state: "offline",
    at: -6795364578871,
  });
  assert.equal(s.presence[A], "offline");
  assert.equal(s.lastSeen[A], 1_700_000_000_000);
});

test("presence_clear drops the user from both maps and leaves others alone", () => {
  let s = reducer(initialState, {
    kind: "presence_set",
    userID: A,
    state: "online",
    at: 111,
  });
  s = reducer(s, { kind: "presence_set", userID: B, state: "away", at: 222 });
  s = reducer(s, { kind: "presence_clear", userID: A });
  assert.equal(A in s.presence, false);
  assert.equal(A in s.lastSeen, false);
  assert.equal(s.presence[B], "away");
  assert.equal(s.lastSeen[B], 222);
});

test("presence_clear for an untracked user is a no-op on identity", () => {
  const s = reducer(initialState, { kind: "presence_clear", userID: A });
  assert.equal(s, initialState);
});

test("presence_reset empties both maps", () => {
  let s = reducer(initialState, {
    kind: "presence_set",
    userID: A,
    state: "online",
    at: 111,
  });
  s = reducer(s, { kind: "presence_reset" });
  assert.deepEqual(s.presence, {});
  assert.deepEqual(s.lastSeen, {});
});
