// chalk att-2 -- attachment pipeline (the orchestration seam).
//
// Ties together crypto (channel key), preview (downscale), transport (chunked
// HTTP), and cache (ciphertext IndexedDB). Two directions:
//
//   SEND  (uploadAttachment): downscale -> build meta -> encrypt full + preview
//         + meta under the channel's current key version (all three at the SAME
//         version) -> init -> chunk -> finalize -> cache the full ciphertext
//         locally (the sender never re-downloads their own blob) -> return the
//         AttachmentRef for the optimistic message + the decrypted meta.
//
//   RECV  (AttachmentController): decrypt meta on demand; decrypt the inline
//         preview (no fetch -- it rides in the ref); fetch+cache+decrypt the
//         full blob on demand (cache-first). The renderer turns the returned
//         bytes into object URLs and revokes them.
//
// Fail-closed throughout: if the channel key isn't held, the upload blocks
// ("waiting") and decrypts return null (the renderer shows a locked
// placeholder), exactly like message text.

import type { ChannelCrypto } from "../crypto/channel-crypto";
import type { AttachmentRefWireBase } from "../proto";
import { type AttachmentMeta, type AttachmentRef } from "./types";
import { bytesToBase64, base64ToBytes } from "./base64";
import { asBytes } from "../crypto/bytes";
import { makePreview, buildMeta, encodeMeta, decodeMeta } from "./preview";
import {
  initUpload,
  putChunk,
  finalizeUpload,
  downloadCiphertext,
} from "./transport";
import { cacheGet, cachePut } from "./cache";

/**
 * 83-2: ciphertext digests of one uploaded attachment, computed while the
 * bytes are still in hand. The signed message envelope carries these
 * (AttachmentBinding), tying the signature to the exact blobs uploaded so a
 * stored attachment cannot be substituted under an already-signed message.
 */
export interface UploadBinding {
  ciphertextSha256: Uint8Array; // over the full uploaded ciphertext
  encMetaSha256: Uint8Array | null; // null when no enc_meta (never, today)
  encPreviewSha256: Uint8Array | null; // null when the kind has no preview
}

/** Result of an upload attempt: the ref (+meta) to render, or blocked on key. */
export type UploadResult =
  | { kind: "uploaded"; ref: AttachmentRef; meta: AttachmentMeta; binding: UploadBinding }
  | { kind: "waiting" };

export interface UploadOptions {
  /** preview longest-edge px; defaults to the preview module's default (320). */
  previewMaxEdge?: number;
  /** att-3: per-attachment upload progress, called as ciphertext chunks land.
   *  loaded/total are CIPHERTEXT bytes; total is known up front (we encrypt the
   *  whole blob before chunking). Fires once at 0 and once at total. */
  onProgress?: (loaded: number, total: number) => void;
}

/**
 * uploadAttachment runs the full SEND pipeline for one file. Returns "waiting"
 * (without uploading anything) if the channel key isn't held -- the caller
 * blocks the whole send, never transmitting plaintext. On success the full
 * ciphertext is cached locally so the sender's own optimistic render is instant.
 */
export async function uploadAttachment(
  cc: ChannelCrypto,
  channelID: string,
  deviceID: string,
  file: File,
  opts: UploadOptions = {},
): Promise<UploadResult> {
  // 1. preview (image kinds only) + meta. Dimensions feed meta + layout.
  const preview = await makePreview(file, opts.previewMaxEdge);
  const meta = buildMeta(
    file,
    preview ? { width: preview.width, height: preview.height } : undefined,
  );
  const metaBytes = encodeMeta(meta);

  // 2. encrypt the full blob first -- this fixes the key version every other
  //    blob of this attachment must use.
  const fullPlain = new Uint8Array(await file.arrayBuffer());
  const encFull = await cc.encryptBytesForChannel(channelID, fullPlain);
  if (encFull.kind !== "encrypted") return { kind: "waiting" };
  const v = encFull.keyVersion;

  // 3. encrypt meta + preview at that SAME version.
  const encMeta = await cc.encryptBytesAtVersion(channelID, v, metaBytes);
  if (!encMeta) return { kind: "waiting" };
  let encPreview: Uint8Array | null = null;
  if (preview) {
    encPreview = await cc.encryptBytesAtVersion(channelID, v, preview.bytes);
  }

  const encMetaB64 = bytesToBase64(encMeta);
  const encPreviewB64 = encPreview ? bytesToBase64(encPreview) : undefined;
  const previewLen = encPreview ? encPreview.byteLength : 0;

  // 4. init -> chunk -> finalize.
  const init = await initUpload({
    channelID,
    deviceID,
    keyVersion: v,
    byteLen: encFull.ciphertext.byteLength,
    encMetaB64,
    encPreviewB64,
    previewLen,
  });
  const chunkBytes = init.chunkBytes > 0 ? init.chunkBytes : 512 * 1024;
  const total = encFull.ciphertext.byteLength;
  opts.onProgress?.(0, total);
  let seq = 0;
  for (let off = 0; off < total; off += chunkBytes) {
    const end = Math.min(off + chunkBytes, total);
    await putChunk(init.attachmentID, seq, encFull.ciphertext.subarray(off, end));
    opts.onProgress?.(end, total);
    seq++;
  }
  await finalizeUpload(init.attachmentID);

  // 5. cache the full ciphertext so the sender doesn't re-fetch their own blob.
  await cachePut(init.attachmentID, v, "full", encFull.ciphertext);

  const ref: AttachmentRef = {
    id: init.attachmentID,
    byteLen: encFull.ciphertext.byteLength,
    keyVersion: v,
    encMetaB64,
    encPreviewB64,
    previewLen,
  };
  // 83-2: digest the exact ciphertexts that went up, for the envelope's
  // attachment binding. Computed last so a failed upload never yields one.
  const binding: UploadBinding = {
    ciphertextSha256: await sha256(encFull.ciphertext),
    encMetaSha256: await sha256(encMeta),
    encPreviewSha256: encPreview ? await sha256(encPreview) : null,
  };
  return { kind: "uploaded", ref, meta, binding };
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", asBytes(bytes)));
}

