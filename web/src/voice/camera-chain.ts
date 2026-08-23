// chalk-web -- the send-side camera graph (44-10).
//
// The mirror of MicChain, built for the same reason: the camera track went
// from getUserMedia straight into pc.addTrack, which left no seam to put
// anything in. The graph is that seam:
//
//   raw camera track -> <video> -> canvas draw -> captureStream -> published
//
// The property that matters is the one MicChain gets from its destination
// node: the PUBLISHED track belongs to the canvas, so its identity never
// changes. The camera underneath can be swapped -- a different device, a
// different constraint set -- with no replaceTrack on any peer connection and
// no renegotiation. That is what makes a mid-call camera change free, and it
// is the seam the background effects need: the draw step is where they go.
//
// Nothing here weakens E2E: this is all pre-SRTP, on the device.

import { cameraConstraints, type DevicePrefs } from "./device-prefs";
import { applyNativeBlur } from "./camera-effects";

/** Pump rate when the source will not say what it runs at. */
const DEFAULT_FPS = 30;

/**
 * Pump ceiling. Nothing in a call benefits from more, and the draw is real
 * work on every tick -- a 120 fps camera would spend CPU producing frames the
 * encoder's bitrate ceiling then throws away.
 */
const MAX_FPS = 60;

/** Canvas size before the first frame's metadata arrives. 16:9, cheap. */
const FALLBACK_SIZE = { width: 640, height: 360 };

export interface FrameSize {
  width: number;
  height: number;
}

/**
 * 52-1: what goes IN the draw step.
 *
 * A processor paints the frame that gets published, given the live camera
 * element. Async because segmentation is: a mask costs milliseconds, and a
 * synchronous contract would either lie about that or force the work onto the
 * pump's tick.
 *
 * The contract the chain guarantees in return:
 *   - never re-entered: a tick that arrives while the previous render is still
 *     in flight is DROPPED, not queued. Under load the far end sees a lower
 *     frame rate, which is what a video call should do, rather than latency
 *     that grows without bound.
 *   - a throw is survivable: the chain draws the plain frame for that tick, and
 *     drops the processor entirely once it has failed repeatedly. A broken
 *     effect must never cost someone their camera.
 */
export interface FrameProcessor {
  /**
   * budgetMs is the time between pump ticks -- how long this render has before
   * it is costing frames rather than spending them. Passed in because only the
   * chain knows the rate it is pumping at (it follows the camera's own), and a
   * processor that adapts (52-3) has to measure itself against the real one,
   * not against an assumed 30 fps.
   */
  render(
    ctx: CanvasRenderingContext2D,
    source: HTMLVideoElement,
    size: FrameSize,
    budgetMs: number,
  ): void | Promise<void>;
  /** Called when the chain gives up on this processor. Report it here. */
  onDropped?(err: unknown): void;
  close(): void;
}

/**
 * Consecutive render failures tolerated before the processor is dropped.
 *
 * Not one: a single failed frame is routine (a GPU context lost on a laptop
 * lid, a first call racing the model's warm-up), and tearing an effect down
 * for it would make blur flicker off under exactly the conditions it works
 * hardest. Not many either -- a processor failing every frame is producing
 * nothing but a plain picture with the CPU cost of an effect.
 */
export const MAX_PROCESSOR_FAILURES = 5;

/** frameIntervalMs turns a target frame rate into a pump period, in ms. */
export function frameIntervalMs(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) fps = DEFAULT_FPS;
  return Math.max(1, Math.round(1000 / fps));
}

/**
 * sourceFrameRate reads the rate to pump at out of the camera's own settings.
 *
 * Following the source rather than pinning 30 is what keeps this graph
 * invisible: a 60 fps camera published 60 fps before the canvas sat in the
 * middle, and halving it would be a quality change nobody asked for. Cameras
 * that decline to report a rate get the default; absurd rates get the ceiling.
 */
