// chalk-web -- the chalk-stroke sound pack.
//
// The app is called chalk, so every notification is a stroke of chalk on
// a board. That is not a bell and not a beep: a bell is a pitched
// oscillator that gets struck and decays, chalk is *friction* -- broadband
// noise, shaped by what you take out of it.
//
//   bell / chime          chalk stroke
//   |\____                 __---____
//   struck, decays         contact, drag, lift
//
// Four things make the difference between the two chalk sounds, the warm
// line and the sound that empties a room:
//
//   lowpassHz  the nails-on-a-blackboard screech is stick-slip resonance
//              at roughly 2-8 kHz. Keeping the ceiling well under that is
//              the single parameter this whole pack lives or dies on.
//              If anything here ever sounds sharp, this comes down.
//   q          how narrow the band is. This is the peep control: a narrow
//              band makes noise ring at its centre and the stroke turns
//              into a beep. Everything here stays wide, so it reads as
//              rustle rather than tone.
//   sweep      the band moves while the stroke sounds -- that movement is
//              the swish. A static band, however wide, is a shhh; a
//              moving one is a piece of chalk actually travelling across
//              a board.
//   body       a big piece of chalk has mass -- a quiet layer an octave
//              down, wide and dull, is what supplies it.
//
// The envelope is attack, drag, lift. Not an exponential decay: that's a
// struck bell, and this is a drawn line.
//
// There is deliberately no oscillator anywhere in here. An earlier version
// put a quiet sine under the noise to give each category a nameable pitch;
// it made every sound peep. Categories are told apart by brightness,
// length, sweep direction and stroke count instead, which is how you tell
// two real chalk strokes apart.
//
// Band centres are still A-minor-pentatonic-ish, less because anyone will
// hear the interval and more because it keeps the family spaced evenly.
// Direction carries the meaning: rising = something arrived for you,
// falling = something went wrong.
//
// These numbers were tuned by ear against the audition harness; treat the
// table as a recording of that session, not as arithmetic. Changing one
// means listening again.

import type { SoundCategory } from "./types";

export interface StrokeSpec {
  // Bandpass centre per stroke, Hz -- where the stroke starts. Two entries
  // = two strokes, one after the other.
  centers: number[];
  strokeMs: number;
  gapMs: number;
  // Bandpass width. Low is wide is rustle; high is narrow is peep. Nothing
  // in this pack goes above MAX_Q.
  q: number;
  // Where the band ends up, as a multiple of where it started. >1 sweeps
  // up, <1 sweeps down, 1 would be a static hiss. This is the swish.
  sweep: number;
  // The anti-screech ceiling.
  lowpassHz: number;
  // Gain of the octave-down layer, 0..1. This is "how big the chalk is".
  body: number;
  // Per-category trim, so the ones that fire often sit back in the mix.
  gain: number;
}

// Attack and release are shared: the gesture is the same everywhere, only
// its length and colour change. The attack is slow enough to swell rather
// than tick -- a fast edge on a wide band is a click, and a click is the
// other thing that reads as a peep. The long release is most of what makes
// the pack feel soft rather than clipped.
export const ATTACK_MS = 30;
export const RELEASE_MS = 95;

// A hard ceiling on resonance. Above roughly this the band stops colouring
// the noise and starts ringing at its centre, which is precisely the peep
// this pack is not. Enforced by the tests.
export const MAX_Q = 1.6;

// Rumble the drag would otherwise leave in the low end. Set below the
// darkest category's band so it trims mud without thinning the strokes
// that are supposed to sound low.
export const HIGHPASS_HZ = 120;

// Nothing in the pack may sit at or above this: it is the bottom of the
// stick-slip screech band. Enforced by the tests so a later "just a bit
// brighter" tweak can't quietly reintroduce the bad chalk sound.
export const SCREECH_FLOOR_HZ = 5200;

