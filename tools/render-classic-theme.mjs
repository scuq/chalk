// chalk -- renders the "chalk classic" sound theme from phase 40/71's
// synthesizer specs.
//
// 102-1 deleted `web/src/notify/synth.ts`: a 700-line noise-and-bandpass
// graph plus seventeen hand-tuned StrokeSpec rows, replaced by recorded
// themes. 102-3 brings the *sound* back without bringing the code back --
// this script is the synth's signal path reimplemented once, offline, and
// run to produce ten WAVs under `web/assets/sounds/chalk-classic/`. The
// client never sees an oscillator or a filter again; it fetches files like
// it does for every other theme.
//
// The spec table below is copied verbatim from the deleted synth.ts
// (commit 5785cb6^), including the comments that defend each number --
// those numbers are a recording of a listening session and re-deriving
// them is not possible. Only the ten categories that own a cue are kept;
// the eight rules-routed event types all play `message` (see CUE_FOR in
// web/src/notify/themes.ts), so mention/dm/thread_reply/voice/
// channel_added/friend_request/governance have nowhere to sound and are
// dropped rather than rendered into files nothing would play.
//
// The DSP is the WebAudio graph the synth built, evaluated per sample:
// pink noise -> bandpass (exponentially swept) -> highpass -> lowpass,
// gain-modulated by a random stick-slip grain, under an attack/drag/lift
// envelope, plus an octave-down "body" band joining at the lowpass and an
// ungrained contact tick straight to the mix. Biquad coefficients follow
// the WebAudio spec's cookbook, including its wart that lowpass and
// highpass read Q in decibels while bandpass reads it linearly.
//
// Deterministic: one seeded PRNG drives the noise, the grain and every
// random read offset, so re-running reproduces the committed files
// byte for byte. Real chalk is never identical twice; a repository is.
//
//   node tools/render-classic-theme.mjs            # render + report levels
//   node tools/render-classic-theme.mjs --measure  # report only, write nothing

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SAMPLE_RATE = 48000;
const OUT_DIR = join("web", "assets", "sounds", "chalk-classic");
const SOUNDS_DIR = join("web", "assets", "sounds");

// ---------------------------------------------------------------- specs

// Shared gesture: attack, drag, lift. The attack is slow enough to swell
// rather than tick -- a fast edge on a wide band is a click. The long
// release is most of what makes the pack feel soft rather than clipped.
const ATTACK_MS = 30;
const RELEASE_MS = 95;
// The contact tick's length: a tick, not a digital edge, not a note.
const TICK_MS = 5;
// The grain modulator is generated at this rate and shifted per stroke.
const GRAIN_REF_HZ = 50;
// Uniform white noise on [-1,1] has this RMS; the pink source is
// normalized to it so swapping colour was not also a change of volume.
const WHITE_RMS = 1 / Math.sqrt(3);
// Rumble the drag would otherwise leave in the low end, set below the
// darkest category's band.
const HIGHPASS_HZ = 120;

// Which cue each rendered category becomes. The stems are ThemeCue in
// web/src/notify/themes.ts; the categories are SoundCategory.
const CUE_FOR = {
  presence: "01_friend_online",
  call_join: "02_you_join_call",
  call_leave: "03_you_leave_call",
  peer_join: "04_someone_joins",
  peer_leave: "05_someone_leaves",
  connect: "06_connected",
  disconnect: "07_disconnected",
  send_confirm: "08_send_confirmed",
  error: "09_error",
  message: "10_new_message",
};

