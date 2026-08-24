// chalk -- 83-4: identity generations as a signed chain.
//
// WHY A CHAIN, NOT ROWS. Every signed envelope seals the fingerprint of the
// identity generation that signed it (83-1). When a user rotates their
// identity, history signed by the old key must stay verifiable on a fresh
// device -- so the old generation has to remain fetchable. But under the
// phase-83 trust model the host can WRITE the database (claim 2's R18
// boundary), and a server-attested "retired generation of Alice" row is
// exactly what a database write could fabricate: attacker key in, an honest
// chalkd truthfully serving its poisoned table, historical impersonation
// out (R16-1). So generations are linked cryptographically -- each rotation
// is signed by the key it retires -- and a database row alone proves
// nothing.
//
// FROZEN FORMATS (PHASE-83-MSGSIG.md D.1; same encoding discipline as the
// envelope -- lp/uuid16/h32 from crypto/envelope.ts):
//
//   generation_cert canonical = utf8("chalk-idgen.v1")
//     || uuid16(user) || u32be(generation)              // 2, 3, ...
//     || h32(new_ed25519_fp) || h32(sha256(new_x25519_pub))
//     || h32(prev_generation_hash)
//   sig64           = Ed25519(PREVIOUS generation's key, canonical)
//                     -- exactly 64 raw bytes, NOT part of the canonical
//   generation_hash = SHA-256(canonical || sig64)
//
//   generation1_hash = SHA-256(utf8("chalk-idgen-root.v1")
//     || uuid16(user) || h32(ed25519_fp)
//     || h32(sha256(x25519_pub)) || self_sig64)
//                     -- the root: computed from the generation-1 record's
//                     OWN bytes (key material + its Ed25519->X25519
//                     self-sig), never from database metadata, so two
//                     implementations agree without consulting the server.
//
// Generation 1's trust is what it always was: the TOFU pin, upgradeable by
// picture-word. Everything after it inherits trust through the certs.
//
// WHAT A CHAIN BREAK MEANS. A rotation that cannot sign with the old key
// (lost seed -- the recovery case) starts a NEW chain: its first generation
// carries no cert and cannot be linked to anything pinned. That is the
// identity-changed WALL (trust.ts), and history signed by pre-break
// generations becomes unlinkable ("an earlier identity that cannot be tied
// to this user's current key") until an out-of-band comparison re-attests
// it. Honest and loud -- exactly the semantics key loss deserves.

import { uuid16, ed25519Fingerprint, verifyEnvelopeSig } from "./envelope";
import { verifyIdentitySelfSig } from "./identity";
import { concat, utf8, writeU32BE } from "./spacekey";
import { asBytes } from "./bytes";

const CERT_DOMAIN = utf8("chalk-idgen.v1");
const ROOT_DOMAIN = utf8("chalk-idgen-root.v1");
const SIG_BYTES = 64;

/** One generation as served by fetch_identity_chain: key material plus the
 *  cert its predecessor signed (null for generation 1). */
export interface GenerationRecord {
  generation: number;
  ed25519Public: Uint8Array;
  x25519Public: Uint8Array;
  selfSig: Uint8Array;
  genCert: Uint8Array | null;
}

/** A generation the chain walk accepted. `hash` is what the NEXT cert's
 *  prev_generation_hash must equal. */
export interface VerifiedGeneration {
  generation: number;
  ed25519Public: Uint8Array;
  x25519Public: Uint8Array;
  fpHex: string;
  hash: Uint8Array;
}

async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", asBytes(b)));
}

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function join(parts: Uint8Array[]): Uint8Array {
  let out: Uint8Array = new Uint8Array(0);
  for (const p of parts) out = concat(out, p);
  return out;
}

/**
 * generationRootHash computes generation 1's hash from its own record.
 * Throws on malformed key material -- a root can only be computed from a
 * well-formed record.
 */
export async function generationRootHash(
  userID: string,
  ed25519Public: Uint8Array,
  x25519Public: Uint8Array,
  selfSig: Uint8Array,
): Promise<Uint8Array> {
  if (ed25519Public.length !== 32 || x25519Public.length !== 32 || selfSig.length !== SIG_BYTES) {
    throw new Error("idgen: malformed generation-1 record");
  }
  return sha256(
    join([
      ROOT_DOMAIN,
      uuid16(userID),
      await ed25519Fingerprint(ed25519Public),
      await sha256(x25519Public),
      selfSig,
    ]),
  );
}

/**
 * generationCertCanonical builds the bytes the previous generation signs to
 * admit `generation`. Throws on generation < 2 or malformed inputs.
 */
