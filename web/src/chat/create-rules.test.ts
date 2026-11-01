// Tests for src/chat/create-rules.ts (130-2). A temporary room can be created
// with no member. Every other channel keeps the member requirement.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { createSubmitState, isTemporaryRoom, QUICK_ROOM_TTL_SECS } from "./create-rules";

const base = { loading: false, friendCount: 3, selectedCount: 1, voice: false, ttlSecs: 0 };

test("isTemporaryRoom needs both voice and a lifetime", () => {
  assert.equal(isTemporaryRoom(true, 3600), true);
  assert.equal(isTemporaryRoom(true, 0), false);
  assert.equal(isTemporaryRoom(false, 3600), false);
});

test("the quick-create lifetime is eight hours", () => {
  assert.equal(QUICK_ROOM_TTL_SECS, 28800);
});

test("a permanent channel keeps the member requirement", () => {
  assert.deepEqual(createSubmitState({ ...base, selectedCount: 0 }), { disabled: false, error: "pick at least one member" });
  assert.deepEqual(createSubmitState(base), { disabled: false, error: null });
  assert.deepEqual(createSubmitState({ ...base, friendCount: 0, selectedCount: 0 }), { disabled: true, error: null });
  assert.deepEqual(createSubmitState({ ...base, loading: true }), { disabled: true, error: null });
});

test("a permanent voice room keeps the member requirement too", () => {
  assert.deepEqual(createSubmitState({ ...base, voice: true, selectedCount: 0 }), { disabled: false, error: "pick at least one member" });
  assert.deepEqual(createSubmitState({ ...base, voice: true, friendCount: 0, selectedCount: 0 }), { disabled: true, error: null });
});

test("a temporary room opens alone, with no friends, before the friend list loads", () => {
  const room = { ...base, voice: true, ttlSecs: QUICK_ROOM_TTL_SECS };
  assert.deepEqual(createSubmitState({ ...room, selectedCount: 0 }), { disabled: false, error: null });
  assert.deepEqual(createSubmitState({ ...room, friendCount: 0, selectedCount: 0 }), { disabled: false, error: null });
  assert.deepEqual(createSubmitState({ ...room, loading: true, selectedCount: 0 }), { disabled: false, error: null });
  assert.deepEqual(createSubmitState({ ...room, selectedCount: 2 }), { disabled: false, error: null });
});