export const SOUND_SPECS: Record<SoundCategory, StrokeSpec> = {
  // Two bright swishes, the highest thing in the pack. A mention should
  // cut through whatever else is happening.
  mention: {
    centers: [820, 1180],
    strokeMs: 120,
    gapMs: 45,
    q: 1.1,
    sweep: 1.5,
    lowpassHz: 3000,
    body: 0.16,
    gain: 0.85,
  },
  // The same gesture, lower and broader: unmistakably personal, warmer.
  dm: {
    centers: [620, 880],
    strokeMs: 130,
    gapMs: 50,
    q: 1.05,
    sweep: 1.4,
    lowpassHz: 2700,
    body: 0.2,
    gain: 0.85,
  },
  // Two close strokes for a lesser event -- present, not demanding.
  thread_reply: {
    centers: [700, 790],
    strokeMs: 100,
    gapMs: 35,
    q: 1.05,
    sweep: 1.25,
    lowpassHz: 2600,
    body: 0.16,
    gain: 0.72,
  },
  // One short swish. This is the category that can fire all day, so it is
  // the shortest and quietest thing here by a clear margin.
  message: {
    centers: [540],
    strokeMs: 95,
    gapMs: 0,
    q: 0.95,
    sweep: 1.35,
    lowpassHz: 2300,
    body: 0.18,
    gain: 0.58,
  },
  // A rising pair with a wide interval -- an invitation, not an alarm.
  // Sits between dm and mention in brightness: a call starting is worth
  // looking up for, but nobody is asking for you by name.
  voice: {
    centers: [560, 940],
    strokeMs: 125,
    gapMs: 55,
    q: 1.05,
    sweep: 1.45,
    lowpassHz: 2800,
    body: 0.2,
    gain: 0.78,
  },
  // A door opening: one warm low stroke, then a brighter one -- you've
  // been let in somewhere new.
  channel_added: {
    centers: [420, 720],
    strokeMs: 115,
    gapMs: 45,
    q: 1,
    sweep: 1.4,
    lowpassHz: 2500,
    body: 0.24,
    gain: 0.7,
  },
  // Personal like the dm stroke but narrower in travel: someone is at
  // the door rather than already talking to you.
  friend_request: {
    centers: [640, 760],
    strokeMs: 110,
    gapMs: 50,
    q: 1.05,
    sweep: 1.3,
    lowpassHz: 2600,
    body: 0.18,
    gain: 0.72,
  },
  // Flat and even, two strokes at almost the same height: a notice being
  // pinned to the board, deliberately without urgency in either
  // direction -- a proposal is neither good nor bad news.
  governance: {
    centers: [520, 560],
    strokeMs: 120,
    gapMs: 45,
    q: 0.95,
    sweep: 1.2,
    lowpassHz: 2300,
    body: 0.22,
    gain: 0.64,
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
    body: 0.18,
    gain: 0.52,
  },
  // 71-1, the call roster. Four sounds that come in two mirrored pairs:
  // the room's own arrivals and departures, told apart by direction, and
  // yours told apart from everyone else's by size.
  //
  // Stepping into the room: two warm strokes rising, with more mass behind
  // them than anything here that isn't the eraser. This is the only one of
  // the four that happens *to* you rather than around you, so it is the
  // biggest.
  call_join: {
    centers: [360, 560],
    strokeMs: 110,
    gapMs: 40,
    q: 1,
    sweep: 1.45,
    lowpassHz: 2200,
    body: 0.3,
    gain: 0.7,
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
    body: 0.3,
    gain: 0.66,
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
    body: 0.12,
    gain: 0.5,
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
    body: 0.14,
    gain: 0.48,
  },
  // The board is back.
  connect: {
    centers: [440, 600],
    strokeMs: 100,
    gapMs: 35,
    q: 1,
    sweep: 1.4,
    lowpassHz: 2400,
    body: 0.22,
    gain: 0.66,
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
    body: 0.38,
    gain: 0.66,
  },
  // Barely there. You asked for confirmation, not for an announcement.
  send_confirm: {
    centers: [950],
    strokeMs: 60,
    gapMs: 0,
    q: 1.2,
    sweep: 1.3,
    lowpassHz: 2900,
    body: 0.09,
    gain: 0.36,
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
    body: 0.36,
    gain: 0.75,
  },
};

// A second of white noise, generated once and reused. AudioBufferSource
// nodes are single-use; the buffer behind them is not.
function makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const frames = Math.floor(ctx.sampleRate);
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