export function sourceFrameRate(settingsFrameRate: number | undefined): number {
  if (typeof settingsFrameRate !== "number" || !Number.isFinite(settingsFrameRate)) {
    return DEFAULT_FPS;
  }
  if (settingsFrameRate <= 0) return DEFAULT_FPS;
  return Math.min(settingsFrameRate, MAX_FPS);
}

/**
 * drawSize picks the canvas dimensions for the frame about to be drawn.
 *
 * The source dimensions are 0 until the video element has metadata, and they
 * change mid-call whenever the camera renegotiates its own resolution (which
 * the adaptive ladder makes routine). Keeping the previous size while the
 * source reads 0 is what stops a 0x0 canvas from being published as the
 * track's dimensions during the first few ticks after a join or a swap.
 */
export function drawSize(current: FrameSize, videoWidth: number, videoHeight: number): FrameSize {
  if (videoWidth > 0 && videoHeight > 0) return { width: videoWidth, height: videoHeight };
  if (current.width > 0 && current.height > 0) return current;
  return { ...FALLBACK_SIZE };
}

export class CameraChain {
  private readonly video: HTMLVideoElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** The canvas capture. Its single track is what every peer connection sees. */
  private readonly out: MediaStream;
  private readonly intervalMs: number;
  /** The live getUserMedia stream. Held so it is not garbage-collected. */
  private raw: MediaStream;
  private timer: number | null = null;
  private active = true;
  private closed = false;
  /** 103-2: the raw device is stopped while the published track lives on. */
  private released = false;
  /** 52-1: the effect in the draw step, if any. */
  private processor: FrameProcessor | null = null;
  /** True between a render starting and settling; the next tick is dropped. */
  private rendering = false;
  private failures = 0;
  /**
   * Desired background blur, held here rather than derived from the track:
   * a recapture hands us a fresh device that starts with the platform's
   * default, so the wish has to outlive the track it was applied to.
   */
  private blur = false;

  private constructor(raw: MediaStream, fps: number) {
    this.raw = raw;
    this.intervalMs = frameIntervalMs(fps);

    this.video = document.createElement("video");
    // muted is what makes the element autoplay-eligible; playsInline stops
    // iOS Safari from throwing the frames into its fullscreen player.
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = raw;

    this.canvas = document.createElement("canvas");
    this.canvas.width = FALLBACK_SIZE.width;
    this.canvas.height = FALLBACK_SIZE.height;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("camera graph: no 2d canvas context");
    this.ctx = ctx;

    this.out = this.canvas.captureStream(fps);
    if (!this.out.getVideoTracks()[0]) throw new Error("camera graph: canvas capture is empty");

    // Not awaited: play() resolves only once frames are flowing, and a camera
    // that is slow to start would hold up the join behind it. The pump copes
    // with an element that has no frame yet -- drawSize keeps the last size,
    // and drawImage on a video below HAVE_CURRENT_DATA is a defined no-op.
    // The pump also re-arms play() if it was refused, because a paused
    // element hands out its last decoded frame forever: the failure mode is
    // a frozen picture at the far end, which is worth self-healing from.
    this.play();
    this.startPump();
  }

  /**
   * fromStream wraps an already-captured camera. Takes ownership: close()
   * stops these tracks, so pass a stream holding only the video you want the
   * chain to own (a combined audio+video capture must be split first).
   *
   * Separate from open() for the same reason MicChain is: a call captures the
   * mic and camera in ONE getUserMedia, because splitting them would mean two
   * permission prompts on a user's first ever join.
   */
  static fromStream(raw: MediaStream, fps?: number): CameraChain {
    return new CameraChain(
      raw,
      fps ?? sourceFrameRate(raw.getVideoTracks()[0]?.getSettings().frameRate),
    );
  }

