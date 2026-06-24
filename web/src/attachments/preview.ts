// chalk att-2 -- client-side preview generation + meta packaging.
//
// The privacy constraint (spec S3): the server only ever holds ciphertext, so a
// low-res preview must be generated CLIENT-SIDE before encryption. The server
// cannot downscale. On send, for an image kind we:
//   1. downscale to a small preview (<= CHALK_ATTACH_PREVIEW_MAX_EDGE px longest
//      edge, low-quality), a few KB;
//   2. encrypt BOTH the preview and the full image independently (pipeline.ts).
//
// Non-image kinds have no preview (the feed shows a file row instead).
//
// This module is pure browser DOM (canvas / createImageBitmap); it has no test
// in the node harness (jsdom/canvas isn't wired). Its callers in pipeline.ts are
// exercised by the round-trip tests with a stubbed preview.

import { type AttachmentMeta, classifyKind } from "./types";

/** Default preview longest-edge in px; mirrors CHALK_ATTACH_PREVIEW_MAX_EDGE. */
const DEFAULT_PREVIEW_MAX_EDGE = 320;

/** Preview encodes as JPEG at this quality -- small, good enough for a thumb. */
const PREVIEW_QUALITY = 0.6;
const PREVIEW_MIME = "image/jpeg";

export interface PreviewResult {
  bytes: Uint8Array; // encoded preview image (JPEG)
  mime: string; // PREVIEW_MIME
  /** natural dimensions of the ORIGINAL image (for meta + layout). */
  width: number;
  height: number;
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

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, PREVIEW_MIME, PREVIEW_QUALITY),
  );
  if (!blob) return null;
  const buf = await blob.arrayBuffer();
  return { bytes: new Uint8Array(buf), mime: PREVIEW_MIME, width: nw, height: nh };
}

/**
 * buildMeta assembles the (to-be-encrypted) AttachmentMeta for a file. The
 * real filename + mime live ONLY here, inside what becomes enc_meta, never in a
 * server column. width/height come from the preview step for images.
 */
export function buildMeta(
  file: File,
  dims?: { width: number; height: number },
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
    const kind = obj.kind === "image" || obj.kind === "file" ? obj.kind : classifyKind(obj.mime);
    const meta: AttachmentMeta = {
      name: obj.name,
      mime: obj.mime,
      kind,
      size: typeof obj.size === "number" ? obj.size : 0,
    };
    if (typeof obj.width === "number") meta.width = obj.width;
    if (typeof obj.height === "number") meta.height = obj.height;
    return meta;
  } catch {
    return null;
  }
}
