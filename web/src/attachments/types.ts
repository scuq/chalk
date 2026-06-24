// chalk att-2 -- attachment domain types (client).
//
// An attachment is a blob the server only ever holds as ciphertext. The
// server-visible descriptor (AttachmentRef) carries sizes, the channel key
// version, and two opaque encrypted blobs: enc_meta (always) and enc_preview
// (image kinds only). Everything sensitive -- the real filename, mime type,
// kind, and dimensions -- lives inside enc_meta and is recovered only after a
// client decrypts it with the channel key.
//
// Three shapes live here:
//   * AttachmentRef       -- the per-message descriptor the feed renders from.
//   * AttachmentMeta      -- the decrypted enc_meta payload ({name,mime,...}).
//   * PendingAttachment   -- a not-yet-sent file held in the composer tray.
//
// The encrypted blobs are kept as base64 strings on the ref (exactly as they
// arrive on the wire, where Go marshals []byte as standard base64) and decoded
// only at decrypt time; this avoids a re-encode round trip and keeps the ref
// JSON-friendly for app state.

/** kind classifies how the feed renders an attachment. */
export type AttachmentKind = "image" | "file";

/**
 * AttachmentRef is the client-side descriptor for one attachment carried with a
 * message. It mirrors proto.AttachmentRefWire but holds the encrypted blobs as
 * decoded-on-demand base64 strings. The heavy full ciphertext is never inlined;
 * it is fetched over GET /api/attachments/{id} when the row needs the full image
 * (or on an explicit file download).
 */
export interface AttachmentRef {
  id: string;
  /** full ciphertext length in bytes (server-visible; not sensitive). */
  byteLen: number;
  /** channel key version the blobs are encrypted under. */
  keyVersion: number;
  /** encrypted {name,mime,kind,size,width?,height?}; base64, server-opaque. */
  encMetaB64: string;
  /** encrypted low-res preview; base64; present for image kinds only. */
  encPreviewB64?: string;
  /** preview ciphertext length (0 when there is no preview). */
  previewLen: number;
}

/**
 * AttachmentMeta is the decrypted enc_meta payload. The server never sees these
 * fields. `kind` is derived from the mime type at send time and pinned here so
 * the renderer doesn't have to re-sniff. width/height are present for images
 * (used to reserve layout space and avoid reflow as the full image swaps in).
 */
export interface AttachmentMeta {
  name: string;
  mime: string;
  kind: AttachmentKind;
  /** plaintext byte size of the original file (pre-encryption). */
  size: number;
  width?: number;
  height?: number;
}

/**
 * PendingAttachment is a file selected in the composer but not yet sent. It
 * holds the raw File plus a stable local id (for tray keys / removal) and an
 * optional object URL for a local thumbnail preview while it sits in the tray.
 * att-2 keeps this minimal; att-3 enriches the tray (drag-drop, paste,
 * per-item progress).
 */
export interface PendingAttachment {
  localID: string;
  file: File;
  kind: AttachmentKind;
  /** object URL for an in-tray thumbnail (image kinds); revoke on removal. */
  previewURL?: string;
}

/** classifyKind maps a mime type to how the feed should render it. */
export function classifyKind(mime: string): AttachmentKind {
  return mime.startsWith("image/") ? "image" : "file";
}

/** humanSize renders a byte count as a short human string (e.g. "1.4 MB"). */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
