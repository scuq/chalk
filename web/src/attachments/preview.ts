// chalk att-2 -- client-side preview generation + meta packaging.
//
// The privacy constraint (spec S3): the server only ever holds ciphertext, so a
// low-res preview must be generated CLIENT-SIDE before encryption. The server
// cannot downscale. On send, for an image kind we:
//   1. downscale to a small preview (<= CHALK_ATTACH_PREVIEW_MAX_EDGE px longest
//      edge, low-quality), a few KB;
//   2. encrypt BOTH the preview and the full image independently (pipeline.ts).
//
// 121-1: a video gets one too -- a poster frame. The same constraint applies
// with more force: the server holds an opaque blob and could not decode a
// frame if it wanted to, so the sender's browser seeks a little way into the
// file, draws that frame to a canvas and encodes it exactly like an image
// preview. Its duration rides along into enc_meta for the badge on the
// poster. A codec the sender's browser cannot decode yields no poster and the
// message falls back to the file row, as before.
//
// Every other kind has no preview (the feed shows a file row instead).
//
// This module is mostly browser DOM (canvas / createImageBitmap / <video>); the
// DOM parts have no test in the node harness (jsdom/canvas isn't wired). Their
// callers in pipeline.ts are exercised by the round-trip tests with a stubbed
// preview; the pure pieces (posterSeekTime, meta codec) are tested directly.

import { type AttachmentMeta, classifyKind } from "./types";

/** Default preview longest-edge in px; mirrors CHALK_ATTACH_PREVIEW_MAX_EDGE. */
const DEFAULT_PREVIEW_MAX_EDGE = 320;

/** Preview encodes as JPEG at this quality -- small, good enough for a thumb. */
const PREVIEW_QUALITY = 0.6;
const PREVIEW_MIME = "image/jpeg";

/** 121-1: a poster frame is drawn no later than this far in, in seconds. */
const POSTER_SEEK_MAX_S = 1;

/** 121-1: give up on a video the browser will not decode after this long. */
const POSTER_TIMEOUT_MS = 8000;

/** 121-1: a blank read is retried this many times, this far apart. */
const POSTER_BLANK_RETRIES = 8;
const POSTER_BLANK_RETRY_MS = 150;

export interface PreviewResult {
  bytes: Uint8Array; // encoded preview image (JPEG)
  mime: string; // PREVIEW_MIME
  /** natural dimensions of the ORIGINAL image or video frame (meta + layout). */
  width: number;
  height: number;
  /** 121-1: video kinds only -- the file's length in seconds. */
  duration?: number;
}

/**
 * 121-1: posterSeekTime picks where in a video the poster frame is taken.
 * The very first frame is often black or a fade-in, so seek a second in --
 * but never past the middle of a clip shorter than two seconds, and to 0 for
 * a duration the browser could not read (NaN or Infinity, which some
 * fragmented files report).
 */
export function posterSeekTime(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(POSTER_SEEK_MAX_S, duration / 2);
}

/**
 * makePreview downscales an image File to a small JPEG preview and returns the
 * encoded bytes plus the ORIGINAL image's natural dimensions. Returns null when
 * the file isn't an image or the browser can't decode it (caller proceeds with
 * no preview -> file-row render). maxEdge bounds the longest side; the aspect
 * ratio is preserved and images already smaller than maxEdge are re-encoded at
 * their natural size (still cheap, normalizes the format).
 */
export async function makePreview(
  file: File,
  maxEdge: number = DEFAULT_PREVIEW_MAX_EDGE,
): Promise<PreviewResult | null> {
  if (file.type.startsWith("video/")) return makeVideoPoster(file, maxEdge);
  if (!file.type.startsWith("image/")) return null;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null; // undecodable image; render as a file row
  }

  const nw = bitmap.width;
  const nh = bitmap.height;
  if (nw === 0 || nh === 0) {
    bitmap.close?.();
    return null;
  }

  const scale = Math.min(1, maxEdge / Math.max(nw, nh));
  const tw = Math.max(1, Math.round(nw * scale));
  const th = Math.max(1, Math.round(nh * scale));

  const canvas = document.createElement("canvas");
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close?.();
    return null;
  }
  ctx.drawImage(bitmap, 0, 0, tw, th);
  bitmap.close?.();

  const bytes = await encodeCanvas(canvas);
  if (!bytes) return null;
  return { bytes, mime: PREVIEW_MIME, width: nw, height: nh };
}

/** encodeCanvas turns a drawn canvas into preview JPEG bytes, or null. */
async function encodeCanvas(canvas: HTMLCanvasElement): Promise<Uint8Array | null> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, PREVIEW_MIME, PREVIEW_QUALITY),
  );
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * isBlank reports a canvas with nothing on it -- every channel of every pixel
 * under a small floor. The preview canvas is at most 320 px a side, so
 * reading it whole is cheap.
 */
