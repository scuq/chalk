// The chalk-stroke pack, as data.
//
// There is no AudioContext in Node, so the graph itself can't be tested
// here -- which is exactly why the pack is a plain table. What these
// tests protect is the set of invariants a later "let's make it a bit
// brighter" edit could quietly break, above all the lowpass ceiling that
// keeps this sounding like chalk instead of like nails.
//
// Whether it actually sounds *good* is not a unit test. That is the
// listening pass, and it has to be redone whenever these numbers move.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HIGHPASS_HZ,
  MAX_Q,
  MIN_SLIPS_PER_STROKE,
  SCREECH_FLOOR_HZ,
  SOUND_SPECS,
} from "./synth.ts";
import { SOUND_CATEGORIES } from "./types.ts";

test("every category has a spec", () => {
  for (const c of SOUND_CATEGORIES) {
    assert.ok(SOUND_SPECS[c], `${c} has no sound`);
  }
  assert.deepEqual(Object.keys(SOUND_SPECS).sort(), [...SOUND_CATEGORIES].sort());
});

test("nothing reaches into the screech band", () => {
  // The whole pack rests on this. Stick-slip resonance -- the sound
  // everyone means by "nails on a blackboard" -- starts around here, and
  // a category that pokes into it stops being warm chalk.
  for (const c of SOUND_CATEGORIES) {
    const { lowpassHz } = SOUND_SPECS[c];
    assert.ok(
      lowpassHz < SCREECH_FLOOR_HZ,
      `${c} lowpass ${lowpassHz}Hz is at or above the screech floor ${SCREECH_FLOOR_HZ}Hz`,
    );
  }
});

test("the lowpass always leaves something above the highpass", () => {
  for (const c of SOUND_CATEGORIES) {
    const spec = SOUND_SPECS[c];
    assert.ok(
      spec.lowpassHz > HIGHPASS_HZ * 2,
      `${c} has no passband left between ${HIGHPASS_HZ}Hz and ${spec.lowpassHz}Hz`,
    );
  }
});

test("every stroke has one or two marks, in audible range", () => {
  for (const c of SOUND_CATEGORIES) {
    const { centers } = SOUND_SPECS[c];
    assert.ok(centers.length >= 1 && centers.length <= 2, `${c} has ${centers.length} strokes`);
    for (const f of centers) {
      assert.ok(f >= 100 && f <= 2000, `${c} centre ${f}Hz is outside the pack's range`);
    }
  }
});

test("nothing is narrow enough to ring", () => {
  // The peep test. A narrow band makes noise sing at its centre, and once
  // it sings this stops being chalk and starts being a beep -- which is
  // the specific thing this pack was retuned away from.
  for (const c of SOUND_CATEGORIES) {
    const { q } = SOUND_SPECS[c];
    assert.ok(q > 0, `${c} Q must be positive`);
    assert.ok(q <= MAX_Q, `${c} Q of ${q} is narrow enough to peep (max ${MAX_Q})`);
  }
});

test("every stroke actually moves", () => {
  // A static band is a hiss. The travel is what makes it a swish, so a
  // sweep of 1 is a bug, not a valid setting.
  for (const c of SOUND_CATEGORIES) {
    const { sweep } = SOUND_SPECS[c];
    assert.ok(sweep > 0, `${c} sweep must be positive -- it is an exponential ramp target`);
    assert.ok(Math.abs(sweep - 1) > 0.1, `${c} barely moves (sweep ${sweep})`);
  }
});

test("a swept band never climbs into the screech", () => {
  // The ceiling has to hold at the END of the sweep, not just the start.
  for (const c of SOUND_CATEGORIES) {
    const s = SOUND_SPECS[c];
    const top = Math.max(...s.centers) * Math.max(1, s.sweep);
    assert.ok(top < SCREECH_FLOOR_HZ, `${c} sweeps up to ${top}Hz, into the screech band`);
    assert.ok(top < s.lowpassHz, `${c} sweeps to ${top}Hz, past its own ${s.lowpassHz}Hz ceiling`);
  }
});

test("every stroke rasps, at a rate that is a rasp and not a wobble", () => {
  // The stick-slip grain. Two ways to get this wrong: a rate outside the
  // range where friction reads as texture, and -- the subtle one -- a
  // stroke too short to fit enough slips in, where the modulation is heard
  // as a single dip rather than as grain.
  for (const c of SOUND_CATEGORIES) {
    const s = SOUND_SPECS[c];
    assert.ok(s.grain > 0, `${c} has no grain -- smooth noise is a vent, not chalk`);
    assert.ok(s.grain <= 0.8, `${c} grain of ${s.grain} guts the stroke into separate scratches`);
    assert.ok(s.grainHz >= 20 && s.grainHz <= 100, `${c} grain rate ${s.grainHz}Hz is outside 20-100`);
    const slips = (s.strokeMs / 1000) * s.grainHz;
    assert.ok(
      slips >= MIN_SLIPS_PER_STROKE,
      `${c} fits only ${slips.toFixed(1)} slips in ${s.strokeMs}ms -- that is a wobble`,
    );
  }
});

