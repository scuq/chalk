// chalk-web -- 84-1: backing up the identity pins.
//
// WHY. A pin is what turns "the server says this is Bob's key" into "this is
// the key this device has always seen for Bob" (82-2). It lives in IndexedDB,
// and IndexedDB dies with the browser profile: cleared site data, a new
// machine, a reinstall, and every peer drops back to first_seen -- which is
// exactly the state in which a substituted key is adopted without a word to
// anyone. Losing the "verified" ticks is an annoyance; losing the PINS reopens
// the window phase 82 exists to close.
//
// WHAT RIDES WHERE. The blob goes in user prefs under one flat key, sealed with
// AES-256-GCM under a key derived from the identity's X25519 scalar -- the same
// construction the notification rules and the per-peer audio list already use
// (prefs-blob.ts). The server stores ciphertext and fans it out to the user's
// other devices; it can neither read a pin nor forge one, since a tampered blob
// fails the GCM tag and opens as null.
//
// The scalar comes from the 24-word encryption phrase, which is the one thing
// that already survives storage loss. So restoring is not a separate ritual the
// user has to have remembered to perform: unlock the identity, and the pins
// come back with the messages.
//
// WHAT THE SERVER CAN STILL DO, and why it does not matter. It can withhold the
// blob, or serve an older one. Neither hurts, because the merge below only ever
// adds a record or strengthens the evidence behind one -- a stale blob cannot
// delete a pin or replace it with a weaker claim, and a withheld blob leaves
// the device exactly where it would have been with no backup at all. That is
// why there is no rollback counter here: there is nothing for a rollback to
// undo.
//
// THE MERGE IS THE WHOLE DESIGN. Two devices can hold different keys for the
// same peer, and which one wins decides whether this feature protects the user
// or launders an attack into the device that would have caught it. Take a fresh
// device that is served a substituted key on first sight: it pins it without
// complaint, having nothing to compare against. Under "newest wins" that pin
// would then propagate to the device holding the real one, and the alarm the
// user should have seen never fires. So instead:
//
//   * same key          -- merge the metadata, keep the strongest provenance
//   * one side compared -- the out-of-band comparison wins (only the user can
//                          make one, and the server cannot forge one into a
//                          sealed blob)
//   * neither compared  -- the EARLIER sighting wins
//
// That last rule is TOFU's own principle carried across devices: the first key
// you ever saw is the anchor, and a later disagreement is the thing to be
// suspicious of rather than the thing to adopt. A peer who legitimately
// reinstalled therefore reads as "key changed" until someone compares the new
// number out of band -- alarm rather than silence, and one comparison settles it
// for every device at once.
//
// Because the rule is a total order over any two records, BOTH directions use
// it: what this device keeps and what it uploads are the same merge. Two
// devices that disagree converge on the same answer instead of overwriting each
// other forever.

import { blobKey, openJSON, scalarFromX25519, sealJSON } from "./prefs-blob";
import { computeSafetyNumber, digestToHex, type VerificationRecord } from "./safety-number";

const HKDF_SALT = "chalk-pin-backup-salt-v1";
const HKDF_INFO = "chalk-pin-backup-v1";
const VERSION = 1;

/** The prefs key the sealed blob rides under. */
export const PINS_PREFS_KEY = "identity_pins_enc";

export { scalarFromX25519 };

export function pinsAesKey(scalar: Uint8Array): Promise<CryptoKey> {
  return blobKey(scalar, HKDF_SALT, HKDF_INFO);
}

/**
 * One packed pin:
 *
 *   [peerUserID, ed25519PubB64, generation, pinnedAt, verifiedAt, digestHex?]
 *
 * Timestamps are SECONDS, not the record's milliseconds: three digits each of
 * pure noise, times every peer, against a budget measured in kilobytes.
 *
 * digestHex is absent whenever the pinned key is present, because it is
 * *derivable* from it -- see hydratePins. Storing it as well would be storing
 * the same fact twice in a format that can disagree with itself. Only a pre-82
 * record, which pinned a digest and no key, carries one.
 */
export type PackedPin = [string, string, number, number, number, string?];

interface PinBlob {
  v: number;
  pins: PackedPin[];
}