const SOUND_SPECS = {
  // One short swish. This is the category that can fire all day, so it is
  // the shortest and quietest thing here by a clear margin.
  message: {
    centers: [540],
    strokeMs: 95,
    gapMs: 0,
    q: 0.95,
    sweep: 1.35,
    lowpassHz: 2300,
    body: 0.13,
    grainHz: 70,
    grain: 0.34,
    tick: 0.07,
    gain: 0.39,
  },
  // Soft and low-contrast; a friend appearing is information, not a
  // summons.
  presence: {
    centers: [500, 700],
    strokeMs: 105,
    gapMs: 40,
    q: 0.9,
    sweep: 1.3,
    lowpassHz: 2200,
    body: 0.13,
    grainHz: 56,
    grain: 0.36,
    tick: 0.06,
    gain: 0.37,
  },
  // 71-1, the call roster. Four sounds in two mirrored pairs: the room's
  // arrivals and departures told apart by direction, and yours told apart
  // from everyone else's by size.
  //
  // Stepping into the room: two warm strokes rising, with more mass behind
  // them than anything here that isn't the eraser. The only one of the
  // four that happens *to* you rather than around you, so it is the
  // biggest.
  call_join: {
    centers: [360, 560],
    strokeMs: 110,
    gapMs: 40,
    q: 1,
    sweep: 1.45,
    lowpassHz: 2200,
    body: 0.21,
    grainHz: 44,
    grain: 0.46,
    tick: 0.1,
    gain: 0.48,
  },
  // The same two strokes walked backwards. It falls, but it stays as warm
  // and as wide as the arrival: leaving a room you chose to leave is not
  // an error, and it must not sound like one.
  call_leave: {
    centers: [560, 360],
    strokeMs: 105,
    gapMs: 40,
    q: 1,
    sweep: 0.7,
    lowpassHz: 2200,
    body: 0.21,
    grainHz: 44,
    grain: 0.44,
    tick: 0.08,
    gain: 0.38,
  },
  // One short stroke, brighter and much lighter than your own arrival:
  // somebody else is at the board. Quiet on purpose -- in a room of eight
  // this fires eight times.
  peer_join: {
    centers: [640],
    strokeMs: 80,
    gapMs: 0,
    q: 1.1,
    sweep: 1.5,
    lowpassHz: 2600,
    body: 0.09,
    grainHz: 68,
    grain: 0.36,
    tick: 0.08,
    gain: 0.39,
  },
  // Its mirror, from the same place on the board: same brightness, same
  // length, opposite direction. Hearing which of the two it was is this
  // pair's entire job, and direction is how this pack says it.
  peer_leave: {
    centers: [640],
    strokeMs: 80,
    gapMs: 0,
    q: 1.1,
    sweep: 0.66,
    lowpassHz: 2600,
    body: 0.1,
    grainHz: 68,
    grain: 0.36,
    tick: 0.06,
    gain: 0.31,
  },
  // The board is back.
  connect: {
    centers: [440, 600],
    strokeMs: 100,
    gapMs: 35,
    q: 1,
    sweep: 1.4,
    lowpassHz: 2400,
    body: 0.16,
    grainHz: 52,
    grain: 0.4,
    tick: 0.09,
    gain: 0.46,
  },
  // Deliberately not a chalk stroke: an eraser sweep. The widest, dullest,
  // longest thing in the pack, and the only one that falls hard. Losing
  // the connection should sound like the board being wiped, and it has to
  // be unmistakable against everything else here.
  disconnect: {
    centers: [580, 380],
    strokeMs: 220,
    gapMs: 25,
    q: 0.5,
    sweep: 0.55,
    lowpassHz: 1500,
    body: 0.27,
    grainHz: 26,
    grain: 0.5,
    tick: 0,
    gain: 0.41,
  },
  // Barely there. You asked for confirmation, not for an announcement.
  send_confirm: {
    centers: [950],
    strokeMs: 60,
    gapMs: 0,
    q: 1.2,
    sweep: 1.3,
    lowpassHz: 2900,
    body: 0.06,
    grainHz: 80,
    grain: 0.28,
    tick: 0.06,
    gain: 0.32,
  },
  // Dark and heavy -- chalk dragged hard, low on the board, falling away.
  // The darkest thing in the pack, and still warm: an error is not a
  // reason to make the screech.
  error: {
    centers: [285, 200],
    strokeMs: 180,
    gapMs: 50,
    q: 0.85,
    sweep: 0.6,
    lowpassHz: 1250,
    body: 0.26,
    grainHz: 30,
    grain: 0.5,
    tick: 0.11,
    gain: 0.35,
  },
};

