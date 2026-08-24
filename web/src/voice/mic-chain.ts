// chalk-web -- the send-side microphone graph (Phase 30 Addendum A3).
//
// Before this existed the mic track went straight from getUserMedia into
// pc.addTrack, which left no seam to put anything in. The graph is that seam:
//
//   raw mic track -> MediaStreamSource -> GainNode -> [suppressor slot]
//                 -> AnalyserNode -> MediaStreamDestination -> published track
//
// Two properties matter, and both come from the destination node rather than
// from any processing we do today:
//
//   1. The PUBLISHED track is the destination's, so its identity never changes.
//      The raw mic underneath can be swapped -- different device, different
//      processing flags -- with no renegotiation and no replaceTrack on any
//      peer connection. Changing your mic mid-call is free.
//   2. The analyser sits after the gain, so the level meter shows what is
//      actually being sent, which is what makes the gain slider calibratable.
//
// The suppressor slot is empty today: prefs.noiseSuppression asks the browser
// for its built-in NS3 as a getUserMedia constraint, which happens upstream of
// this graph entirely. When the vendored RNNoise worklet lands it goes between
// the gain and the analyser, and micConstraints turns NS3 off (Addendum A2 --
// stacked suppressors fight each other and erase sibilants).
//
// Nothing here weakens E2E: this is all pre-SRTP, on the device.

import { gateConfig, micConstraints, type MicPrefs } from "./mic-prefs";
import { resolveMicPrefs } from "./device-resolve";
import { GATE_CLOSED, nextGate, type GateConfig, type GateState } from "./vad";

/** How often the transmit gate re-decides. 20 ms is well under a syllable. */
const GATE_TICK_MS = 20;

/** Gate open/close ramp. Long enough not to click, short enough not to clip. */
const GATE_RAMP_S = 0.008;

export class MicChain {
  private readonly ctx: AudioContext;
  private readonly gainNode: GainNode;
  private readonly analyser: AnalyserNode;
  /** The transmit gate: 1 while open, 0 while closed. */
  private readonly gateNode: GainNode;
  private readonly dest: MediaStreamAudioDestinationNode;
  private readonly samples: Float32Array<ArrayBuffer>;
  /** The live getUserMedia stream. Held so it is not garbage-collected. */
  private raw: MediaStream;
  private source: MediaStreamAudioSourceNode;
  private muted = false;
  private closed = false;

  private cfg: GateConfig;
  private gate: GateState = GATE_CLOSED;
  private keyHeld = false;
  private timer: number | null = null;
  private onGate: ((open: boolean) => void) | null = null;

  private constructor(ctx: AudioContext, raw: MediaStream, prefs: MicPrefs) {
    this.ctx = ctx;
    this.raw = raw;
    this.cfg = gateConfig(prefs);

    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = prefs.gain;

    this.analyser = ctx.createAnalyser();
    // 1024 samples is ~21 ms at 48 kHz: long enough for a stable RMS, short
    // enough that the meter still reacts to a syllable.
    this.analyser.fftSize = 1024;
    this.samples = new Float32Array(this.analyser.fftSize);

    this.gateNode = ctx.createGain();
    // Start open: every mode except VAD wants to transmit immediately, and VAD
    // corrects itself on the first tick 20 ms later. Starting closed would clip
    // the first word of anyone who talks the instant they join.
    this.gateNode.gain.value = 1;
    this.gate = { open: true, holdUntil: 0 };

    this.dest = ctx.createMediaStreamDestination();

    this.source = ctx.createMediaStreamSource(raw);
    this.source.connect(this.gainNode);
    this.gainNode.connect(this.analyser);
    this.analyser.connect(this.gateNode);
    this.gateNode.connect(this.dest);

    this.startGate();
  }

  /**
   * The gate runs on a plain interval rather than in an AudioWorklet.
   *
   * A worklet would be immune to background-tab timer throttling, but it also
   * means shipping the decision logic as a second copy inside a worklet script
   * -- and that logic (vad.ts) is the part worth being able to unit-test. In
   * practice a page holding a live getUserMedia and an RTCPeerConnection is
   * exempt from timer throttling in Chrome and Firefox, so the interval keeps
   * its cadence for exactly as long as a call is up, which is the only time the
   * gate matters. Revisit if the worklet slot gets built for RNNoise anyway.
   */
  private startGate(): void {
    this.timer = window.setInterval(() => {
      const now = performance.now();
      const prev = this.gate;
      const next = nextGate(prev, this.cfg, {
        // Only VAD consults the level, and reading it means an FFT-sized copy
        // out of the analyser 50 times a second. The key-driven modes skip it.
        level: this.cfg.mode === "vad" ? this.level() : 0,
        keyHeld: this.keyHeld,
        now,
      });
      if (next === prev || next.open === prev.open) {
        this.gate = next;
        return;
      }
      this.gate = next;
      this.gateNode.gain.setTargetAtTime(
        next.open ? 1 : 0,
        this.ctx.currentTime,
        GATE_RAMP_S,
      );
      this.onGate?.(next.open);
    }, GATE_TICK_MS);
  }

