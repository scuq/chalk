// Tests for src/voice/adaptive.ts (30-8, Addendum D). Runs under
// `node test.mjs`. Pure math only -- the probe (fetch) and the timer /
// setParameters application live in call.ts and are exercised in the
// browser gate.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  DEFAULT_ADAPTIVE,
  parseAdaptiveWire,
  GAME_LADDER,
  SCREEN_LADDER,
  pickTier,
  divideBudget,
  HysteresisLadder,
  CAMERA_THUMB_BPS,
  DOWN_HOLD_MS,
  UP_HOLD_MS,
} from "./adaptive";

// ---- config parsing ---------------------------------------------------------

test("parseAdaptiveWire: absent block keeps defaults", () => {
  const cfg = parseAdaptiveWire(undefined);
  assert.deepEqual(cfg, DEFAULT_ADAPTIVE);
});

test("parseAdaptiveWire: overlays valid fields, rejects junk", () => {
  const cfg = parseAdaptiveWire({
    probe_enabled: false,
    probe_bytes: 1_000_000,
    recheck_secs: [30, 120],
    uplink_headroom: 0.7,
    audio_kbps: 48,
    min_video_kbps: 200,
  });
  assert.equal(cfg.probeEnabled, false);
  assert.equal(cfg.probeBytes, 1_000_000);
  assert.deepEqual(cfg.recheckSecs, [30, 120]);
  assert.equal(cfg.uplinkHeadroom, 0.7);
  assert.equal(cfg.audioKbps, 48);
  assert.equal(cfg.minVideoKbps, 200);

  // Junk values keep defaults.
  const bad = parseAdaptiveWire({
    uplink_headroom: 3,
    recheck_secs: [],
    probe_bytes: -5,
  } as never);
  assert.equal(bad.uplinkHeadroom, DEFAULT_ADAPTIVE.uplinkHeadroom);
  assert.deepEqual(bad.recheckSecs, DEFAULT_ADAPTIVE.recheckSecs);
  assert.equal(bad.probeBytes, DEFAULT_ADAPTIVE.probeBytes);
});

// ---- tier pick --------------------------------------------------------------

test("pickTier: thresholds resolve per D3", () => {
  assert.equal(GAME_LADDER[pickTier(GAME_LADDER, 7_000_000)].name, "1080p60");
  assert.equal(GAME_LADDER[pickTier(GAME_LADDER, 2_000_000)].name, "720p60");
  assert.equal(GAME_LADDER[pickTier(GAME_LADDER, 500_000)].name, "360p30");
  assert.equal(GAME_LADDER[pickTier(GAME_LADDER, 100_000)].pause, true);
  assert.equal(SCREEN_LADDER[pickTier(SCREEN_LADDER, 2_000_000)].name, "1080p15");
  // Screen never pauses -- bottom rung stays sendable.
  assert.equal(SCREEN_LADDER[pickTier(SCREEN_LADDER, 0)].pause, undefined);
});

// ---- divider: the D4 worked example ----------------------------------------

test("divideBudget: 10 Mbps, 4 peers, one share (D4)", () => {
  // uplink 10M * 0.85 = 8.5M usable; audio 4x64k = 256k -> ~8.244M video.
  const plan = divideBudget(
    10_000_000,
    { peers: 4, screenActive: true, screenAudio: false, cameraActive: false },
    DEFAULT_ADAPTIVE,
  );
  assert.ok(Math.abs(plan.videoBudgetBps - 8_244_000) < 1_000);
  // perScreen ~2.06M -> GAME 720p60 per the worked example.
  assert.ok(plan.perScreenBps > 1_500_000 && plan.perScreenBps < 3_000_000);
  assert.equal(GAME_LADDER[pickTier(GAME_LADDER, plan.perScreenBps)].name, "720p60");
  // ...and SCREEN mode holds crisp 1080p@15.
  assert.equal(SCREEN_LADDER[pickTier(SCREEN_LADDER, plan.perScreenBps)].name, "1080p15");
});

test("divideBudget: camera copies take the thumbnail cap while sharing", () => {
  const plan = divideBudget(
    10_000_000,
    { peers: 4, screenActive: true, screenAudio: true, cameraActive: true },
    DEFAULT_ADAPTIVE,
  );
  assert.equal(plan.perCameraBps, CAMERA_THUMB_BPS);
  // Screen keeps the rest: per-copy budget minus one thumbnail.
  const perSlot = Math.floor(plan.videoBudgetBps / 4);
  assert.equal(plan.perScreenBps, perSlot - CAMERA_THUMB_BPS);
});

test("divideBudget: camera-only splits evenly with a floor", () => {
  const even = divideBudget(
    5_000_000,
    { peers: 4, screenActive: false, screenAudio: false, cameraActive: true },
    DEFAULT_ADAPTIVE,
  );
  assert.equal(even.perCameraBps, Math.floor(even.videoBudgetBps / 4));
  // Starved link still floors at min_video_kbps.
  const thin = divideBudget(
    500_000,
    { peers: 4, screenActive: false, screenAudio: false, cameraActive: true },
    DEFAULT_ADAPTIVE,
  );
  assert.equal(thin.perCameraBps, DEFAULT_ADAPTIVE.minVideoKbps * 1000);
});

// ---- hysteresis -------------------------------------------------------------

test("hysteresis: seeds directly, steps down only after sustained deficit", () => {
  const h = new HysteresisLadder(GAME_LADDER);
  let t = 0;
  assert.equal(h.note(2_000_000, t, false).name, "720p60"); // seed
  // A momentary dip does NOT step down...
  assert.equal(h.note(1_000_000, (t += 1_000), false).name, "720p60");
  // ...but a sustained one does, one rung.
  assert.equal(h.note(1_000_000, (t += DOWN_HOLD_MS), false).name, "540p60");
  // Recovery clears the deficit clock; no further drop.
  assert.equal(h.note(1_000_000, (t += 1_000), false).name, "540p60");
});

test("hysteresis: steps up one rung, only at replan after the hold", () => {
  const h = new HysteresisLadder(GAME_LADDER);
  let t = 0;
  h.note(1_000_000, t, false); // seed 540p60
  assert.equal(h.tier?.name, "540p60");
  // Budget for 720p60 appears -- no step outside a replan point.
  h.note(2_000_000, (t += 1_000), false);
  assert.equal(h.tier?.name, "540p60");
  // Replan before the hold elapses: still no step.
  h.note(2_000_000, (t += 1_000), true);
  assert.equal(h.tier?.name, "540p60");
  // Replan after the hold: one rung up, never a jump (even with 8M budget).
  h.note(8_000_000, (t += UP_HOLD_MS), true);
  assert.equal(h.tier?.name, "720p60");
});

test("hysteresis: switchLadder re-seeds on the next observation", () => {
  const h = new HysteresisLadder(GAME_LADDER);
  h.note(2_000_000, 0, false);
  h.switchLadder(SCREEN_LADDER);
  assert.equal(h.tier, null);
  assert.equal(h.note(2_000_000, 1_000, false).name, "1080p15");
});
