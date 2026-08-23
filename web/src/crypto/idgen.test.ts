// Tests for crypto/idgen.ts -- 83-4 identity generations as a signed chain.
// The vectors PHASE-83-MSGSIG.md lists for this slice: per-field mutation
// (generation, new Ed fingerprint, X25519 hash, predecessor hash); a cert
// signed by the wrong generation; a truncated or 65-byte signature; a valid
// cert transplanted to another user; a root hash recomputed from tampered
// key material.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";

import { deriveIdentity, type DerivedIdentity } from "./identity";
import {
  generationRootHash,
  generationCertCanonical,
  mintGenerationCert,
  generationHash,
  verifyGenerationChain,
  chainStanding,
  type GenerationRecord,
} from "./idgen";
import { ed25519Fingerprint, uuid16 } from "./envelope";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const MALLORY = "eeeeeeee-0000-4000-8000-000000000003";

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Distinct seeds -> distinct identities; generation numbers are assigned by
// the caller (the seed is what rotates, see identity.ts).
async function ident(seedByte: number, generation: number): Promise<DerivedIdentity> {
  return deriveIdentity(new Uint8Array(64).fill(seedByte), generation);
}

function record(id: DerivedIdentity, genCert: Uint8Array | null): GenerationRecord {
  return {
    generation: id.generation,
    ed25519Public: id.ed25519Public,
    x25519Public: id.x25519Public,
    selfSig: id.selfSig,
    genCert,
  };
}

// A genuine 3-generation chain for ALICE: g1 -signs-> g2 -signs-> g3.
async function makeChain() {
  const g1 = await ident(1, 1);
  const g2 = await ident(2, 2);
  const g3 = await ident(3, 3);
  const h1 = await generationRootHash(ALICE, g1.ed25519Public, g1.x25519Public, g1.selfSig);
  const c2 = await mintGenerationCert(g1.ed25519Private, ALICE, 2, g2.ed25519Public, g2.x25519Public, h1);
  const h2 = await generationHash(
    await generationCertCanonical(ALICE, 2, g2.ed25519Public, g2.x25519Public, h1),
    c2,
  );
  const c3 = await mintGenerationCert(g2.ed25519Private, ALICE, 3, g3.ed25519Public, g3.x25519Public, h2);
  return { g1, g2, g3, h1, h2, c2, c3, records: [record(g1, null), record(g2, c2), record(g3, c3)] };
}

test("root hash is SHA-256 over the frozen root canonical (independent recomputation)", async () => {
  const g1 = await ident(1, 1);
  const got = await generationRootHash(ALICE, g1.ed25519Public, g1.x25519Public, g1.selfSig);
  const fp = createHash("sha256").update(g1.ed25519Public).digest();
  const xh = createHash("sha256").update(g1.x25519Public).digest();
  const want = createHash("sha256")
    .update(Buffer.from("chalk-idgen-root.v1"))
    .update(uuid16(ALICE))
    .update(fp)
    .update(xh)
    .update(g1.selfSig)
    .digest("hex");
  assert.equal(hex(got), want);
});

test("cert canonical matches the frozen layout byte for byte", async () => {
  const { g2, h1 } = await makeChain();
  const got = await generationCertCanonical(ALICE, 2, g2.ed25519Public, g2.x25519Public, h1);
  const want = Buffer.concat([
    Buffer.from("chalk-idgen.v1"),
    Buffer.from(uuid16(ALICE)),
    Buffer.from([0, 0, 0, 2]),
    createHash("sha256").update(g2.ed25519Public).digest(),
    createHash("sha256").update(g2.x25519Public).digest(),
    Buffer.from(h1),
  ]);
  assert.equal(hex(got), want.toString("hex"));
});

test("a genuine chain verifies end to end", async () => {
  const { g1, g2, g3, h1, records } = await makeChain();
  const chain = await verifyGenerationChain(ALICE, records);
  assert.equal(chain.length, 3);
  assert.equal(hex(chain[0].hash), hex(h1));
  assert.equal(chain[0].fpHex, hex(await ed25519Fingerprint(g1.ed25519Public)));
  assert.equal(chain[2].fpHex, hex(await ed25519Fingerprint(g3.ed25519Public)));
  // order on the wire does not matter; generation numbers do
  const shuffled = await verifyGenerationChain(ALICE, [records[2], records[0], records[1]]);
  assert.equal(shuffled.length, 3);
  void g2;
});

