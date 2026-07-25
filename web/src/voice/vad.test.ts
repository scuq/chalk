// The transmit gate: the decision table.
//
// Everything here is a failure someone would report as "voice is broken" and
// nobody could reproduce on demand: a mic that stays open after you release the
// key, a gate that cuts the last syllable off every sentence, a fan that holds
// the channel open all afternoon. They are all one-line cases here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { GATE_CLOSED, nextGate, type GateConfig, type GateState } from "./vad.ts";

const CFG: GateConfig = { mode: "vad", vadOpen: 0.2, vadClose: 0.08, holdMs: 300 };
const OPEN: GateState = { open: true, holdUntil: 1000 };

const at = (level: number, now: number, keyHeld = false) => ({ level, keyHeld, now });

test("continuous is always open, whatever the level or the key", () => {
  const cfg = { ...CFG, mode: "continuous" as const };
  for (const level of [0, 0.5, 1]) {
    for (const keyHeld of [true, false]) {
      assert.equal(nextGate(GATE_CLOSED, cfg, at(level, 0, keyHeld)).open, true);
    }
  }
});

test("push to talk opens only while the key is down", () => {
  const cfg = { ...CFG, mode: "ptt" as const };
  assert.equal(nextGate(GATE_CLOSED, cfg, at(0, 0, true)).open, true);
  assert.equal(nextGate(GATE_CLOSED, cfg, at(0.9, 0, false)).open, false, "loud is not a key");
});

test("push to talk keeps the tail after the key comes up", () => {
  const cfg = { ...CFG, mode: "ptt" as const };
  const held = nextGate(GATE_CLOSED, cfg, at(0.5, 1000, true));
  assert.equal(held.holdUntil, 1300);
  assert.equal(nextGate(held, cfg, at(0.5, 1200, false)).open, true, "still inside the hold");
  assert.equal(nextGate(held, cfg, at(0.5, 1400, false)).open, false, "hold expired");
});

test("push to mute is open until the key goes down, and mutes instantly", () => {
  const cfg = { ...CFG, mode: "ptm" as const };
  assert.equal(nextGate(GATE_CLOSED, cfg, at(0.5, 0, false)).open, true);
  const shut = nextGate(OPEN, cfg, at(0.5, 0, true));
  assert.equal(shut.open, false, "no hold timer -- pressing mute means now");
  assert.equal(shut.holdUntil, 0);
});

test("vad opens above the speech threshold and arms the hold", () => {
  const g = nextGate(GATE_CLOSED, CFG, at(0.25, 500));
  assert.equal(g.open, true);
  assert.equal(g.holdUntil, 800);
});

test("vad stays shut below the silence threshold", () => {
  assert.deepEqual(nextGate(GATE_CLOSED, CFG, at(0.02, 0)), GATE_CLOSED);
});

test("vad holds the tail through a drop to silence", () => {
  const open = nextGate(GATE_CLOSED, CFG, at(0.5, 1000));
  assert.equal(nextGate(open, CFG, at(0.01, 1200)).open, true, "still inside the hold");
  assert.equal(nextGate(open, CFG, at(0.01, 1400)).open, false, "hold expired");
});

test("the ambiguous band keeps whatever state it was in", () => {
  const mid = at(0.12, 5000); // between vadClose and vadOpen
  assert.equal(nextGate(OPEN, CFG, mid).open, true, "mid-word dip must not cut you off");
  assert.equal(nextGate(GATE_CLOSED, CFG, mid).open, false, "room tone must not open it");
});

test("the ambiguous band never re-arms the hold timer", () => {
  // A steady hum sitting just above the silence floor would otherwise refresh
  // holdUntil forever and pin the channel open.
  const open: GateState = { open: true, holdUntil: 1300 };
  const g = nextGate(open, CFG, at(0.12, 1200));
  assert.equal(g.holdUntil, 1300, "unchanged");
  assert.equal(nextGate(g, CFG, at(0.05, 1400)).open, false, "and it does eventually close");
});

test("a zero hold time closes the gate the moment speech stops", () => {
  const cfg = { ...CFG, holdMs: 0 };
  const open = nextGate(GATE_CLOSED, cfg, at(0.5, 1000));
  assert.equal(nextGate(open, cfg, at(0.01, 1000)).open, false);
});

test("equal thresholds still behave -- open wins the tie", () => {
  const cfg = { ...CFG, vadOpen: 0.2, vadClose: 0.2 };
  assert.equal(nextGate(GATE_CLOSED, cfg, at(0.2, 0)).open, true);
  assert.equal(nextGate(GATE_CLOSED, cfg, at(0.19, 0)).open, false);
});