function isBlank(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const d = ctx.getImageData(0, 0, w, h).data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > 8 || d[i + 1] > 8 || d[i + 2] > 8) return false;
  }
  return true;
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/**
 * 121-1: makeVideoPoster draws one frame of a video File to a small JPEG and
 * returns it with the frame's natural size and the file's duration. Returns
 * null when the browser cannot decode the file (an unsupported codec, a
 * container it does not know) or takes too long about it; the caller then
 * sends the video with no preview and it renders as a file row.
 *
 * The decode runs in an offscreen, muted <video> fed by an object URL of the
 * file -- no upload, no network. Muted matters: an unmuted element may not
 * load without a gesture. `seeked` says the seek is done, not that the frame
 * is there to draw: Chromium handed back a black canvas from a read taken
 * right on the event, at random, one file in three. An element that is not
 * in the document never composites, so requestVideoFrameCallback is no
 * signal either. What is reliable is the pixels: draw, and if the canvas is
 * blank, wait a little and draw again, a few times. A clip that really opens
 * on black gets its black frame after the last try, which is what it is.
 */
export async function makeVideoPoster(
  file: File,
  maxEdge: number = DEFAULT_PREVIEW_MAX_EDGE,
): Promise<PreviewResult | null> {
  if (typeof document === "undefined") return null;
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  try {
    const ok = await new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => resolve(false), POSTER_TIMEOUT_MS);
      const done = (v: boolean) => {
        window.clearTimeout(timer);
        resolve(v);
      };
      video.onerror = () => done(false);
      video.onloadedmetadata = () => {
        if (video.videoWidth === 0 || video.videoHeight === 0) {
          done(false); // audio-only, or a container with no decodable track
          return;
        }
        const t = posterSeekTime(video.duration);
        video.onseeked = () => done(true);
        // Setting currentTime to where it already is fires no `seeked`;
        // at 0 the first decoded frame is what loadeddata announces.
        if (t === 0) video.onloadeddata = () => done(true);
        video.currentTime = t;
      };
      video.src = url;
      video.load();
    });
    if (!ok) return null;

    const nw = video.videoWidth;
    const nh = video.videoHeight;
    const scale = Math.min(1, maxEdge / Math.max(nw, nh));
    const tw = Math.max(1, Math.round(nw * scale));
    const th = Math.max(1, Math.round(nh * scale));
    const canvas = document.createElement("canvas");
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    for (let attempt = 0; ; attempt++) {
      try {
        ctx.drawImage(video, 0, 0, tw, th);
      } catch {
        return null; // a frame the engine refuses to hand over (tainted, or none yet)
      }
      if (attempt >= POSTER_BLANK_RETRIES || !isBlank(ctx, tw, th)) break;
      await sleep(POSTER_BLANK_RETRY_MS);
    }
    const bytes = await encodeCanvas(canvas);
    if (!bytes) return null;
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : undefined;
    return { bytes, mime: PREVIEW_MIME, width: nw, height: nh, duration };
  } finally {
    // Detach before revoking so the element stops fetching the blob.
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

/**
 * buildMeta assembles the (to-be-encrypted) AttachmentMeta for a file. The
 * real filename + mime live ONLY here, inside what becomes enc_meta, never in a
 * server column. width/height come from the preview step for images and
 * videos; duration (121-1) from the poster step for videos.
 */
export function buildMeta(
  file: File,
  dims?: { width: number; height: number; duration?: number },
): AttachmentMeta {
  const mime = file.type || "application/octet-stream";
  const meta: AttachmentMeta = {
    name: file.name || "attachment",
    mime,
    kind: classifyKind(mime),
    size: file.size,
  };
  if (dims) {
    meta.width = dims.width;
    meta.height = dims.height;
    if (dims.duration !== undefined) meta.duration = dims.duration;
  }
  return meta;
}

/** encodeMeta serializes AttachmentMeta to UTF-8 bytes for encryption. */
export function encodeMeta(meta: AttachmentMeta): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(meta));
}

/** decodeMeta parses decrypted enc_meta bytes back into AttachmentMeta, or null. */
export function decodeMeta(bytes: Uint8Array): AttachmentMeta | null {
  try {
    const obj = JSON.parse(new TextDecoder().decode(bytes)) as Partial<AttachmentMeta>;
    if (typeof obj.name !== "string" || typeof obj.mime !== "string") return null;
    // 121-1: "video" is a kind a client before it did not know; such a client
    // reaches this same fallback and shows the file row with a download.
    const kind =
      obj.kind === "image" || obj.kind === "video" || obj.kind === "file"
        ? obj.kind
        : classifyKind(obj.mime);
    const meta: AttachmentMeta = {
      name: obj.name,
      mime: obj.mime,
      kind,
      size: typeof obj.size === "number" ? obj.size : 0,
    };
    if (typeof obj.width === "number") meta.width = obj.width;
    if (typeof obj.height === "number") meta.height = obj.height;
    if (typeof obj.duration === "number" && Number.isFinite(obj.duration)) {
      meta.duration = obj.duration;
    }
    return meta;
  } catch {
    return null;
  }
}
