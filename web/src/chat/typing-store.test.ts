import { test } from "node:test";
import assert from "node:assert/strict";

import { TYPING_TTL_MS } from "./typing";
import { typingStore } from "./typing-store";

// One module singleton for the whole suite, so every test starts from a known
// empty store. clearAll also stops the sweep timer, which is what keeps the
// test runner from hanging on a pending interval.
function reset() {
  typingStore.clearAll();
}

const T0 = 1_000_000;

test("a noted typist is live until the TTL, then gone", () => {
  reset();
  typingStore.note("chan", "alice", T0);
  assert.deepEqual(typingStore.typistsIn("chan", T0), ["alice"]);
  assert.deepEqual(typingStore.typistsIn("chan", T0 + TYPING_TTL_MS - 1), ["alice"]);
  assert.deepEqual(typingStore.typistsIn("chan", T0 + TYPING_TTL_MS), []);
  reset();
});

test("channels are independent", () => {
  reset();
  typingStore.note("a", "alice", T0);
  typingStore.note("b", "bob", T0);
  assert.deepEqual(typingStore.typistsIn("a", T0), ["alice"]);
  assert.deepEqual(typingStore.typistsIn("b", T0), ["bob"]);
  assert.deepEqual(typingStore.typistsIn("nope", T0), []);
  reset();
});

// The reason both levels are Maps: a typist re-pinging every few seconds must
// not jump to the end of the sentence the reader is looking at.
test("re-noting extends the deadline without reordering", () => {
  reset();
  typingStore.note("chan", "alice", T0);
  typingStore.note("chan", "bob", T0);
  typingStore.note("chan", "alice", T0 + 3000);

  assert.deepEqual(typingStore.typistsIn("chan", T0 + 3000), ["alice", "bob"]);
  // Bob's original deadline passes; alice's refreshed one has not.
  assert.deepEqual(typingStore.typistsIn("chan", T0 + TYPING_TTL_MS + 1), ["alice"]);
  reset();
});

test("sweep evicts expired entries and leaves the rest", () => {
  reset();
  typingStore.note("chan", "alice", T0);
  typingStore.note("chan", "bob", T0 + 4000);
  typingStore.sweep(T0 + TYPING_TTL_MS);

  assert.deepEqual(typingStore.typistsIn("chan", T0 + TYPING_TTL_MS), ["bob"]);
  reset();
});

test("clearUser drops one typist, clearChannel drops the channel", () => {
  reset();
  typingStore.note("chan", "alice", T0);
  typingStore.note("chan", "bob", T0);

  typingStore.clearUser("chan", "alice");
  assert.deepEqual(typingStore.typistsIn("chan", T0), ["bob"]);

  typingStore.clearChannel("chan");
  assert.deepEqual(typingStore.typistsIn("chan", T0), []);
  reset();
});

test("clearUser for someone who isn't typing is a no-op", () => {
  reset();
  typingStore.note("chan", "alice", T0);
  typingStore.clearUser("chan", "nobody");
  typingStore.clearUser("other", "alice");
  assert.deepEqual(typingStore.typistsIn("chan", T0), ["alice"]);
  reset();
});

test("clearAll empties every channel", () => {
  reset();
  typingStore.note("a", "alice", T0);
  typingStore.note("b", "bob", T0);
  typingStore.clearAll();
  assert.deepEqual(typingStore.typistsIn("a", T0), []);
  assert.deepEqual(typingStore.typistsIn("b", T0), []);
});

// The timer exists to expire names. With no names it is pure waste, so it must
// not run at rest -- not after a sweep empties the store, and not after a clear.
test("the sweep timer runs only while someone is typing", () => {
  reset();
  assert.equal(typingStore.isTicking(), false);

  typingStore.note("chan", "alice", T0);
  assert.equal(typingStore.isTicking(), true);

  typingStore.sweep(T0 + TYPING_TTL_MS);
  assert.equal(typingStore.isTicking(), false);

  typingStore.note("chan", "alice", T0);
  assert.equal(typingStore.isTicking(), true);
  typingStore.clearAll();
  assert.equal(typingStore.isTicking(), false);
});

test("subscribers are notified on change and released on unsubscribe", () => {
  reset();
  let hits = 0;
  const off = typingStore.subscribe(() => {
    hits++;
  });

  typingStore.note("chan", "alice", T0);
  assert.equal(hits, 1);
  typingStore.clearUser("chan", "alice");
  assert.equal(hits, 2);
  // Nothing to remove: no notification, no spurious re-render.
  typingStore.clearUser("chan", "alice");
  assert.equal(hits, 2);

  off();
  typingStore.note("chan", "bob", T0);
  assert.equal(hits, 2);
  reset();
});