  /**
   * open captures the camera itself, for callers that have no stream in hand
   * (the mid-call camera add). Throws whatever getUserMedia threw, so callers
   * can apply their own error phrasing.
   */
  static async open(prefs: DevicePrefs, fps?: number): Promise<CameraChain> {
    const raw = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(prefs) });
    try {
      return CameraChain.fromStream(raw, fps);
    } catch (err) {
      for (const t of raw.getTracks()) t.stop();
      throw err;
    }
  }

  /** The track to publish. Stable across device and constraint changes. */
  get track(): MediaStreamTrack {
    return this.out.getVideoTracks()[0];
  }

  /**
   * The pump runs on a plain interval, the same choice MicChain's gate makes
   * and for the same reason: a page holding a live getUserMedia and an
   * RTCPeerConnection is exempt from background-tab timer throttling in
   * Chrome and Firefox, which is exactly and only the situation this runs in.
   *
   * requestVideoFrameCallback would pace better against the source, but it is
   * driven by the document's rendering steps, and those stop for a hidden
   * document -- so the tab you switched away from mid-call would freeze on
   * its last frame for everyone watching. A timer that keeps its cadence
   * matters more here than frame-accurate pacing.
   */
  private startPump(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => this.draw(), this.intervalMs);
  }

  private stopPump(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  /** play is idempotent: calling it on an already-playing element is a no-op. */
  private play(): void {
    void this.video.play().catch(() => {
      /* Retried by the pump for as long as the element stays paused. */
    });
  }

  private draw(): void {
    if (this.closed) return;
    if (this.video.paused) this.play();
    const p = this.processor;
    // Dropped, not queued -- see the FrameProcessor contract. This comes BEFORE
    // the resize below, and has to: assigning a canvas dimension clears it, so
    // resizing on a tick we then skip would publish one blank frame, and worse,
    // would pull the canvas out from under a render already drawing into it.
    // Skipping everything leaves the previous picture standing, which is what a
    // dropped frame should look like.
    if (p && this.rendering) return;
    const size = drawSize(
      { width: this.canvas.width, height: this.canvas.height },
      this.video.videoWidth,
      this.video.videoHeight,
    );
    if (size.width !== this.canvas.width || size.height !== this.canvas.height) {
      // Assigning either dimension clears the canvas; the draw below refills
      // it in the same tick, so nothing ever presents the blank frame.
      this.canvas.width = size.width;
      this.canvas.height = size.height;
    }
    if (!p) {
      this.ctx.drawImage(this.video, 0, 0, size.width, size.height);
      return;
    }
    this.rendering = true;
    // Promise.resolve() so a processor that throws SYNCHRONOUSLY lands in the
    // same catch as one that rejects; without it the throw would escape the
    // interval callback and the fallback below would never run.
    void Promise.resolve()
      .then(() => p.render(this.ctx, this.video, size, this.intervalMs))
      .then(() => {
        this.failures = 0;
      })
      .catch((err) => this.onRenderFailed(p, err, size))
      .finally(() => {
        this.rendering = false;
      });
  }

  /**
   * A render failed: show the plain frame for this tick, and give up on the
   * effect if it keeps happening. Publishing an unprocessed frame is a visible
   * degradation -- the room the user meant to hide is briefly there -- but a
   * frozen or black picture is worse, and silently sending nothing is worst.
   */
  private onRenderFailed(p: FrameProcessor, err: unknown, size: FrameSize): void {
    if (this.closed) return;
    this.failures++;
    try {
      this.ctx.drawImage(this.video, 0, 0, size.width, size.height);
    } catch {
      /* The element has no frame yet; the next tick draws one. */
    }
    if (this.failures < MAX_PROCESSOR_FAILURES) return;
    this.processor = null;
    this.failures = 0;
    try {
      p.onDropped?.(err);
    } finally {
      p.close();
    }
  }

  /**
   * setProcessor swaps the effect in the draw step. Passing null returns the
   * graph to a plain copy.
   *
   * Takes ownership: the outgoing processor is closed here, so a caller that
   * wants to keep one must not hand it over. The published track is untouched
   * either way -- turning an effect on mid-call is invisible to every peer,
   * which is the entire point of the canvas sitting in the middle.
   */
  setProcessor(next: FrameProcessor | null): void {
    if (this.closed || this.processor === next) return;
    this.processor?.close();
    this.processor = next;
    this.failures = 0;
  }

  /** Whether an effect is currently installed in the draw step. */
  get hasProcessor(): boolean {
    return this.processor !== null;
  }

  /**
   * setBackgroundBlur records the wish and tries to have the PLATFORM grant it,
   * reporting whether it did. A false return means the camera cannot blur
   * itself here and the caller should install a processor instead (52-2).
   *
   * Idempotent and re-applied on recapture, because a new device arrives with
   * the platform's default rather than with our preference.
   */
  async setBackgroundBlur(on: boolean): Promise<boolean> {
    if (this.closed) return false;
    this.blur = on;
    // 103-2: no device to ask while released; recapture re-applies the wish.
    if (this.released) return true;
    return applyNativeBlur(this.raw.getVideoTracks()[0], on);
  }

  /**
   * setActive gates the RAW camera and parks the pump.
   *
   * The published track is not what this touches -- the caller disables that,
   * which is what makes the far end go black. This is the half that stops the
   * device feeding a canvas nobody is sending, which is pure waste otherwise:
   * a 1080p draw thirty times a second for frames that go nowhere.
   *
   * As with MicChain.setMuted, this alone leaves the device OPEN. The call
   * pairs it with releaseDevice() (103-2) so that "camera off" also puts the
   * indicator light out -- users read the light, not our button.
   */
  setActive(on: boolean): void {
    if (this.closed || this.active === on) return;
    this.active = on;
    for (const t of this.raw.getVideoTracks()) t.enabled = on;
    if (on) {
      this.startPump();
      return;
    }
    this.stopPump();
    // Blank the canvas behind the disabled track. Without this the last frame
    // stays on it, and re-enabling would show that stale frame for one pump
    // period before the first fresh draw lands.
    this.ctx.fillStyle = "#000";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * releaseDevice (103-2) stops the real camera and keeps everything else:
   * the canvas, its published track and the processor stay, so no peer
   * connection notices. recapture() is the way back. Idempotent.
   */
  releaseDevice(): void {
    if (this.closed || this.released) return;
    this.released = true;
    for (const t of this.raw.getTracks()) t.stop();
    this.video.srcObject = null;
  }

  /** Whether the real camera is currently released (103-2). */
  get deviceReleased(): boolean {
    return this.released;
  }

  /**
   * recapture swaps in a new camera without disturbing the published track:
   * capture first, and only tear the old one down once the new one is in
   * hand, so a camera that is gone or busy leaves the user still visible.
   * The rule MicChain.recapture follows, for the same reason.
   */
  async recapture(prefs: DevicePrefs): Promise<void> {
    if (this.closed) return;
    const next = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(prefs) });
    if (this.closed) {
      for (const t of next.getTracks()) t.stop();
      return;
    }
    const old = this.raw;
    this.raw = next;
    this.released = false;
    this.video.srcObject = next;
    this.play();
    // A fresh capture always starts enabled; carry the on/off state across.
    for (const t of next.getVideoTracks()) t.enabled = this.active;
    for (const t of old.getTracks()) t.stop();
    // 52-1: and carry the blur across too. The new device knows nothing about
    // the constraint the old one was holding, so without this a camera swap
    // would quietly un-blur the room.
    if (this.blur) await applyNativeBlur(next.getVideoTracks()[0], true);
  }

  /** close stops the real camera and the published track. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopPump();
    this.processor?.close();
    this.processor = null;
    // The raw tracks are what hold the device -- stopping only the canvas
    // capture would leave the camera (and its indicator light) on.
    for (const t of this.raw.getTracks()) t.stop();
    for (const t of this.out.getTracks()) t.stop();
    this.video.srcObject = null;
  }
}