function b64decode(s: string): Uint8Array | null {
  try {
    const raw = atob(s);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** compared reports whether a human ever checked this record out of band. */
export function compared(r: VerificationRecord): boolean {
  return r.verifiedAt > 0;
}

/** firstSeen is when this key was first pinned, however the record got here. */
function firstSeen(r: VerificationRecord): number {
  return r.pinnedAt ?? r.verifiedAt;
}

export function packPin(r: VerificationRecord): PackedPin {
  const packed: PackedPin = [
    r.peerUserID,
    r.ed25519PubB64 ?? "",
    r.generation,
    Math.floor(firstSeen(r) / 1000),
    Math.floor(r.verifiedAt / 1000),
  ];
  if (!r.ed25519PubB64) packed.push(r.digestHex);
  return packed;
}

/**
 * unpackPins validates the shape of a decrypted blob. Total over garbage: the
 * blob comes back through the server, so anything but a well-formed current
 * version is null and the local pins stand.
 */
export function unpackPins(value: unknown): PackedPin[] | null {
  const blob = value as PinBlob | null;
  if (!blob || blob.v !== VERSION || !Array.isArray(blob.pins)) return null;
  const out: PackedPin[] = [];
  for (const p of blob.pins) {
    if (!Array.isArray(p) || p.length < 5) return null;
    const [id, pub, gen, pinned, verified, digest] = p as PackedPin;
    if (typeof id !== "string" || !id) return null;
    if (typeof pub !== "string") return null;
    if (typeof gen !== "number" || typeof pinned !== "number" || typeof verified !== "number") {
      return null;
    }
    // A record with neither a key nor a digest pins nothing at all.
    if (!pub && typeof digest !== "string") return null;
    out.push(digest === undefined ? [id, pub, gen, pinned, verified] : [id, pub, gen, pinned, verified, digest]);
  }
  return out;
}

/**
 * hydratePins turns packed pins back into records, recomputing the safety-number
 * digest for every one that carries a key. `ownEd25519Pub` is this identity's
 * public key -- the other half of the digest.
 *
 * A pin whose key will not decode is dropped rather than kept as a keyless
 * record: a pin that cannot be compared against anything is not evidence.
 */
export async function hydratePins(
  packed: PackedPin[],
  ownEd25519Pub: Uint8Array,
): Promise<VerificationRecord[]> {
  const out: VerificationRecord[] = [];
  for (const [id, pub, gen, pinned, verified, digest] of packed) {
    if (!pub) {
      out.push({
        peerUserID: id,
        digestHex: digest ?? "",
        generation: gen,
        verifiedAt: verified * 1000,
        pinnedAt: pinned * 1000,
      });
      continue;
    }
    const bytes = b64decode(pub);
    if (!bytes || bytes.length !== 32) continue;
    const sn = await computeSafetyNumber(ownEd25519Pub, bytes);
    out.push({
      peerUserID: id,
      // TOFU records pin a key and no digest; keep that distinction, since the
      // members panel reads an empty digest as "never compared".
      digestHex: verified > 0 ? digestToHex(sn.digest) : "",
      generation: gen,
      verifiedAt: verified * 1000,
      ed25519PubB64: pub,
      source: verified > 0 ? "manual" : "tofu",
      pinnedAt: pinned * 1000,
    });
  }
  return out;
}

/**
 * choosePin is the total order described in the header: comparison beats
 * sighting, and among equals the earlier sighting wins. Returns the record that
 * should stand, which may be either argument unchanged or a metadata merge of
 * the two.
 */
export function choosePin(a: VerificationRecord, b: VerificationRecord): VerificationRecord {
  const sameKey =
    a.ed25519PubB64 !== undefined && a.ed25519PubB64 === b.ed25519PubB64;

  if (sameKey) {
    // No disagreement about the key, so take the strongest claim about it from
    // either side: the comparison if either made one, and the earliest sighting.
    const strong = compared(a) === compared(b)
      ? (a.verifiedAt >= b.verifiedAt ? a : b)
      : (compared(a) ? a : b);
    return {
      ...strong,
      pinnedAt: Math.min(firstSeen(a), firstSeen(b)),
      verifiedAt: Math.max(a.verifiedAt, b.verifiedAt),
      generation: Math.max(a.generation, b.generation),
    };
  }

  if (compared(a) !== compared(b)) return compared(a) ? a : b;
  if (compared(a)) return a.verifiedAt >= b.verifiedAt ? a : b;
  return firstSeen(a) <= firstSeen(b) ? a : b;
}

export interface MergeResult {
  /** The full set after merging -- what to store, and what to upload. */
  merged: VerificationRecord[];
  /** Records that differ from `have` and so need writing. */
  writes: VerificationRecord[];
  /** Peers present in `incoming` that `have` knew nothing about. */
  restored: string[];
  /** Peers where the two sides pin different keys. Kept for the UI to report. */
  conflicts: string[];
}

/**
 * mergePins folds `incoming` into `have` under choosePin. Symmetric by
 * construction, so applying a remote blob locally and building the blob to
 * upload are the same call with the arguments swapped.
 */
export function mergePins(
  have: VerificationRecord[],
  incoming: VerificationRecord[],
): MergeResult {
  const byPeer = new Map<string, VerificationRecord>();
  for (const r of have) byPeer.set(r.peerUserID, r);

  const restored: string[] = [];
  const conflicts: string[] = [];
  const writes: VerificationRecord[] = [];

  for (const r of incoming) {
    const mine = byPeer.get(r.peerUserID);
    if (!mine) {
      byPeer.set(r.peerUserID, r);
      restored.push(r.peerUserID);
      writes.push(r);
      continue;
    }
    if (
      mine.ed25519PubB64 !== undefined &&
      r.ed25519PubB64 !== undefined &&
      mine.ed25519PubB64 !== r.ed25519PubB64
    ) {
      conflicts.push(r.peerUserID);
    }
    const winner = choosePin(mine, r);
    if (!samePin(mine, winner)) {
      byPeer.set(r.peerUserID, winner);
      writes.push(winner);
    }
  }

  return { merged: [...byPeer.values()], writes, restored, conflicts };
}

function samePin(a: VerificationRecord, b: VerificationRecord): boolean {
  return (
    a.ed25519PubB64 === b.ed25519PubB64 &&
    a.digestHex === b.digestHex &&
    a.verifiedAt === b.verifiedAt &&
    a.generation === b.generation &&
    (a.pinnedAt ?? 0) === (b.pinnedAt ?? 0)
  );
}

// ---- capacity ----------------------------------------------------------
//
// The server caps one prefs patch at 8 KiB (prefsMaxBytes, server/ws.go), and
// the sealed blob has to fit inside that with its JSON wrapper. A packed pin is
// around 95 bytes, so the ceiling is somewhere near 60 peers -- comfortable for
// the group chat this is, but not infinite, and a cap nobody is told about
// reads as "everything is backed up" when it is not. So the overflow is
// deliberate, ordered, and reported: comparisons are kept before sightings,
// because a comparison cost a human conversation and a sighting cost nothing.

/** Room for the sealed blob, leaving the patch's own JSON wrapper headroom. */
export const BLOB_BUDGET_BYTES = 7900;

/**
 * Base64 length of (nonce || ciphertext) for a plaintext of `n` bytes. Callers
 * pass a JSON string's length for `n`, which is its byte length too: every
 * field in a packed pin is ASCII (UUID, base64, digits).
 */
function sealedLength(n: number): number {
  return 4 * Math.ceil((12 + n + 16) / 3);
}

export interface FitResult {
  kept: VerificationRecord[];
  dropped: VerificationRecord[];
}

/**
 * fitPins picks the largest prefix of the priority order that still seals to
 * something the server will accept.
 */
export function fitPins(
  records: VerificationRecord[],
  budget: number = BLOB_BUDGET_BYTES,
): FitResult {
  const ordered = [...records].sort((a, b) => {
    if (compared(a) !== compared(b)) return compared(a) ? -1 : 1;
    if (compared(a)) return b.verifiedAt - a.verifiedAt;
    // No last-contact signal exists, so the most recent first sighting stands
    // in for "a peer this device is still dealing with".
    return firstSeen(b) - firstSeen(a);
  });

  const kept: VerificationRecord[] = [];
  const packed: PackedPin[] = [];
  for (const r of ordered) {
    packed.push(packPin(r));
    if (sealedLength(JSON.stringify({ v: VERSION, pins: packed }).length) > budget) {
      packed.pop();
      break;
    }
    kept.push(r);
  }
  return { kept, dropped: ordered.slice(kept.length) };
}

// ---- sealing -----------------------------------------------------------

/**
 * canonicalPins renders a set for CONTENT comparison, peer-sorted so two
 * devices that hold the same pins produce the same string.
 *
 * Ciphertext cannot answer "did anything change?": every seal draws a fresh
 * nonce, so re-sealing an unchanged set yields a different blob, and two
 * devices echoing each other's blobs would upload forever without this.
 */
export function canonicalPins(records: VerificationRecord[]): string {
  return JSON.stringify(
    [...records].sort((a, b) => (a.peerUserID < b.peerUserID ? -1 : 1)).map(packPin),
  );
}

export function sealPins(key: CryptoKey, records: VerificationRecord[]): Promise<string> {
  return sealJSON(key, { v: VERSION, pins: records.map(packPin) });
}

/** Total over garbage: bad base64, wrong key, tampering, unknown version. */
export async function openPins(
  key: CryptoKey,
  blob: string,
  ownEd25519Pub: Uint8Array,
): Promise<VerificationRecord[] | null> {
  const packed = unpackPins(await openJSON(key, blob));
  if (!packed) return null;
  return hydratePins(packed, ownEd25519Pub);
}
