// chalk att-2 -- standard base64 <-> bytes helpers.
//
// Matches Go's base64.StdEncoding, which is what the server uses when it
// marshals a []byte field (enc_meta / enc_preview) to JSON and what it expects
// to decode on the way back in. channel-crypto.ts has equivalent private
// helpers for message bodies; these are the exported attachment-side twins.

/** bytesToBase64 encodes bytes as a standard (StdEncoding) base64 string. */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  // Chunk to avoid blowing the argument limit of String.fromCharCode on
  // multi-MB previews/metas (well within att-2's small base64 payloads, but
  // cheap insurance).
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/** base64ToBytes decodes a standard base64 string to bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