// ------------------------------------------------------------ the noise

// mulberry32. The synth called Math.random; a file in git may not.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A second of pink noise. Pink rather than white because friction is:
// energy falls off with frequency, so a flat source under one of these
// wide bands piles up at the top of the passband and reads thin and
// hissy. Kellett's economy filter -- six one-poles summed. Normalized to
// WHITE_RMS, not to a peak of 1.
function makeNoise(rand) {
  const frames = SAMPLE_RATE;
  const data = new Float64Array(frames);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  let sum = 0;
  for (let i = 0; i < frames; i++) {
    const w = rand() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    data[i] = pink;
    sum += pink * pink;
  }
  const rms = Math.sqrt(sum / frames);
  if (rms > 0) {
    const k = WHITE_RMS / rms;
    for (let i = 0; i < frames; i++) data[i] *= k;
  }
  return data;
}

// The stick-slip modulator: two seconds of random values in 0..1, held
// for one GRAIN_REF_HZ period each and joined by straight lines. Random
// and not an LFO, because a periodic modulator at 20-100 Hz has a rate
// you can hear as a pitch -- that is a buzz, and this pack has no pitch.
// Interpolated and not stepped, because a hard step in a gain is a click.
// Two seconds rather than one: a stroke played at up to 2x rate eats
// twice its own length of this buffer.
function makeGrain(rand) {
  const frames = SAMPLE_RATE * 2;
  const hold = Math.max(1, Math.floor(SAMPLE_RATE / GRAIN_REF_HZ));
  const data = new Float64Array(frames);
  let from = rand();
  let to = rand();
  for (let i = 0; i < frames; i++) {
    const step = i % hold;
    if (step === 0 && i > 0) {
      from = to;
      to = rand();
    }
    data[i] = from + (to - from) * (step / hold);
  }
  return data;
}

// ----------------------------------------------------------- the filter

