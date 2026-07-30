// chalk-web -- background blur as a frame processor (52-2).
//
// The half of 52-1 that does the work when the platform won't: a segmentation
// mask per frame, and a composite that keeps the person sharp over a blurred
// copy of their room.
//
//   video -> segmenter -> mask (person vs not)
//   video -> blurred copy                        } composited by the mask
//   video -> sharp copy, masked to the person    }
//
// EVERYTHING IS LOCAL. The model is served by this chalk, runs in this browser
// on this device's frames, and answers one question per pixel. No frame, mask
// or inference leaves the machine -- this sits in the camera graph, which is
// upstream of encryption, let alone of the network.
//
// LOADED ON DEMAND. The MediaPipe runtime is ~12 MB of WASM: an import() keeps
// it out of the initial bundle and off the wire entirely for the people who
// never turn blur on. First enable pays the download; the browser caches it
// under an immutable URL after that (see build.mjs).
//
// CANVAS 2D, NOT WEBGL. The composite is three draws and a mask; a shader
// pipeline would be faster but is a lot of machinery to own for an effect that
// is already gated behind the segmenter's cost. The mask is upscaled with
// smoothing on, which feathers its edges for free -- a binary mask drawn
// hard-edged looks cut out with scissors.

import type { FrameProcessor, FrameSize } from "./camera-chain";
import { canvasFilterSupported } from "./camera-effects";

// Injected by build.mjs (esbuild define). Declared as possibly-undefined and
// read through a typeof guard so the module still imports under the test
// runner, which transpiles without the define.
declare const __MEDIAPIPE_BASE__: string | undefined;

export function mediapipeBasePath(): string {
  return typeof __MEDIAPIPE_BASE__ === "string" ? __MEDIAPIPE_BASE__ : "/mediapipe";
}

/**
 * Blur strength, in canvas filter pixels at 720p.
 *
 * Scaled by frame height rather than fixed: a fixed radius that reads as "my
 * room is unrecognisable" at 360p is a faint haze at 1080p, and the adaptive
 * ladder (30-8) changes the resolution under us mid-call.
 */
const BLUR_PX_AT_720 = 14;

/** blurRadius picks the filter radius for a frame of this height. */
export function blurRadius(height: number): number {
  if (!Number.isFinite(height) || height <= 0) return BLUR_PX_AT_720;
  return Math.max(4, Math.round((height / 720) * BLUR_PX_AT_720));
}

/**
 * maskThreshold is where a confidence mask stops being background.
 *
 * Deliberately below the midpoint: the cost of the two mistakes is not
 * symmetric. Blurring part of a person is a visible artefact on them; leaving
 * part of the room sharp is the failure the feature exists to prevent. Erring
 * towards "this is a person" keeps hair and shoulders intact, and the feather
 * from the upscale hides the rest.
 */
export const MASK_THRESHOLD = 0.4;

/**
 * maskToAlpha turns one confidence mask into RGBA bytes for a canvas.
 *
 * The mask is the segmenter's confidence that a pixel is the FOREGROUND, so
 * alpha is what we want out of it: opaque where the person is, transparent
 * where the room is. Colour channels are left at zero -- the alpha is all the
 * composite reads.
 *
 * Exported because it is the one piece of this file that is pure arithmetic
 * over a buffer, which is exactly the piece worth testing away from a GPU.
 */
export function maskToAlpha(mask: Float32Array, out: Uint8ClampedArray): void {
  for (let i = 0; i < mask.length; i++) {
    out[i * 4 + 3] = mask[i] >= MASK_THRESHOLD ? 255 : 0;
  }
}

/** The subset of MediaPipe we use, so the import stays a type-only concern. */
type Segmenter = {
  segmentForVideo(
    frame: HTMLVideoElement,
    timestampMs: number,
  ): { confidenceMasks?: { getAsFloat32Array(): Float32Array; width: number; height: number }[]; close(): void };
  close(): void;
};

/**
 * loadSegmenter pulls in the runtime and builds the model.
 *
 * GPU delegate: inference on the graphics card keeps a core free for the
 * encoder, which is competing for the same machine. It falls back to CPU
 * inside MediaPipe on hardware without it.
 */
async function loadSegmenter(): Promise<Segmenter> {
  const base = mediapipeBasePath();
  const vision = await import("@mediapipe/tasks-vision");
  const fileset = await vision.FilesetResolver.forVisionTasks(base);
  const segmenter = await vision.ImageSegmenter.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: `${base}/selfie_segmenter.tflite`,
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  });
  return segmenter as unknown as Segmenter;
}

export class BlurProcessor implements FrameProcessor {
  private readonly segmenter: Segmenter;
  /** Scratch surfaces, reused: allocating three canvases per frame is how a
   *  30 fps effect turns into a garbage-collection stutter. */
  private readonly maskCanvas: HTMLCanvasElement;
  private readonly maskCtx: CanvasRenderingContext2D;
  private readonly personCanvas: HTMLCanvasElement;
  private readonly personCtx: CanvasRenderingContext2D;
  private readonly smallCanvas: HTMLCanvasElement;
  private readonly smallCtx: CanvasRenderingContext2D;
  private maskPixels: ImageData | null = null;
  private closed = false;
  private readonly report: (err: unknown) => void;