export async function generationCertCanonical(
  userID: string,
  generation: number,
  newEd25519Public: Uint8Array,
  newX25519Public: Uint8Array,
  prevGenerationHash: Uint8Array,
): Promise<Uint8Array> {
  if (!Number.isInteger(generation) || generation < 2 || generation > 0xffffffff) {
    throw new Error(`idgen: generation out of range: ${generation}`);
  }
  if (newEd25519Public.length !== 32 || newX25519Public.length !== 32 || prevGenerationHash.length !== 32) {
    throw new Error("idgen: malformed cert inputs");
  }
  const gen = new Uint8Array(4);
  writeU32BE(gen, 0, generation);
  return join([
    CERT_DOMAIN,
    uuid16(userID),
    gen,
    await ed25519Fingerprint(newEd25519Public),
    await sha256(newX25519Public),
    prevGenerationHash,
  ]);
}

/**
 * mintGenerationCert signs the successor with the generation being retired.
 * This is the whole point of a normal rotation: the old identity is in hand
 * and vouches for the new one as part of the same action.
 */
export async function mintGenerationCert(
  prevEd25519Private: CryptoKey,
  userID: string,
  generation: number,
  newEd25519Public: Uint8Array,
  newX25519Public: Uint8Array,
  prevGenerationHash: Uint8Array,
): Promise<Uint8Array> {
  const canonical = await generationCertCanonical(userID, generation, newEd25519Public, newX25519Public, prevGenerationHash);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, prevEd25519Private, asBytes(canonical)));
  if (sig.length !== SIG_BYTES) throw new Error(`idgen: unexpected signature length ${sig.length}`);
  return sig;
}

/** generationHash = SHA-256(canonical || sig64). */
export async function generationHash(canonical: Uint8Array, sig64: Uint8Array): Promise<Uint8Array> {
  return sha256(concat(canonical, sig64));
}

/**
 * verifyGenerationChain walks records 1..n in order and returns the
 * verified PREFIX -- every generation up to the first link that fails. A
 * break is not an error to throw: the caller decides what it means (a
 * pinned key inside the prefix keeps its standing; a key after the break is
 * unlinkable -- the wall). Never throws.
 *
 * Per generation: the Ed25519->X25519 self-signature must verify; for
 * generation >= 2 the cert must be exactly 64 bytes and verify under the
 * PREVIOUS generation's key over the canonical that names this user, this
 * generation number, this key material and the previous hash. Generations
 * must be contiguous from 1; a record whose number is out of sequence ends
 * the walk.
 */
export async function verifyGenerationChain(
  userID: string,
  records: GenerationRecord[],
): Promise<VerifiedGeneration[]> {
  const out: VerifiedGeneration[] = [];
  try {
    const sorted = [...records].sort((a, b) => a.generation - b.generation);
    let prevHash: Uint8Array | null = null;
    let prevPub: Uint8Array | null = null;
    for (const r of sorted) {
      const expected = out.length + 1;
      if (r.generation !== expected) break;
      if (!(await verifyIdentitySelfSig(r.x25519Public, r.ed25519Public, r.selfSig))) break;
      let hash: Uint8Array;
      if (r.generation === 1) {
        if (r.genCert !== null) break; // a root carries no cert
        hash = await generationRootHash(userID, r.ed25519Public, r.x25519Public, r.selfSig);
      } else {
        if (!r.genCert || r.genCert.length !== SIG_BYTES || !prevHash || !prevPub) break;
        const canonical = await generationCertCanonical(
          userID,
          r.generation,
          r.ed25519Public,
          r.x25519Public,
          prevHash,
        );
        if (!(await verifyEnvelopeSig(canonical, r.genCert, prevPub))) break;
        hash = await generationHash(canonical, r.genCert);
      }
      out.push({
        generation: r.generation,
        ed25519Public: r.ed25519Public,
        x25519Public: r.x25519Public,
        fpHex: hex(await ed25519Fingerprint(r.ed25519Public)),
        hash,
      });
      prevHash = hash;
      prevPub = r.ed25519Public;
    }
  } catch {
    // malformed input mid-walk: the prefix verified so far stands
  }
  return out;
}

/**
 * chainStanding answers the resolver's question from a verified chain: given
 * the key this device has PINNED and the fingerprint that signed something,
 * is that fingerprint the pinned generation ("current"), an earlier
 * generation linked to it ("retired"), a later generation the pin can roll
 * forward to ("current" -- chained rotation), or nothing we can link
 * ("foreign")? "unlinked" means the pinned key itself is not in the chain:
 * the chain reaches nothing this device believes.
 */
export function chainStanding(
  chain: VerifiedGeneration[],
  pinnedEd25519Public: Uint8Array,
  fpHex: string,
): { kind: "current" | "retired" | "foreign" | "unlinked"; generation?: VerifiedGeneration } {
  const pinnedHex = hex(pinnedEd25519Public);
  const pinnedIdx = chain.findIndex((g) => hex(g.ed25519Public) === pinnedHex);
  if (pinnedIdx === -1) return { kind: "unlinked" };
  const idx = chain.findIndex((g) => g.fpHex === fpHex);
  if (idx === -1) return { kind: "foreign" };
  return { kind: idx < pinnedIdx ? "retired" : "current", generation: chain[idx] };
}
