// 104-3: the shell's idle clock as a presence source. Same fake-globals
// pattern as system-idle.test.ts: the module reads window at call time.

import { test } from "node:test";
import assert from "node:assert/strict";

type Raw = { idleMs: number; locked: boolean };

class FakeBridge {
  subscribers = new Set<(s: Raw) => void>();
  current: Raw | null = { idleMs: 0, locked: false };
  unsubscribed = 0;
  async get(): Promise<Raw | null> {
    return this.current;
  }
  subscribe(cb: (s: Raw) => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
      this.unsubscribed++;
    };
  }
  push(s: Raw): void {
    for (const cb of this.subscribers) cb(s);
  }
}

const fake = new FakeBridge();
const g = globalThis as unknown as { window: { chalkDesktop?: unknown } };
g.window = { chalkDesktop: { shell: "chalk-desktop/test", idle: fake } };

const { desktopIdlePresent, startDesktopIdle, toState } = await import("./desktop-idle.ts");
const { THRESHOLD_MS } = await import("./system-idle.ts");

const tick = () => new Promise((r) => setTimeout(r, 0));

test("present only when the bridge has both functions", () => {
  assert.equal(desktopIdlePresent(), true);
  const saved = g.window.chalkDesktop;
  g.window.chalkDesktop = { shell: "x" };
  assert.equal(desktopIdlePresent(), false);
  g.window.chalkDesktop = { shell: "x", idle: { get: 1, subscribe: () => {} } };
  assert.equal(desktopIdlePresent(), false);
  g.window.chalkDesktop = saved;
});

test("toState applies the shared threshold and tolerates garbage", () => {
  assert.deepEqual(toState({ idleMs: THRESHOLD_MS - 1, locked: false }), { idle: false, locked: false });
  assert.deepEqual(toState({ idleMs: THRESHOLD_MS, locked: false }), { idle: true, locked: false });
  assert.deepEqual(toState({ idleMs: 5, locked: true }), { idle: false, locked: true });
  assert.deepEqual(toState({ idleMs: Number.NaN, locked: false }), { idle: false, locked: false });
  assert.deepEqual(toState({ idleMs: "x" as unknown as number, locked: "yes" as unknown as boolean }), {
    idle: false,
    locked: false,
  });
});

test("the opening state is published without waiting for a tick", async () => {
  fake.current = { idleMs: THRESHOLD_MS + 1, locked: false };
  const seen: Array<{ idle: boolean; locked: boolean }> = [];
  const r = startDesktopIdle((s) => seen.push(s));
  assert.ok(r);
  await tick();
  assert.deepEqual(seen, [{ idle: true, locked: false }]);
  r.stop();
});

test("edges only, lock is immediate, stop unsubscribes", async () => {
  fake.current = { idleMs: 0, locked: false };
  const seen: Array<{ idle: boolean; locked: boolean }> = [];
  const before = fake.unsubscribed;
  const r = startDesktopIdle((s) => seen.push(s));
  assert.ok(r);
  await tick();
  fake.push({ idleMs: 1000, locked: false }); // same state: no event
  fake.push({ idleMs: 2000, locked: true }); // lock flips at once
  fake.push({ idleMs: 3000, locked: true }); // unchanged
  fake.push({ idleMs: 0, locked: false });
  assert.deepEqual(seen, [
    { idle: false, locked: false },
    { idle: false, locked: true },
    { idle: false, locked: false },
  ]);
  r.stop();
  assert.equal(fake.unsubscribed, before + 1);
  fake.push({ idleMs: 0, locked: true });
  assert.equal(seen.length, 3, "nothing after stop");
});

test("returns null without the bridge", () => {
  const saved = g.window.chalkDesktop;
  delete g.window.chalkDesktop;
  assert.equal(startDesktopIdle(() => {}), null);
  g.window.chalkDesktop = saved;
});