/** wireRefToRef converts a server AttachmentRefWire into the client ref shape. */
export function wireRefToRef(w: AttachmentRefWireBase): AttachmentRef {
  return {
    id: w.id,
    byteLen: w.byte_len,
    keyVersion: w.key_version,
    encMetaB64: w.enc_meta,
    encPreviewB64: w.enc_preview,
    previewLen: w.preview_len ?? 0,
  };
}

/**
 * AttachmentController is the bound receive-side surface handed to the feed
 * renderer. Each method takes the message's channelID (the ref doesn't carry
 * it) plus the ref. Built once per ChannelCrypto instance (makeAttachmentController).
 */
export interface AttachmentController {
  /** decrypt enc_meta -> {name,mime,kind,...}, or null if the key isn't held. */
  decryptMeta(channelID: string, ref: AttachmentRef): Promise<AttachmentMeta | null>;
  /** decrypt the inline preview (no network) -> bytes, or null. */
  loadPreviewBytes(channelID: string, ref: AttachmentRef): Promise<Uint8Array | null>;
  /** fetch (cache-first) + decrypt the full blob -> bytes, or null. */
  loadFullBytes(channelID: string, ref: AttachmentRef): Promise<Uint8Array | null>;
  /** fetch + decrypt the full blob and trigger a browser download with the
   *  real filename from enc_meta. No-op if the key isn't held. */
  download(channelID: string, ref: AttachmentRef): Promise<void>;
}

/** makeAttachmentController binds the receive-side pipeline to a crypto instance. */
export function makeAttachmentController(cc: ChannelCrypto): AttachmentController {
  return {
    async decryptMeta(channelID, ref) {
      const ct = safeDecode(ref.encMetaB64);
      if (!ct) return null;
      const pt = await cc.decryptBytesForChannel(channelID, ref.keyVersion, ct);
      return pt ? decodeMeta(pt) : null;
    },

    async loadPreviewBytes(channelID, ref) {
      if (!ref.encPreviewB64) return null;
      const ct = safeDecode(ref.encPreviewB64);
      if (!ct) return null;
      return cc.decryptBytesForChannel(channelID, ref.keyVersion, ct);
    },

    async loadFullBytes(channelID, ref) {
      let ct = await cacheGet(ref.id, ref.keyVersion, "full");
      if (!ct) {
        ct = await downloadCiphertext(ref.id);
        await cachePut(ref.id, ref.keyVersion, "full", ct);
      }
      return cc.decryptBytesForChannel(channelID, ref.keyVersion, ct);
    },

    async download(channelID, ref) {
      const [bytes, meta] = await Promise.all([
        this.loadFullBytes(channelID, ref),
        this.decryptMeta(channelID, ref),
      ]);
      if (!bytes) return; // fail-closed: never offer undecryptable bytes
      saveBytesToDisk(bytes, meta?.name ?? "attachment", meta?.mime ?? "application/octet-stream");
    },
  };
}

function safeDecode(b64: string): Uint8Array | null {
  try {
    return base64ToBytes(b64);
  } catch {
    return null;
  }
}

/** saveBytesToDisk triggers a browser "save as" for decrypted bytes. */
function saveBytesToDisk(bytes: Uint8Array, filename: string, mime: string): void {
  const blob = new Blob([asBytes(bytes)], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click has had a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