test("the contact tick opens a stroke without becoming one", () => {
  for (const c of SOUND_CATEGORIES) {
    const { tick } = SOUND_SPECS[c];
    assert.ok(tick >= 0 && tick <= 0.35, `${c} tick of ${tick} is loud enough to be its own event`);
  }
});

test("gains and layers stay inside their ranges", () => {
  for (const c of SOUND_CATEGORIES) {
    const s = SOUND_SPECS[c];
    for (const [name, v] of [
      ["gain", s.gain],
      ["body", s.body],
    ] as const) {
      assert.ok(v >= 0 && v <= 1, `${c} ${name} = ${v} is outside 0..1`);
    }
    assert.ok(s.strokeMs > 0 && s.gapMs >= 0);
  }
});

test("rising means for-you, falling means something-went-wrong", () => {
  for (const c of ["mention", "dm", "thread_reply", "presence", "connect"] as const) {
    const s = SOUND_SPECS[c];
    assert.ok(s.sweep > 1, `${c} should sweep up`);
    const [a, b] = s.centers;
    if (b !== undefined) assert.ok(b > a, `${c} should rise across its strokes too`);
  }
  for (const c of ["disconnect", "error"] as const) {
    const s = SOUND_SPECS[c];
    assert.ok(s.sweep < 1, `${c} should sweep down`);
    const [a, b] = s.centers;
    assert.ok(b !== undefined && b < a, `${c} should fall across its strokes too`);
  }
});

test("the call sounds are two mirrored pairs", () => {
  // 71-1. Coming and going are told apart by direction alone, so a pair
  // that drifted to the same sign would leave the two indistinguishable --
  // and yours has to stay bigger than everyone else's, or you can't tell
  // your own arrival from the fourth person walking in.
  for (const [inb, out] of [
    ["call_join", "call_leave"],
    ["peer_join", "peer_leave"],
  ] as const) {
    assert.ok(SOUND_SPECS[inb].sweep > 1, `${inb} should sweep up`);
    assert.ok(SOUND_SPECS[out].sweep < 1, `${out} should sweep down`);
  }
  assert.ok(SOUND_SPECS.call_join.body > SOUND_SPECS.peer_join.body);
  assert.ok(SOUND_SPECS.call_join.gain > SOUND_SPECS.peer_join.gain);
  assert.ok(SOUND_SPECS.peer_join.strokeMs < SOUND_SPECS.call_join.strokeMs);
  // The two peer sounds have to sit in the same place on the board, or
  // brightness starts carrying meaning the pack never assigned it.
  assert.deepEqual(SOUND_SPECS.peer_join.centers, SOUND_SPECS.peer_leave.centers);
  assert.equal(SOUND_SPECS.peer_join.lowpassHz, SOUND_SPECS.peer_leave.lowpassHz);
});

test("the categories that fire most often are the quietest", () => {
  // "every message" can fire all day in a busy channel, and a send
  // confirmation fires on every single thing you type. Neither may be as
  // loud as a mention.
  assert.ok(SOUND_SPECS.message.gain < SOUND_SPECS.mention.gain);
  assert.ok(SOUND_SPECS.send_confirm.gain < SOUND_SPECS.message.gain);
  assert.ok(SOUND_SPECS.message.strokeMs <= SOUND_SPECS.mention.strokeMs);
});

test("disconnect is an eraser, not a chalk stroke", () => {
  // It has to be unmistakable against the rest of the pack: wider, duller
  // and longer than anything else.
  const eraser = SOUND_SPECS.disconnect;
  const strokes = SOUND_CATEGORIES.filter((c) => c !== "disconnect").map((c) => SOUND_SPECS[c]);
  assert.ok(
    strokes.every((s) => eraser.q < s.q),
    "the eraser must be the widest band in the pack",
  );
  assert.ok(
    strokes.every((s) => eraser.strokeMs >= s.strokeMs),
    "the eraser must be the longest stroke in the pack",
  );
  assert.ok(
    strokes.every((s) => eraser.body >= s.body),
    "the eraser must have the most mass behind it",
  );
  assert.equal(eraser.tick, 0, "an eraser is not set down like a piece of chalk");
  assert.ok(
    strokes.every((s) => eraser.grainHz <= s.grainHz),
    "the eraser's crumble must be the coarsest thing in the pack",
  );
});