  private constructor(segmenter: Segmenter, report: (err: unknown) => void) {
    this.segmenter = segmenter;
    this.report = report;
    this.maskCanvas = document.createElement("canvas");
    this.personCanvas = document.createElement("canvas");
    this.smallCanvas = document.createElement("canvas");
    const mctx = this.maskCanvas.getContext("2d");
    const pctx = this.personCanvas.getContext("2d");
    const sctx = this.smallCanvas.getContext("2d");
    if (!mctx || !pctx || !sctx) throw new Error("background blur: no 2d canvas context");
    this.maskCtx = mctx;
    this.personCtx = pctx;
    this.smallCtx = sctx;
  }

  /**
   * create loads the runtime and returns a ready processor, or throws.
   *
   * The throw is the caller's signal that blur is not available here -- an old
   * browser, a blocked fetch, a machine that cannot build the GPU context --
   * and the honest response is to leave the camera unprocessed and say so,
   * never to publish a frozen or half-drawn picture.
   */
  static async create(report: (err: unknown) => void): Promise<BlurProcessor> {
    return new BlurProcessor(await loadSegmenter(), report);
  }

  render(ctx: CanvasRenderingContext2D, source: HTMLVideoElement, size: FrameSize): void {
    if (this.closed) return;
    // performance.now() rather than a frame counter: MediaPipe rejects a
    // timestamp that does not advance, and wall-clock is what "video mode"
    // expects for its internal frame pacing.
    const result = this.segmenter.segmentForVideo(source, performance.now());
    try {
      const mask = result.confidenceMasks?.[0];
      if (!mask) throw new Error("background blur: segmenter returned no mask");
      this.paint(ctx, source, size, mask);
    } finally {
      result.close();
    }
  }

  private paint(
    ctx: CanvasRenderingContext2D,
    source: HTMLVideoElement,
    size: FrameSize,
    mask: { getAsFloat32Array(): Float32Array; width: number; height: number },
  ): void {
    // 1. The mask, at ITS resolution (256x256 for this model). Upscaling
    //    happens in the draw below, where the browser's bilinear filter
    //    feathers the edge for nothing.
    if (
      this.maskCanvas.width !== mask.width ||
      this.maskCanvas.height !== mask.height ||
      !this.maskPixels
    ) {
      this.maskCanvas.width = mask.width;
      this.maskCanvas.height = mask.height;
      this.maskPixels = this.maskCtx.createImageData(mask.width, mask.height);
    }
    maskToAlpha(mask.getAsFloat32Array(), this.maskPixels.data);
    this.maskCtx.putImageData(this.maskPixels, 0, 0);

    // 2. The person, cut out of a sharp copy. destination-in keeps only what
    //    the mask's alpha covers.
    if (this.personCanvas.width !== size.width || this.personCanvas.height !== size.height) {
      this.personCanvas.width = size.width;
      this.personCanvas.height = size.height;
    }
    this.personCtx.globalCompositeOperation = "copy";
    this.personCtx.imageSmoothingEnabled = true;
    this.personCtx.drawImage(source, 0, 0, size.width, size.height);
    this.personCtx.globalCompositeOperation = "destination-in";
    this.personCtx.drawImage(this.maskCanvas, 0, 0, size.width, size.height);
    this.personCtx.globalCompositeOperation = "source-over";

    // 3. The room, blurred, with the person laid back over it.
    this.drawBlurred(ctx, source, size);
    ctx.drawImage(this.personCanvas, 0, 0, size.width, size.height);
  }

  /**
   * drawBlurred fills the target with an unrecognisable copy of the frame.
   *
   * Two implementations, and the fallback is not optional. A canvas whose 2D
   * context ignores `filter` accepts the assignment and silently does nothing
   * -- which would publish a SHARP room to everyone in the call while the user
   * believes it is hidden. That is the one failure this feature must never
   * have, so where the filter does not take, the frame goes through a
   * deliberate downscale and back up: cruder than a gaussian, but it destroys
   * the detail, which is the whole job.
   */
  private drawBlurred(
    ctx: CanvasRenderingContext2D,
    source: HTMLVideoElement,
    size: FrameSize,
  ): void {
    const radius = blurRadius(size.height);
    if (canvasFilterSupported()) {
      ctx.save();
      ctx.filter = `blur(${radius}px)`;
      ctx.drawImage(source, 0, 0, size.width, size.height);
      ctx.restore();
      return;
    }
    const w = Math.max(1, Math.round(size.width / radius));
    const h = Math.max(1, Math.round(size.height / radius));
    if (this.smallCanvas.width !== w || this.smallCanvas.height !== h) {
      this.smallCanvas.width = w;
      this.smallCanvas.height = h;
    }
    this.smallCtx.globalCompositeOperation = "copy";
    this.smallCtx.drawImage(source, 0, 0, w, h);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.smallCanvas, 0, 0, size.width, size.height);
    ctx.restore();
  }

  onDropped(err: unknown): void {
    this.report(err);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Frees the WASM heap the model is holding. Skipping it leaks tens of MB
    // per call for anyone who toggles blur more than once a session.
    try {
      this.segmenter.close();
    } catch {
      /* Already torn down by a lost GPU context; nothing left to free. */
    }
  }
}
