// Voice signaling crypto (Phase 30, slice 30-4; design §4 + §6 / Slice F).
//
// Two concerns live here, both pure enough to unit-test under node:
//
//  1. ENVELOPE: every voice_signal payload (SDP offer/answer, trickled ICE)
//     is E2E-encrypted under the channel space key before it touches the WS.
//     The server routes the blob by (to_user, to_device) and never sees
//     plaintext. Wire shape: { v: <key_version>, ct: <base64 ciphertext> } --
//     the version rides OUTSIDE the ciphertext (like message key_version) so
//     the receiver knows which space key opens it.
//
//  2. ANTI-MITM (Slice F): the DTLS a=fingerprint in each offer/answer SDP is
//     SIGNED with the sender's Ed25519 identity key over a canonical context
//     string that binds channel + both endpoints + direction. The receiver
//     verifies against the sender's PUBLISHED identity (fetchIdentity, phase
//     22, self-sig checked there). A signaling server that swaps fingerprints
//     cannot forge this signature, so a MITM at the relay/signaling layer is
//     detected and the call is aborted.
//
// ICE candidates are NOT individually signed: they carry no key material --
// the DTLS handshake is authenticated by the fingerprint binding alone, which
// is exactly what the signatures pin down. Candidates still ride encrypted.

// ---- envelope --------------------------------------------------------------

/**
 * The structural slice of ChannelCrypto this module needs. Kept as an
 * interface so tests can substitute a fake cipher without IndexedDB/WS.
 */
export interface VoiceEnvelopeCrypto {
  encryptBytesForChannel(
    channelID: string,
    bytes: Uint8Array,
  ): Promise<
    { kind: "encrypted"; ciphertext: Uint8Array; keyVersion: number } | { kind: "waiting" }
  >;
  decryptBytesForChannel(
    channelID: string,
    keyVersion: number,
    ciphertext: Uint8Array,
  ): Promise<Uint8Array | null>;
}

/** Wire shape of an encrypted signal payload (the voice_signal payload slot). */
export interface SealedSignal {
  v: number; // space-key version the ciphertext is under
  ct: string; // base64(suite||nonce||ct||tag) -- same framing as messages
}

/**
 * sealSignal encrypts one signaling object for the channel. Returns null when
 * we hold no usable space key ("waiting") -- the caller must NOT fall back to
 * plaintext; a voice call in a channel whose key hasn't arrived simply cannot
 * signal yet (fail-closed, matching the message path).
 */
export async function sealSignal(
  cc: VoiceEnvelopeCrypto,
  channelID: string,
  obj: unknown,
): Promise<SealedSignal | null> {
  const plain = new TextEncoder().encode(JSON.stringify(obj));
  const res = await cc.encryptBytesForChannel(channelID, plain);
  if (res.kind !== "encrypted") return null;
  return { v: res.keyVersion, ct: bytesToBase64(res.ciphertext) };
}

/**
 * openSignal decrypts a received envelope. Returns the parsed object, or null
 * on any failure (unknown version, tamper, malformed JSON). Never throws --
 * a bad blob from a peer must not take the call manager down.
 */
export async function openSignal(
  cc: VoiceEnvelopeCrypto,
  channelID: string,
  sealed: SealedSignal,
): Promise<unknown | null> {
  if (!sealed || typeof sealed.ct !== "string" || typeof sealed.v !== "number") {
    return null;
  }
  let ct: Uint8Array;
  try {
    ct = base64ToBytes(sealed.ct);
  } catch {
    return null;
  }
  const plain = await cc.decryptBytesForChannel(channelID, sealed.v, ct);
  if (!plain) return null;
  try {
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}

// ---- signal plaintext shapes ------------------------------------------------

/** Offer/answer plaintext: the SDP plus the fingerprint signature. */
export interface SdpSignal {
  sdp: string;
  /** base64 Ed25519 signature over canonicalFingerprintMessage(...). */
  fp_sig: string;
}

/** Trickled ICE plaintext. candidate=null signals end-of-candidates. */
export interface IceSignal {
  candidate: RTCIceCandidateInit | null;
}

// ---- fingerprint extraction -------------------------------------------------

/**
 * extractFingerprints pulls every a=fingerprint value out of an SDP, in
 * order, e.g. "sha-256 AB:CD:...". Session-level and media-level lines both
 * count: browsers put the DTLS fingerprint at either level, and a bundle
 * answer may repeat it per m-section. Order is preserved so both ends derive
 * the same canonical list from the same SDP.
 */
export function extractFingerprints(sdp: string): string[] {
  const out: string[] = [];
  for (const raw of sdp.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.toLowerCase().startsWith("a=fingerprint:")) {
      const v = line.slice("a=fingerprint:".length).trim();
      if (v) out.push(v);
    }
  }
  return out;
}

// ---- canonical signing context ---------------------------------------------

/** The endpoint/direction context a fingerprint signature is bound to. */
export interface FingerprintContext {
  channelID: string;
  fromUser: string;
  fromDevice: string;
  toUser: string;
  toDevice: string;
}

/**
 * canonicalFingerprintMessage builds the exact byte string that is signed.
 * Binding channel + (from,to) user/device + the fingerprint list means a
 * signature cannot be replayed into another channel, another peer pair, or
 * the reverse direction. Newline-joined; none of the components can contain
 * a newline (UUIDs and SDP attribute values), so the encoding is injective.
 */
export function canonicalFingerprintMessage(
  ctx: FingerprintContext,
  fingerprints: string[],
): Uint8Array {
  const s = [
    "chalk-voice-fp.v1",
    ctx.channelID,
    ctx.fromUser,
    ctx.fromDevice,
    ctx.toUser,
    ctx.toDevice,
    ...fingerprints,
  ].join("\n");
  return new TextEncoder().encode(s);
}

/**
 * signFingerprints signs the canonical message with the local Ed25519
 * identity private key (non-extractable, usage ["sign"], phase 22).
 * Returns a base64 signature for the fp_sig slot.
 */
export async function signFingerprints(
  ed25519Private: CryptoKey,
  ctx: FingerprintContext,
  fingerprints: string[],
): Promise<string> {
  if (fingerprints.length === 0) {
    throw new Error("voice: SDP carries no DTLS fingerprint to sign");
  }
  const msg = canonicalFingerprintMessage(ctx, fingerprints);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, ed25519Private, msg));
  return bytesToBase64(sig);
}

/**
 * verifyFingerprints checks fp_sig against the sender's raw 32-byte Ed25519
 * public key (from their VERIFIED published identity). Returns false on any
 * failure -- import error, bad base64, empty list, signature mismatch. The
 * caller treats false as a possible MITM and MUST abort the peer connection.
 */
export async function verifyFingerprints(
  ed25519PublicRaw: Uint8Array,
  ctx: FingerprintContext,
  fingerprints: string[],
  fpSigB64: string,
): Promise<boolean> {
  if (fingerprints.length === 0) return false;
  let sig: Uint8Array;
  try {
    sig = base64ToBytes(fpSigB64);
  } catch {
    return false;
  }
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      ed25519PublicRaw as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch {
    return false;
  }
  const msg = canonicalFingerprintMessage(ctx, fingerprints);
  try {
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sig as BufferSource, msg);
  } catch {
    return false;
  }
}

// ---- base64 (standard, with padding -- matches Go's base64.StdEncoding) ----

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