// SoundPlayer owns the AudioContext. It is created lazily -- an app that
// never makes a sound should never open an audio device -- and stays
// suspended until unlock() runs inside a user gesture.
export class SoundPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private volume: number;
  /** "" = the system default output. See setOutput. */
  private outputId = "";

  constructor(volume: number) {
    this.volume = volume;
  }

  get unlocked(): boolean {
    return this.ctx !== null && this.ctx.state === "running";
  }

  setVolume(volume: number): void {
    this.volume = volume;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.01);
    }
  }

  /**
   * setOutput routes the sounds to the chosen output device (44-9), so they
   * follow the same speakers as the call rather than always the system default.
   *
   * AudioContext.setSinkId is newer and narrower than the element-level one --
   * Chromium only, and not in every version that has the element form. The
   * remembered id is applied again on unlock(), since the context that is
   * supposed to carry it may not exist yet when the setting is changed.
   */
  setOutput(outputId: string): void {
    this.outputId = outputId;
    void this.applyOutput();
  }

  private async applyOutput(): Promise<void> {
    const ctx = this.ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!ctx?.setSinkId) return;
    try {
      await ctx.setSinkId(this.outputId);
    } catch {
      /* Unplugged, or not permitted. The sounds stay on the previous device. */
    }
  }

  // Must be called from a user gesture: browsers start every AudioContext
  // suspended, and resume() only resolves inside one. Safe to call again.
  async unlock(): Promise<void> {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this.noise = makeNoiseBuffer(this.ctx);
      void this.applyOutput();
    }
    if (this.ctx.state !== "running") {
      try {
        await this.ctx.resume();
      } catch {
        // Not a gesture after all, or the device is busy. The gate keeps
        // returning "locked" and the next gesture tries again.
      }
    }
  }

  play(category: SoundCategory): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise || ctx.state !== "running") return;

    const spec = SOUND_SPECS[category];
    let at = ctx.currentTime;
    for (const center of spec.centers) {
      this.stroke(ctx, master, noise, spec, center, at);
      at += (spec.strokeMs + spec.gapMs) / 1000;
    }
  }

  // One stroke: noise through a wide bandpass that travels while it
  // sounds, plus a quieter octave-down band for mass, sharing one
  // envelope.
  private stroke(
    ctx: AudioContext,
    master: GainNode,
    noise: AudioBuffer,
    spec: StrokeSpec,
    center: number,
    at: number,
  ): void {
    const dur = spec.strokeMs / 1000;
    const attack = ATTACK_MS / 1000;
    const release = RELEASE_MS / 1000;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(spec.gain, at + attack);
    // The drag: hold, then lift. Linear rather than exponential because
    // exponentialRampToValueAtTime cannot reach zero, and a lifted piece
    // of chalk goes properly silent.
    env.gain.setValueAtTime(spec.gain, at + dur);
    env.gain.linearRampToValueAtTime(0, at + dur + release);
    env.connect(master);

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = spec.lowpassHz;
    lp.connect(env);

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = HIGHPASS_HZ;
    hp.connect(lp);

    // The swish. Exponential rather than linear because pitch is
    // logarithmic: a linear ramp spends most of its time at the top and
    // arrives with a lurch.
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = spec.q;
    band.frequency.setValueAtTime(center, at);
    band.frequency.exponentialRampToValueAtTime(center * spec.sweep, at + dur + release);
    band.connect(hp);

    const src = ctx.createBufferSource();
    src.buffer = noise;
    // Start somewhere random in the buffer so repeats of the same
    // category aren't bit-identical -- real chalk never is.
    const offset = Math.random() * Math.max(0, noise.duration - dur - release);
    src.connect(band);
    src.start(at, offset, dur + release);
    src.stop(at + dur + release);

    if (spec.body > 0) {
      // Follows the sweep an octave down, so the mass travels with the
      // stroke instead of sitting still underneath it.
      const bodyBand = ctx.createBiquadFilter();
      bodyBand.type = "bandpass";
      bodyBand.Q.value = 0.6;
      bodyBand.frequency.setValueAtTime(center / 2, at);
      bodyBand.frequency.exponentialRampToValueAtTime(
        (center / 2) * spec.sweep,
        at + dur + release,
      );
      const bodyGain = ctx.createGain();
      bodyGain.gain.value = spec.body;
      bodyBand.connect(bodyGain);
      // Through the lowpass, not straight to the envelope: a band this
      // wide has gentle skirts, so an octave-down layer still passes real
      // high-frequency energy. Left unfiltered it would sneak the screech
      // back in behind the ceiling the rest of the stroke respects.
      bodyGain.connect(lp);
      const bodySrc = ctx.createBufferSource();
      bodySrc.buffer = noise;
      bodySrc.connect(bodyBand);
      bodySrc.start(at, offset, dur + release);
      bodySrc.stop(at + dur + release);
    }
  }

  close(): void {
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
      this.master = null;
      this.noise = null;
    }
  }
}