// A WebAudio BiquadFilterNode, direct form 1, coefficients recomputed per
// sample so a swept centre moves smoothly. The spec's Q convention is not
// uniform: lowpass and highpass read it as decibels, bandpass linearly.
class Biquad {
  constructor(type, q) {
    this.type = type;
    this.q = q;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }
  step(x, freq) {
    const w0 = (2 * Math.PI * freq) / SAMPLE_RATE;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    let b0, b1, b2, a0, a1, a2;
    if (this.type === "bandpass") {
      const alpha = sin / (2 * this.q);
      b0 = alpha; b1 = 0; b2 = -alpha;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
    } else {
      const alpha = sin / (2 * Math.pow(10, this.q / 20));
      if (this.type === "lowpass") {
        b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
      } else {
        b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
      }
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
    }
    const y =
      (b0 / a0) * x + (b1 / a0) * this.x1 + (b2 / a0) * this.x2 -
      (a1 / a0) * this.y1 - (a2 / a0) * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

// ---------------------------------------------------------- the strokes

// Sample a buffer at a fractional index, the way playbackRate does.
function tap(buf, pos) {
  const i = Math.floor(pos);
  if (i < 0 || i + 1 >= buf.length) return 0;
  const f = pos - i;
  return buf[i] + (buf[i + 1] - buf[i]) * f;
}

// The envelope: attack to `gain`, hold through the drag, linear lift to
// silence. Linear rather than exponential because a lifted piece of chalk
// goes properly silent, and exponentialRamp cannot reach zero.
function envAt(t, gain, dur) {
  const attack = ATTACK_MS / 1000;
  const release = RELEASE_MS / 1000;
  if (t <= 0) return 0;
  if (t < attack) return gain * (t / attack);
  if (t <= dur) return gain;
  if (t >= dur + release) return 0;
  return gain * (1 - (t - dur) / release);
}

// One stroke, mixed into `out` starting at sample `start`: noise through a
// wide bandpass that travels while it sounds, rasped by the grain
// modulator, plus a quieter octave-down band for mass and a tick where the
// chalk lands. All but the tick share one envelope.
function stroke(out, start, spec, center, noise, grain, rand) {
  const dur = spec.strokeMs / 1000;
  const release = RELEASE_MS / 1000;
  const span = dur + release;
  const n = Math.ceil(span * SAMPLE_RATE);

  // Start somewhere in the noise so repeats aren't bit-identical -- real
  // chalk never is. Both the stroke and its body read the same offset, as
  // the two source nodes did.
  const noiseSec = noise.length / SAMPLE_RATE;
  const offset = rand() * Math.max(0, noiseSec - span) * SAMPLE_RATE;

  const grainRate = spec.grainHz / GRAIN_REF_HZ;
  const grainSec = grain.length / SAMPLE_RATE;
  const eats = span * grainRate;
  const grainOffset = rand() * Math.max(0, grainSec - eats) * SAMPLE_RATE;

  const band = new Biquad("bandpass", spec.q);
  const bodyBand = new Biquad("bandpass", 0.6);
  const hp = new Biquad("highpass", 1);
  const lp = new Biquad("lowpass", 1);

  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    // The swish. Exponential rather than linear because pitch is
    // logarithmic: a linear ramp spends most of its time at the top and
    // arrives with a lurch.
    const k = Math.pow(spec.sweep, Math.min(1, t / span));
    const src = tap(noise, offset + i);

    let x = hp.step(band.step(src, center * k), HIGHPASS_HZ);
    if (spec.body > 0) {
      // Follows the sweep an octave down, so the mass travels with the
      // stroke instead of sitting still underneath it. Through the
      // lowpass, not straight to the envelope: a band this wide has
      // gentle skirts, and left unfiltered it would sneak the screech
      // back in behind the ceiling the rest of the stroke respects.
      x += bodyBand.step(src, (center / 2) * k) * spec.body;
    }
    x = lp.step(x, spec.lowpassHz);

    // The rasp rides between 1 - grain and 1, driven by the random
    // modulator rather than by an oscillator.
    if (spec.grain > 0) {
      x *= 1 - spec.grain + spec.grain * tap(grain, grainOffset + i * grainRate);
    }
    const at = start + i;
    if (at < out.length) out[at] += x * envAt(t, spec.gain, dur);
  }

  if (spec.tick > 0) {
    // Contact. Its own envelope and its own ceiling, because the stroke's
    // envelope is still at zero here -- the attack ramp is what the tick
    // exists to give an edge to, so it cannot ride inside it. Ungrained:
    // five milliseconds is one slip, not a texture.
    const tickN = Math.ceil((TICK_MS / 1000) * SAMPLE_RATE);
    const tickLp = new Biquad("lowpass", 1);
    const tickOffset = rand() * Math.max(0, noiseSec - 0.05) * SAMPLE_RATE;
    const peak = spec.gain * spec.tick;
    const rise = 0.001 * SAMPLE_RATE;
    for (let i = 0; i < tickN; i++) {
      const y = tickLp.step(tap(noise, tickOffset + i), spec.lowpassHz);
      const e = i < rise ? peak * (i / rise) : peak * (1 - (i - rise) / (tickN - rise));
      const at = start + i;
      if (at < out.length) out[at] += y * Math.max(0, e);
    }
  }
}

function render(category, rand) {
  const spec = SOUND_SPECS[category];
  const noise = makeNoise(rand);
  const grain = makeGrain(rand);
  const span = spec.strokeMs / 1000 + RELEASE_MS / 1000;
  const lead = (spec.centers.length - 1) * ((spec.strokeMs + spec.gapMs) / 1000);
  // 10 ms of silence past the last lift, so nothing sits on the last
  // sample of the file.
  const frames = Math.ceil((lead + span + 0.01) * SAMPLE_RATE);
  const out = new Float64Array(frames);
  let at = 0;
  for (const center of spec.centers) {
    stroke(out, Math.round(at * SAMPLE_RATE), spec, center, noise, grain, rand);
    at += (spec.strokeMs + spec.gapMs) / 1000;
  }
  return out;
}

// ------------------------------------------------------------- the file

function writeWav(path, mono) {
  // Stereo like every other theme's cues: the synth was mono, so both
  // channels carry the same samples.
  const frames = mono.length;
  const bytes = Buffer.alloc(44 + frames * 4);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + frames * 4, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); // PCM
  bytes.writeUInt16LE(2, 22); // stereo
  bytes.writeUInt32LE(SAMPLE_RATE, 24);
  bytes.writeUInt32LE(SAMPLE_RATE * 4, 28); // byte rate
  bytes.writeUInt16LE(4, 32); // block align
  bytes.writeUInt16LE(16, 34); // bits
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const v = Math.max(-1, Math.min(1, mono[i]));
    const s = Math.round(v * 32767);
    bytes.writeInt16LE(s, 44 + i * 4);
    bytes.writeInt16LE(s, 44 + i * 4 + 2);
  }
  writeFileSync(path, bytes);
}

