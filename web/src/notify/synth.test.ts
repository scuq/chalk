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
import { HIGHPASS_HZ, MAX_Q, SCREECH_FLOOR_HZ, SOUND_SPECS } from "./synth.ts";
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
});
