// 115-9: the burst and rest cycle of flair-motion.ts, on a fake clock and a
// fake target: the cycle, rest without a timer while away, and the stop.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FLAIR_MOVE_MS,
  FLAIR_REST_ATTR,
  FLAIR_REST_MS,
  startFlairMotion,
  type FlairMotionEnv,
} from "./flair-motion";

function fakeEnv(startAway = false) {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const attrs = new Set<string>();
  let away = startAway;
  let listener: (() => void) | null = null;

  const env: FlairMotionEnv = {
    target: {
      setAttribute: (name) => void attrs.add(name),
      removeAttribute: (name) => void attrs.delete(name),
    },
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id),
    isAway: () => away,
    onAwayChange(fn) {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  };

  return {
    env,
    resting: () => attrs.has(FLAIR_REST_ATTR),
    pending: () => timers.size,
    listening: () => listener !== null,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | null = null;
        for (const entry of timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
    setAway(v: boolean) {
      away = v;
      listener?.();
    },
  };
}

test("flair moves first, rests after the burst, and moves again after the rest", () => {
  const f = fakeEnv();
  startFlairMotion(f.env);
  assert.equal(f.resting(), false);
  f.advance(FLAIR_MOVE_MS - 1);
  assert.equal(f.resting(), false);
  f.advance(1);
  assert.equal(f.resting(), true);
  f.advance(FLAIR_REST_MS - 1);
  assert.equal(f.resting(), true);
  f.advance(1);
  assert.equal(f.resting(), false);
});

test("flair rests at once and keeps no timer while the window is away", () => {
  const f = fakeEnv();
  startFlairMotion(f.env);
  f.setAway(true);
  assert.equal(f.resting(), true);
  assert.equal(f.pending(), 0);
  f.advance(FLAIR_REST_MS * 3);
  assert.equal(f.resting(), true);
});

test("flair starts away when the window starts away", () => {
  const f = fakeEnv(true);
  startFlairMotion(f.env);
  assert.equal(f.resting(), true);
  assert.equal(f.pending(), 0);
});

test("focus starts a burst at once, mid-rest", () => {
  const f = fakeEnv();
  startFlairMotion(f.env);
  f.advance(FLAIR_MOVE_MS + 1000);
  assert.equal(f.resting(), true);
  f.setAway(true);
  f.setAway(false);
  assert.equal(f.resting(), false);
  assert.equal(f.pending(), 1);
  f.advance(FLAIR_MOVE_MS);
  assert.equal(f.resting(), true);
});

test("stop removes the listener and the timer", () => {
  const f = fakeEnv();
  const stop = startFlairMotion(f.env);
  stop();
  assert.equal(f.listening(), false);
  assert.equal(f.pending(), 0);
});
