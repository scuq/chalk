// web/src/crypto/stub.ts
//
// Phase 21-1: THROWAWAY passthrough seam. This is NOT encryption.
//
// During the MLS rip-out (phases 21-25), message bodies must flow
// through a stable encrypt/decrypt interface so the app keeps building
// after the MLS code is deleted. This stub implements that interface as
// a plain passthrough: encrypt = utf8->bytes->base64, decrypt =
// base64->bytes->utf8. No keys, no confidentiality.
//
// Phase 23 REPLACES this file with crypto/message.ts (real AES-256-GCM
// under wrapped space keys). Until then, anyone reading the transport or
// the server DB sees plaintext. Do NOT ship this to production as-is.
//
// The interface intentionally mirrors what the real message module will
// expose, so phase 23 is a drop-in swap of the import.

function utf8ToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function bytesToUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// encryptForChannel: plaintext string -> base64 "ciphertext" (passthrough).
// _channelID is accepted to match the real (phase 23) signature; unused
// here.
export async function encryptForChannel(
  _channelID: string,
  plaintext: string,
): Promise<string> {
  return bytesToBase64(utf8ToBytes(plaintext));
}

// decryptForChannel: base64 "ciphertext" -> plaintext string (passthrough).
export async function decryptForChannel(
  _channelID: string,
  b64Ciphertext: string,
): Promise<string> {
  return bytesToUtf8(base64ToBytes(b64Ciphertext));
}