// ------------------------------------------------------------- measuring

function levels(samples) {
  let peak = 0;
  let sum = 0;
  for (const v of samples) {
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
  }
  return { peak, rms: Math.sqrt(sum / samples.length) };
}

// Read an existing theme's cue back to float, so the new theme can be
// matched to the family rather than to full scale.
function readWav(path) {
  const b = readFileSync(path);
  const bits = b.readUInt16LE(34);
  const channels = b.readUInt16LE(22);
  let at = 12;
  while (at + 8 <= b.length) {
    const id = b.toString("ascii", at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === "data") {
      const step = bits / 8;
      const n = Math.floor(size / step);
      const out = new Float64Array(Math.floor(n / channels));
      for (let i = 0; i < out.length; i++) {
        const o = at + 8 + i * channels * step;
        out[i] = bits === 16 ? b.readInt16LE(o) / 32768 : (b.readIntLE(o, 3) / 8388608);
      }
      return out;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error(`${path}: no data chunk`);
}

// Only WAV themes are measured. 102-4's arcade ships upstream's MP3s and
// nothing here decodes MP3 -- it is reported as unmeasured rather than as
// silent, which is what a zero would have looked like.
function measureThemes() {
  const rows = [];
  for (const theme of readdirSync(SOUNDS_DIR).sort()) {
    let peak = 0;
    let rmsSum = 0;
    let n = 0;
    for (const f of readdirSync(join(SOUNDS_DIR, theme))) {
      if (!f.endsWith(".wav")) continue;
      const l = levels(readWav(join(SOUNDS_DIR, theme, f)));
      if (l.peak > peak) peak = l.peak;
      rmsSum += l.rms;
      n++;
    }
    rows.push({ theme, peak, meanRms: n ? rmsSum / n : 0, cues: n });
  }
  return rows;
}

const db = (v) => (v > 0 ? (20 * Math.log10(v)).toFixed(1) : "-inf");

// Where a cue's energy actually sits, by octave band. The synth's one
// non-negotiable invariant was that nothing reaches the stick-slip screech
// band (roughly 2-8 kHz, floor at 5200 Hz), which its tests enforced on the
// spec table. The table is no longer code, so the check moves here and is
// made on the rendered audio instead: `--spectrum` prints the band split
// and the fraction above 5200 Hz. Goertzel over a log-spaced grid -- coarse
// on purpose, this is a ceiling check and not an analyzer.
const OCTAVES = [125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const SCREECH_FLOOR_HZ = 5200;

function bandEnergy(samples, freq) {
  const w = (2 * Math.PI * freq) / SAMPLE_RATE;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

// Sum a handful of probes per octave so a swept band is not missed between
// two grid points.
function spectrum(samples) {
  const bands = OCTAVES.map((f) => {
    let e = 0;
    for (let k = 0; k < 6; k++) e += bandEnergy(samples, f * Math.pow(2, k / 6));
    return e;
  });
  const total = bands.reduce((a, b) => a + b, 0) || 1;
  let above = 0;
  for (let i = 0; i < OCTAVES.length; i++) {
    if (OCTAVES[i] >= SCREECH_FLOOR_HZ) above += bands[i];
  }
  return { shares: bands.map((b) => b / total), aboveFloor: above / total };
}

// ---------------------------------------------------------------- main

// One trim for the whole theme, not one per cue: the specs' `gain` column
// is a balance between the ten sounds that was tuned by ear, and
// normalizing each file separately would throw it away. Every cue is
// scaled by the same factor, derived so the loudest of them lands here.
//
// -6.4 dBFS. The synth ran an order of magnitude below full scale -- its
// raw peak here is -9.6 dBFS and its quietest cue far below that -- and the
// authored themes do not, so rendering it untrimmed would make switching to
// this theme a switch to near-silence.
//
// The figure was derived in 102-3 against the *chalk* theme, whose loudest
// cue sat at -6.4 dBFS and whose mean per-cue RMS this lands within 0.2 dB
// of. 102-4 removed that theme, and the value stays: empir peaks at the
// same -6.4 and runestone at -6.2, so it is still the family's ceiling, and
// re-deriving it would rewrite ten committed files to move nothing. The
// level report below is how that is checked; re-run it if a cue moves.
const TARGET_PEAK = 0.48;

const measureOnly = process.argv.includes("--measure");
const showSpectrum = process.argv.includes("--spectrum");

const rendered = new Map();
for (const category of Object.keys(CUE_FOR)) {
  // One seed per category, so editing or adding one cue does not re-roll
  // the noise under the other nine.
  const seed = [...category].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0x9e37);
  rendered.set(category, render(category, rng(seed)));
}

let maxPeak = 0;
for (const s of rendered.values()) maxPeak = Math.max(maxPeak, levels(s).peak);
const trim = TARGET_PEAK / maxPeak;

console.log(`raw peak ${maxPeak.toFixed(4)} (${db(maxPeak)} dBFS) -> trim x${trim.toFixed(2)}\n`);
console.log("cue                        dur     peak      rms");
for (const [category, samples] of rendered) {
  for (let i = 0; i < samples.length; i++) samples[i] *= trim;
  const l = levels(samples);
  const secs = samples.length / SAMPLE_RATE;
  console.log(
    `${CUE_FOR[category].padEnd(22)} ${(secs * 1000).toFixed(0).padStart(5)} ms` +
      ` ${db(l.peak).padStart(7)} ${db(l.rms).padStart(8)} dB`,
  );
}

if (!measureOnly) {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [category, samples] of rendered) {
    writeWav(join(OUT_DIR, `${CUE_FOR[category]}.wav`), samples);
  }
  console.log(`\nwrote ${rendered.size} cues to ${OUT_DIR}`);
}

if (showSpectrum) {
  console.log(`\nenergy by octave (%), and the share at or above ${SCREECH_FLOOR_HZ} Hz:`);
  console.log(`cue                    ${OCTAVES.map((f) => String(f).padStart(5)).join("")}   screech`);
  for (const [category, samples] of rendered) {
    const sp = spectrum(samples);
    console.log(
      `${CUE_FOR[category].padEnd(22)} ` +
        sp.shares.map((v) => (v * 100).toFixed(1).padStart(5)).join("") +
        `   ${(sp.aboveFloor * 100).toFixed(2)}%`,
    );
  }
}

console.log("\ntheme levels (max peak, mean per-cue rms):");
for (const r of measureThemes()) {
  if (!r.cues) {
    console.log(`  ${r.theme.padEnd(14)} not WAV — not measured here`);
    continue;
  }
  console.log(
    `  ${r.theme.padEnd(14)} ${r.cues} cues  peak ${db(r.peak).padStart(6)} dB` +
      `  rms ${db(r.meanRms).padStart(6)} dB`,
  );
}
