// What we ask the Idle Detection API for.
//
// The threshold is the whole away policy for anyone on Chromium with the grant:
// below it the OS says "active" and idle.ts suppresses every in-page timeout,
// at it the dot flips. It is one number in one call, which is exactly the kind
// that gets reset to the API's 60s floor by someone reading the RangeError doc
// and concluding the floor is the value. So pin it, and pin that the detector
// publishes its opening state rather than waiting for a transition that may
// never come.

import { test } from "node:test";
import assert from "node:assert/strict";

class FakeDetector extends EventTarget {
  static lastStart: { threshold: number; signal?: AbortSignal } | undefined;
  static prompts = 0;
  userState: "active" | "idle" | null = "active";
  screenState: "locked" | "unlocked" | null = "unlocked";

  static async requestPermission(): Promise<PermissionState> {
    FakeDetector.prompts++;
    return "granted";
  }

  async start(opts: { threshold: number; signal?: AbortSignal }): Promise<void> {
    FakeDetector.lastStart = opts;
  }
}

// Set before importing: the module reads window at call time, but the import
// is hoisted above everything else in the file either way.
(globalThis as unknown as { window: unknown }).window = {
  IdleDetector: FakeDetector,
};

const { startSystemIdle } = await import("./system-idle.ts");

test("the detector is started well above the API's 60s floor", async () => {
  const r = await startSystemIdle(() => {});
  assert.equal(r.ok, true);
  const threshold = FakeDetector.lastStart?.threshold ?? 0;
  assert.ok(threshold >= 60_000, "below the floor start() would throw RangeError");
  assert.ok(
    threshold >= 300_000,
    `a minute of no input is reading, not leaving (got ${threshold}ms)`,
  );
});

test("the opening state is published without waiting for a transition", async () => {
  const seen: Array<{ idle: boolean; locked: boolean }> = [];
  const r = await startSystemIdle((s) => seen.push(s));
  assert.equal(r.ok, true);
  assert.deepEqual(seen, [{ idle: false, locked: false }]);
});
