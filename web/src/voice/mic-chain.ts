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

import { micConstraints, type MicPrefs } from "./mic-prefs";

export class MicChain {
  private readonly ctx: AudioContext;
  private readonly gainNode: GainNode;
  private readonly analyser: AnalyserNode;
  private readonly dest: MediaStreamAudioDestinationNode;
  private readonly samples: Float32Array;
  /** The live getUserMedia stream. Held so it is not garbage-collected. */
  private raw: MediaStream;
  private source: MediaStreamAudioSourceNode;
  private muted = false;
  private closed = false;

  private constructor(ctx: AudioContext, raw: MediaStream, prefs: MicPrefs) {
    this.ctx = ctx;
    this.raw = raw;

    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = prefs.gain;

    this.analyser = ctx.createAnalyser();
    // 1024 samples is ~21 ms at 48 kHz: long enough for a stable RMS, short
    // enough that the meter still reacts to a syllable.
    this.analyser.fftSize = 1024;
    this.samples = new Float32Array(this.analyser.fftSize);

    this.dest = ctx.createMediaStreamDestination();

    this.source = ctx.createMediaStreamSource(raw);
    this.source.connect(this.gainNode);
    this.gainNode.connect(this.analyser);
    this.analyser.connect(this.dest);
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
    const raw = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(prefs) });
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

  /** setGain applies instantly; no renegotiation, no capture restart. */
  setGain(gain: number): void {
    if (this.closed) return;
    // Ramped rather than assigned: a step change in gain is an audible click
    // at the far end.
    this.gainNode.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02);
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

  /** level is the current RMS amplitude, 0..1, post-gain. For the VU meter. */
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
    const next = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(prefs) });
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
