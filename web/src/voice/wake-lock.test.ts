import { test } from "node:test";
import assert from "node:assert/strict";
import { installWakeLock, wantWakeLock } from "./wake-lock";

function fakes(phase = "idle") {
  let snap = { phase };
  const subs = new Set<() => void>();
  const session = { subscribe: (fn: () => void) => (subs.add(fn), () => subs.delete(fn)), snap: () => snap };
  const set = (p: string) => { snap = { phase: p }; subs.forEach((f) => f()); };
  const docSubs = new Set<() => void>();
  const doc = {
    visibilityState: "visible",
    addEventListener: (_: "visibilitychange", fn: () => void) => docSubs.add(fn),
    removeEventListener: (_: "visibilitychange", fn: () => void) => docSubs.delete(fn),
  };
  const setVisible = (v: boolean) => { doc.visibilityState = v ? "visible" : "hidden"; docSubs.forEach((f) => f()); };
  const log: string[] = [];
  const nav = {
    wakeLock: {
      request: async () => {
        log.push("request");
        const releasers: (() => void)[] = [];
        return {
          release: async () => { log.push("release"); releasers.forEach((f) => f()); },
          addEventListener: (_: "release", fn: () => void) => releasers.push(fn),
        };
      },
    },
  };
  return { session, set, doc, setVisible, nav, log };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("the screen stays on only in a call and while the page shows", () => {
  assert.equal(wantWakeLock(true, true), true);
  assert.equal(wantWakeLock(true, false), false);
  assert.equal(wantWakeLock(false, true), false);
});

test("a call takes the lock, the end of the call gives it back", async () => {
  const f = fakes();
  const off = installWakeLock(f.session, f.nav, f.doc);
  assert.deepEqual(f.log, []);
  f.set("in-call");
  await tick();
  assert.deepEqual(f.log, ["request"]);
  f.set("idle");
  await tick();
  assert.deepEqual(f.log, ["request", "release"]);
  off();
});

test("the lock is asked for again when the page shows again", async () => {
  const f = fakes("in-call");
  const off = installWakeLock(f.session, f.nav, f.doc);
  await tick();
  f.setVisible(false);
  await tick();
  f.setVisible(true);
  await tick();
  assert.deepEqual(f.log, ["request", "release", "request"]);
  off();
  await tick();
  assert.equal(f.log.at(-1), "release");
});

test("without the API nothing happens", () => {
  const f = fakes("in-call");
  const off = installWakeLock(f.session, {}, f.doc);
  off();
  assert.deepEqual(f.log, []);
});