  /**
   * fromStream wraps an already-captured mic. Takes ownership: close() stops
   * these tracks, so pass a stream holding only the audio you want the chain
   * to own (a combined audio+video capture must be split first).
   *
   * Separate from open() because a call captures the mic and camera in ONE
   * getUserMedia -- splitting them would mean two permission prompts on a
   * user's first ever join.
   */
  static async fromStream(raw: MediaStream, prefs: MicPrefs): Promise<MicChain> {
    const Ctor =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    // Both entry points (joining a call, pressing "test") are user gestures, so
    // this should already be running -- but a context that autostarts suspended
    // would silently publish silence, which is the worst failure available here.
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        /* Publishing still works in most engines; the meter is what suffers. */
      }
    }
    try {
      return new MicChain(ctx, raw, prefs);
    } catch (err) {
      void ctx.close();
      throw err;
    }
  }

  /**
   * open captures the mic itself and builds the graph, for callers that want
   * audio alone (the profile panel's level meter). Throws whatever getUserMedia
   * threw, so callers can apply their own error phrasing.
   */
  static async open(prefs: MicPrefs): Promise<MicChain> {
    // 63-3: a stale saved deviceId re-resolves by label before capture, so a
    // device that changed ids since it was picked is still the one opened.
    const raw = await navigator.mediaDevices.getUserMedia({
      audio: micConstraints(await resolveMicPrefs(prefs)),
    });
    try {
      return await MicChain.fromStream(raw, prefs);
    } catch (err) {
      for (const t of raw.getTracks()) t.stop();
      throw err;
    }
  }

  /** The track to publish. Stable across device and constraint changes. */
  get track(): MediaStreamTrack {
    return this.dest.stream.getAudioTracks()[0];
  }

  /** 63-3: which device the RAW capture is actually on right now, or null
   * when the engine doesn't report one. What devicechange compares against. */
  currentDeviceId(): string | null {
    const t = this.raw.getAudioTracks()[0];
    return t?.getSettings().deviceId ?? null;
  }

  /** setGain applies instantly; no renegotiation, no capture restart. */
  setGain(gain: number): void {
    if (this.closed) return;
    // Ramped rather than assigned: a step change in gain is an audible click
    // at the far end.
    this.gainNode.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02);
  }

  /** setPrefs applies everything that does not need a new capture. */
  setPrefs(prefs: MicPrefs): void {
    if (this.closed) return;
    this.setGain(prefs.gain);
    this.cfg = gateConfig(prefs);
  }

  /** setKeyHeld reports the push-to-talk / push-to-mute key's state. */
  setKeyHeld(held: boolean): void {
    this.keyHeld = held;
  }

  /** Whether the gate is currently passing audio. Drives the "live" indicator. */
  get transmitting(): boolean {
    return this.gate.open && !this.muted;
  }

  /** onGateChange fires on every gate transition. One subscriber; null clears. */
  onGateChange(fn: ((open: boolean) => void) | null): void {
    this.onGate = fn;
  }

  /**
   * setMuted gates the RAW track rather than the published one. Muting the
   * destination track would leave the graph running on live mic audio, so the
   * level meter would keep bouncing while the user believes they are muted.
   *
   * As before this graph existed, the device stays open while muted -- the
   * browser's own mic indicator is the honest signal there, and releasing the
   * device on every mute would make unmuting slow and racy.
   */
  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const t of this.raw.getAudioTracks()) t.enabled = !muted;
  }

  /**
   * level is the current RMS amplitude, 0..1, post-gain but PRE-gate -- what
   * the mic is hearing, not what is being sent. That is what the meter and the
   * threshold sliders need: a meter that dropped to zero the moment the gate
   * closed could never show you where to put the threshold that closed it.
   */
  level(): number {
    if (this.closed) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const s of this.samples) sum += s * s;
    const rms = Math.sqrt(sum / this.samples.length);
    return Math.min(1, rms);
  }

  /**
   * recapture swaps in a new mic without disturbing the published track:
   * capture first, and only tear the old source down once the new one is in
   * hand, so a device that is gone or busy leaves the user still audible.
   */
  async recapture(prefs: MicPrefs): Promise<void> {
    if (this.closed) return;
    // 63-3: same label re-resolution as open() -- see device-resolve.ts.
    const next = await navigator.mediaDevices.getUserMedia({
      audio: micConstraints(await resolveMicPrefs(prefs)),
    });
    if (this.closed) {
      for (const t of next.getTracks()) t.stop();
      return;
    }
    const oldRaw = this.raw;
    this.source.disconnect();
    this.raw = next;
    this.source = this.ctx.createMediaStreamSource(next);
    this.source.connect(this.gainNode);
    // A fresh capture always starts enabled; carry the mute across.
    this.setMuted(this.muted);
    for (const t of oldRaw.getTracks()) t.stop();
  }

  /** close stops the real mic and releases the audio context. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.onGate = null;
    // The raw tracks are what hold the device -- stopping only the published
    // destination track would leave the mic (and its indicator light) on.
    for (const t of this.raw.getTracks()) t.stop();
    for (const t of this.dest.stream.getTracks()) t.stop();
    try {
      await this.ctx.close();
    } catch {
      /* Already closed, or the engine objected. The device is released either way. */
    }
  }
}