test("per-field mutation of a cert breaks the link (prefix stops before it)", async () => {
  const { g1, g2, g3, h1, c2, c3, records } = await makeChain();
  const other = await ident(9, 2);
  const variants: Array<[string, GenerationRecord[]]> = [
    // generation number: the cert was minted for 2, the record says 3
    ["generation", [record(g1, null), { ...record(g2, c2), generation: 3 }]],
    // new Ed25519 key swapped (fingerprint in the canonical changes)
    ["ed25519", [record(g1, null), { ...record(g2, c2), ed25519Public: other.ed25519Public, selfSig: other.selfSig }]],
    // new X25519 key swapped (self-sig still valid for the swapped pair? no -- use other's pair entirely but keep g2's cert)
    ["x25519", [record(g1, null), { ...record(other, c2), generation: 2 }]],
    // predecessor: gen 3's cert presented as gen 2's (prev hash would be h2, not h1)
    ["prev-hash", [record(g1, null), { ...record(g3, c3), generation: 2 }]],
  ];
  for (const [name, recs] of variants) {
    const chain = await verifyGenerationChain(ALICE, recs);
    assert.equal(chain.length, 1, `${name}: only the root should verify`);
    assert.equal(hex(chain[0].hash), hex(h1));
  }
  void records;
});

test("a cert signed by the wrong generation is refused", async () => {
  const { g1, g2, g3, h2 } = await makeChain();
  // gen 3 admitted by gen 1's key instead of gen 2's
  const badC3 = await mintGenerationCert(g1.ed25519Private, ALICE, 3, g3.ed25519Public, g3.x25519Public, h2);
  const c2 = (await makeChain()).c2; // fresh identical chain's c2 (deterministic seeds)
  const chain = await verifyGenerationChain(ALICE, [record(g1, null), record(g2, c2), record(g3, badC3)]);
  assert.equal(chain.length, 2);
});

test("a truncated or 65-byte cert is refused; a root with a cert is refused", async () => {
  const { g1, g2, c2 } = await makeChain();
  for (const bad of [c2.subarray(0, 63), new Uint8Array([...c2, 0]), new Uint8Array(0)]) {
    const chain = await verifyGenerationChain(ALICE, [record(g1, null), record(g2, bad)]);
    assert.equal(chain.length, 1, `cert of ${bad.length} bytes`);
  }
  assert.equal((await verifyGenerationChain(ALICE, [record(g1, c2)])).length, 0);
});

test("a valid cert transplanted to another user fails there", async () => {
  const { records, h1 } = await makeChain();
  // The root alone still verifies (nothing but the TOFU pin binds gen 1 to a
  // user), but its hash is user-bound, so the first cert -- minted over
  // ALICE's root hash -- does not link under MALLORY.
  const chain = await verifyGenerationChain(MALLORY, records);
  assert.equal(chain.length, 1);
  assert.notEqual(hex(chain[0].hash), hex(h1));
});

test("tampered root key material changes the root hash and breaks gen 2", async () => {
  const { g1, g2, c2 } = await makeChain();
  const other = await ident(7, 1);
  // self-sig still valid (other's own pair), but the root hash is not the
  // one gen 2's cert committed to
  const chain = await verifyGenerationChain(ALICE, [record(other, null), record(g2, c2)]);
  assert.equal(chain.length, 1);
  assert.notEqual(hex(chain[0].hash), hex(await generationRootHash(ALICE, g1.ed25519Public, g1.x25519Public, g1.selfSig)));
});

test("non-contiguous generations end the walk", async () => {
  const { g1, g3, c3 } = await makeChain();
  assert.equal((await verifyGenerationChain(ALICE, [record(g1, null), record(g3, c3)])).length, 1);
  assert.equal((await verifyGenerationChain(ALICE, [record(g3, c3)])).length, 0);
});

test("chainStanding: current, retired, forward, foreign, unlinked", async () => {
  const { g1, g2, g3, records } = await makeChain();
  const chain = await verifyGenerationChain(ALICE, records);
  const fp = async (id: DerivedIdentity) => hex(await ed25519Fingerprint(id.ed25519Public));
  const stranger = await ident(42, 1);
  // pinned at gen 2
  assert.equal(chainStanding(chain, g2.ed25519Public, await fp(g2)).kind, "current");
  assert.equal(chainStanding(chain, g2.ed25519Public, await fp(g1)).kind, "retired");
  assert.equal(chainStanding(chain, g2.ed25519Public, await fp(g3)).kind, "current"); // chained forward
  assert.equal(chainStanding(chain, g2.ed25519Public, await fp(stranger)).kind, "foreign");
  // pinned at a key the chain never reaches: nothing can be linked
  assert.equal(chainStanding(chain, stranger.ed25519Public, await fp(g1)).kind, "unlinked");
});
