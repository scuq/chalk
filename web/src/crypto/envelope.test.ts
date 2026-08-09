// Tests for src/crypto/envelope.ts -- phase 83 slice 83-1.
//
// The frozen canonical layout is asserted against an INDEPENDENT hand-built
// encoder (below, using only DataView/TextEncoder), which doubles as the
// machinery for crafting invalid byte strings the production encoder refuses
// to produce: oversize bodies, nil required uuids, key_version 0, wrong-size
// signatures, partial reply triples. The mutation/replay/cap/truncation
// vectors are the ones PHASE-83-MSGSIG.md D.1 lists for slice 1.
//
// Run via `node test.mjs` from web/.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";

import {
  OBJ_MESSAGE,
  OBJ_EDIT,
  OBJ_REACTION_SET,
  MAX_BODY_BYTES,
  MAX_ATTACHMENTS,
  MAX_EMOJI_PER_SET,
  uuid16,
  uuid16ToString,
  ed25519Fingerprint,
  encodeEnvelopeCanonical,
  signEnvelope,
  envelopeObjectHash,
  parseEnvelope,
  verifyEnvelopeSig,
  classifyEnvelope,
  envelopeActor,
  replayIdentity,
  type Envelope,
  type MessageEnvelope,
  type EditEnvelope,
  type ReactionSetEnvelope,
  type OuterFrame,
  type SignerResolution,
} from "./envelope";

// ---- helpers -------------------------------------------------------------

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function h32(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

interface Signer {
  priv: CryptoKey;
  pub: Uint8Array;
  fp: Uint8Array;
}

async function makeSigner(): Promise<Signer> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { priv: kp.privateKey, pub, fp: await ed25519Fingerprint(pub) };
}

const CH = "11111111-2222-3333-4444-555555555555";
const SENDER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER = "99999999-8888-7777-6666-555555555555";
const SCOPE = "0f0f0f0f-1e1e-2d2d-3c3c-4b4b4b4b4b4b";
const CMID = "12345678-9abc-def0-1234-56789abcdef0";
const NIL = "00000000-0000-0000-0000-000000000000";

function makeMessage(fp: Uint8Array, over: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    objType: OBJ_MESSAGE,
    channelID: CH,
    keyVersion: 3,
    senderUserID: SENDER,
    senderEd25519Fp: fp,
    writerScope: SCOPE,
    clientMsgID: CMID,
    senderTs: 1754730000000,
    wseq: 42,
    reply: null,
    bodyText: "hello, signed world",
    attachments: [],
    ...over,
  };
}

function makeEdit(fp: Uint8Array, over: Partial<EditEnvelope> = {}): EditEnvelope {
  return {
    objType: OBJ_EDIT,
    channelID: CH,
    keyVersion: 3,
    senderUserID: SENDER,
    senderEd25519Fp: fp,
    writerScope: SCOPE,
    clientMsgID: "0000000a-000b-000c-000d-00000000000e",
    targetSender: SENDER,
    targetScope: SCOPE,
    targetClientMsgID: CMID,
    prevRevHash: h32(7),
    senderTs: 1754730001000,
    bodyText: "hello, edited world",
    attachments: [],
    ...over,
  };
}

function makeReactionSet(fp: Uint8Array, over: Partial<ReactionSetEnvelope> = {}): ReactionSetEnvelope {
  return {
    objType: OBJ_REACTION_SET,
    channelID: CH,
    keyVersion: 3,
    actorUserID: OTHER,
    senderEd25519Fp: fp,
    writerScope: SCOPE,
    clientMsgID: "00000001-0002-0003-0004-000000000005",
    targetSender: SENDER,
    targetScope: SCOPE,
    targetClientMsgID: CMID,
    targetEnvHash: h32(9),
    prevSetHash: null,
    senderTs: 1754730002000,
    emoji: ["👍", "🎉"],
    ...over,
  };
}

const OUTER_OK: OuterFrame = { channelID: CH, keyVersion: 3, senderUserID: SENDER };

function resolveAs(res: SignerResolution): (a: string, fp: Uint8Array) => Promise<SignerResolution> {
  return async () => res;
}

// ---- an independent hand-built encoder (layout oracle + invalid-vector
// ---- factory). Deliberately reimplements lp/u32/u64/uuid from scratch.

function iU32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}
function iU64(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n);
  return b;
}
function iLp(x: Uint8Array): Uint8Array {
  return iCat(iU32(x.length), x);
}
function iUuid(id: string): Uint8Array {
  const clean = id.replace(/-/g, "");
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  return b;
}
function iCat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
const iDomain = new TextEncoder().encode("chalk-msg-sig.v1");
const iZero32 = new Uint8Array(32);
const iZeroUuid = new Uint8Array(16);

// Hand-built 0x01 canonical for makeMessage(fp) with reply = null, no
// attachments -- the layout oracle.
function handBuiltMessageCanonical(fp: Uint8Array, body: Uint8Array): Uint8Array {
  return iCat(
    iDomain,
    Uint8Array.of(0x01),
    iUuid(CH),
    iU32(3),
    iUuid(SENDER),
    fp,
    iUuid(SCOPE),
    iUuid(CMID),
    iU64(1754730000000n),
    iU64(42n),
    iZeroUuid,
    iZeroUuid,
    iZeroUuid,
    iZero32,
    iLp(body),
    iU32(0),
  );
}

// ---- uuid16 --------------------------------------------------------------

test("uuid16 round-trips and normalizes to lowercase", () => {
  const b = uuid16("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");
  assert.equal(uuid16ToString(b), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(uuid16ToString(uuid16(CMID)), CMID);
});

test("uuid16 rejects non-canonical forms", () => {
  for (const bad of [
    "",
    "not-a-uuid",
    "aaaaaaaabbbbccccddddeeeeeeeeeeee", // no hyphens
    "{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}", // braces
    "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee0", // too long
    "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee", // too short
    "gaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", // non-hex
  ]) {
    assert.throws(() => uuid16(bad), undefined, `accepted ${JSON.stringify(bad)}`);
  }
  assert.throws(() => uuid16ToString(new Uint8Array(15)));
});

// ---- fingerprint ---------------------------------------------------------

test("ed25519Fingerprint is SHA-256 of the raw public key (frozen)", async () => {
  const s = await makeSigner();
  assert.equal(hex(s.fp), createHash("sha256").update(s.pub).digest("hex"));
  await assert.rejects(ed25519Fingerprint(new Uint8Array(31)));
});

// ---- frozen layout oracle ------------------------------------------------

test("0x01 canonical matches the independent hand-built layout byte for byte", async () => {
  const s = await makeSigner();
  const canonical = encodeEnvelopeCanonical(makeMessage(s.fp));
  const oracle = handBuiltMessageCanonical(s.fp, new TextEncoder().encode("hello, signed world"));
  assert.equal(hex(canonical), hex(oracle));
});

test("object_hash is SHA-256(canonical || lp(sig64)) (frozen)", async () => {
  const s = await makeSigner();
  const signed = await signEnvelope(makeMessage(s.fp), s.priv);
  const got = await envelopeObjectHash(signed);
  assert.equal(hex(got), createHash("sha256").update(signed).digest("hex"));
  // and the framing really is canonical || lp(sig64)
  const canonical = encodeEnvelopeCanonical(makeMessage(s.fp));
  assert.equal(hex(signed.subarray(0, canonical.length)), hex(canonical));
  assert.equal(signed.length, canonical.length + 4 + 64);
});

// ---- sign -> parse -> verify round trips ---------------------------------

test("message round trip: sign, parse, verify, classify verified", async () => {
  const s = await makeSigner();
  const env = makeMessage(s.fp, {
    reply: { parentSender: OTHER, parentScope: SCOPE, parentClientMsgID: CMID, parentEnvHash: h32(5) },
    attachments: [
      {
        attachmentID: "aaaa0000-0000-0000-0000-00000000aaaa",
        attKeyVersion: 2,
        byteLen: 123456,
        ciphertextSha256: h32(1),
        encMetaSha256: h32(2),
        encPreviewSha256: null,
      },
    ],
  });
  const signed = await signEnvelope(env, s.priv);
  const parsed = parseEnvelope(signed);
  assert.equal(parsed.kind, "envelope");
  if (parsed.kind !== "envelope") return;
  assert.deepEqual(parsed.env, env);
  assert.equal(await verifyEnvelopeSig(parsed.canonical, parsed.sig, s.pub), true);
  const cls = await classifyEnvelope(parsed, OUTER_OK, resolveAs({ kind: "current", ed25519Public: s.pub }));
  assert.equal(cls.status, "verified");
  assert.deepEqual(cls.env, env);
});

test("edit round trip incl. null prevRevHash (legacy original)", async () => {
  const s = await makeSigner();
  for (const prev of [h32(7), null]) {
    const env = makeEdit(s.fp, { prevRevHash: prev });
    const parsed = parseEnvelope(await signEnvelope(env, s.priv));
    assert.equal(parsed.kind, "envelope");
    if (parsed.kind !== "envelope") return;
    assert.deepEqual(parsed.env, env);
  }
});

test("reaction set round trip incl. empty set (a clear) and null hashes", async () => {
  const s = await makeSigner();
  for (const over of [
    {},
    { emoji: [] as string[] }, // the signed sealed clear
    { targetEnvHash: null, prevSetHash: h32(3) }, // legacy target, later set
  ]) {
    const env = makeReactionSet(s.fp, over);
    const parsed = parseEnvelope(await signEnvelope(env, s.priv));
    assert.equal(parsed.kind, "envelope");
    if (parsed.kind !== "envelope") return;
    assert.deepEqual(parsed.env, env);
  }
});

// ---- legacy vs malformed -------------------------------------------------

test("plaintext without the domain prefix parses as legacy (pre-83 body)", () => {
  assert.equal(parseEnvelope(new TextEncoder().encode("just some old message")).kind, "legacy");
  assert.equal(parseEnvelope(new Uint8Array(0)).kind, "legacy");
  assert.equal(parseEnvelope(new TextEncoder().encode("chalk-msg-sig.v")).kind, "legacy"); // short of the prefix
});

test("domain prefix followed by garbage is malformed, not legacy", () => {
  assert.equal(parseEnvelope(iCat(iDomain, Uint8Array.of(0x01, 0xde, 0xad))).kind, "malformed");
  assert.equal(parseEnvelope(iDomain).kind, "malformed"); // prefix alone
  assert.equal(parseEnvelope(iCat(iDomain, Uint8Array.of(0x7f))).kind, "malformed"); // unknown objType
});

test("classify labels legacy and malformed bodies unsigned", async () => {
  const resolve = resolveAs({ kind: "current", ed25519Public: new Uint8Array(32) });
  const legacy = parseEnvelope(new TextEncoder().encode("old"));
  assert.equal((await classifyEnvelope(legacy, OUTER_OK, resolve)).status, "unsigned");
  assert.equal((await classifyEnvelope(parseEnvelope(iDomain), OUTER_OK, resolve)).status, "unsigned");
});

// ---- truncation / trailing / signature framing ---------------------------

test("truncation anywhere is malformed", async () => {
  const s = await makeSigner();
  const signed = await signEnvelope(makeMessage(s.fp), s.priv);
  // every strict prefix that still carries the domain must be malformed
  for (const cut of [signed.length - 1, signed.length - 64, signed.length - 68, 40, 20, 17]) {
    assert.equal(parseEnvelope(signed.subarray(0, cut)).kind, "malformed", `cut at ${cut}`);
  }
});

test("trailing bytes after the signature are malformed", async () => {
  const s = await makeSigner();
  const signed = await signEnvelope(makeMessage(s.fp), s.priv);
  assert.equal(parseEnvelope(iCat(signed, Uint8Array.of(0))).kind, "malformed");
});

test("a truncated or 65-byte signature is malformed", async () => {
  const s = await makeSigner();
  const canonical = encodeEnvelopeCanonical(makeMessage(s.fp));
  const sig = new Uint8Array(64).fill(0xab);
  assert.equal(parseEnvelope(iCat(canonical, iLp(sig.subarray(0, 63)))).kind, "malformed");
  assert.equal(parseEnvelope(iCat(canonical, iLp(iCat(sig, Uint8Array.of(0))))).kind, "malformed");
  assert.equal(parseEnvelope(iCat(canonical, iLp(new Uint8Array(0)))).kind, "malformed");
  // and the well-formed framing with a garbage sig parses but never verifies
  const parsed = parseEnvelope(iCat(canonical, iLp(sig)));
  assert.equal(parsed.kind, "envelope");
  if (parsed.kind !== "envelope") return;
  assert.equal(await verifyEnvelopeSig(parsed.canonical, parsed.sig, s.pub), false);
});

// ---- structural invariants the parser must reject ------------------------

test("nil required uuids, key_version 0 and oversize u64 are malformed", async () => {
  const s = await makeSigner();
  const body = iLp(new Uint8Array(0));
  const mk = (channel: Uint8Array, kv: Uint8Array, ts: Uint8Array) =>
    iCat(
      iDomain,
      Uint8Array.of(0x01),
      channel,
      kv,
      iUuid(SENDER),
      s.fp,
      iUuid(SCOPE),
      iUuid(CMID),
      ts,
      iU64(1n),
      iZeroUuid,
      iZeroUuid,
      iZeroUuid,
      iZero32,
      body,
      iU32(0),
      iLp(new Uint8Array(64)),
    );
  const ok = mk(iUuid(CH), iU32(1), iU64(1n));
  assert.equal(parseEnvelope(ok).kind, "envelope");
  assert.equal(parseEnvelope(mk(iZeroUuid, iU32(1), iU64(1n))).kind, "malformed"); // nil channel
  assert.equal(parseEnvelope(mk(iUuid(CH), iU32(0), iU64(1n))).kind, "malformed"); // key_version 0
  assert.equal(parseEnvelope(mk(iUuid(CH), iU32(1), iU64(1n << 60n))).kind, "malformed"); // > 2^53
});

test("a partial reply triple, or a parent hash without a triple, is malformed", async () => {
  const s = await makeSigner();
  const mk = (parSender: Uint8Array, parScope: Uint8Array, parCmid: Uint8Array, parHash: Uint8Array) =>
    iCat(
      iDomain,
      Uint8Array.of(0x01),
      iUuid(CH),
      iU32(1),
      iUuid(SENDER),
      s.fp,
      iUuid(SCOPE),
      iUuid(CMID),
      iU64(1n),
      iU64(1n),
      parSender,
      parScope,
      parCmid,
      parHash,
      iLp(new Uint8Array(0)),
      iU32(0),
      iLp(new Uint8Array(64)),
    );
  assert.equal(parseEnvelope(mk(iUuid(OTHER), iUuid(SCOPE), iUuid(CMID), iZero32)).kind, "envelope"); // legacy parent ok
  assert.equal(parseEnvelope(mk(iUuid(OTHER), iZeroUuid, iUuid(CMID), h32(5))).kind, "malformed"); // partial triple
  assert.equal(parseEnvelope(mk(iZeroUuid, iZeroUuid, iZeroUuid, h32(5))).kind, "malformed"); // hash, no triple
});

test("an edit whose sender differs from the target sender is refused everywhere", async () => {
  const s = await makeSigner();
  // encoder: throws
  assert.throws(() => encodeEnvelopeCanonical(makeEdit(s.fp, { targetSender: OTHER })));
  // parser: malformed (hand-built, since the encoder refuses)
  const bytes = iCat(
    iDomain,
    Uint8Array.of(0x02),
    iUuid(CH),
    iU32(1),
    iUuid(SENDER),
    s.fp,
    iUuid(SCOPE),
    iUuid(CMID),
    iUuid(OTHER), // tgt_sender != sender
    iUuid(SCOPE),
    iUuid(CMID),
    iZero32,
    iU64(1n),
    iLp(new Uint8Array(0)),
    iU32(0),
    iLp(new Uint8Array(64)),
  );
  assert.equal(parseEnvelope(bytes).kind, "malformed");
});

test("invalid utf-8 in the body is malformed", async () => {
  const s = await makeSigner();
  const bad = iCat(
    iDomain,
    Uint8Array.of(0x01),
    iUuid(CH),
    iU32(3),
    iUuid(SENDER),
    s.fp,
    iUuid(SCOPE),
    iUuid(CMID),
    iU64(1754730000000n),
    iU64(42n),
    iZeroUuid,
    iZeroUuid,
    iZeroUuid,
    iZero32,
    iLp(Uint8Array.of(0xff, 0xfe, 0xfd)),
    iU32(0),
    iLp(new Uint8Array(64)),
  );
  assert.equal(parseEnvelope(bad).kind, "malformed");
});

// ---- caps ----------------------------------------------------------------

test("caps: body, attachments, emoji -- encoder throws, parser rejects", async () => {
  const s = await makeSigner();

  // body: 65,536 ok; 65,537 refused by encoder and parser
  const atCap = makeMessage(s.fp, { bodyText: "a".repeat(MAX_BODY_BYTES) });
  assert.equal(parseEnvelope(await signEnvelope(atCap, s.priv)).kind, "envelope");
  assert.throws(() => encodeEnvelopeCanonical(makeMessage(s.fp, { bodyText: "a".repeat(MAX_BODY_BYTES + 1) })));
  const overBody = iCat(
    iDomain,
    Uint8Array.of(0x01),
    iUuid(CH),
    iU32(3),
    iUuid(SENDER),
    s.fp,
    iUuid(SCOPE),
    iUuid(CMID),
    iU64(1n),
    iU64(1n),
    iZeroUuid,
    iZeroUuid,
    iZeroUuid,
    iZero32,
    iLp(new Uint8Array(MAX_BODY_BYTES + 1).fill(0x61)),
    iU32(0),
    iLp(new Uint8Array(64)),
  );
  assert.equal(parseEnvelope(overBody).kind, "malformed");

  // attachments: 11 refused
  const att = {
    attachmentID: "aaaa0000-0000-0000-0000-00000000aaaa",
    attKeyVersion: 1,
    byteLen: 1,
    ciphertextSha256: h32(1),
    encMetaSha256: null,
    encPreviewSha256: null,
  };
  assert.throws(() =>
    encodeEnvelopeCanonical(makeMessage(s.fp, { attachments: Array(MAX_ATTACHMENTS + 1).fill(att) })),
  );
  assert.equal(
    parseEnvelope(await signEnvelope(makeMessage(s.fp, { attachments: Array(MAX_ATTACHMENTS).fill(att) }), s.priv))
      .kind,
    "envelope",
  );

  // emoji: 65 refused; empty emoji refused; 33-byte emoji refused
  assert.throws(() =>
    encodeEnvelopeCanonical(makeReactionSet(s.fp, { emoji: Array(MAX_EMOJI_PER_SET + 1).fill("x") })),
  );
  assert.throws(() => encodeEnvelopeCanonical(makeReactionSet(s.fp, { emoji: [""] })));
  assert.throws(() => encodeEnvelopeCanonical(makeReactionSet(s.fp, { emoji: ["x".repeat(33)] })));
});

test("absent-vs-zero: an explicit all-zero h32 is refused by the encoder (absent must be null)", async () => {
  const s = await makeSigner();
  assert.throws(() => encodeEnvelopeCanonical(makeEdit(s.fp, { prevRevHash: new Uint8Array(32) })));
  assert.throws(() =>
    encodeEnvelopeCanonical(
      makeMessage(s.fp, {
        reply: { parentSender: OTHER, parentScope: SCOPE, parentClientMsgID: CMID, parentEnvHash: new Uint8Array(32) },
      }),
    ),
  );
  assert.throws(() => encodeEnvelopeCanonical(makeMessage(s.fp, { senderEd25519Fp: new Uint8Array(32) })));
  assert.throws(() => encodeEnvelopeCanonical(makeMessage(s.fp, { channelID: NIL })));
});

// ---- per-field mutation --------------------------------------------------

test("per-field mutation across all three types breaks the signature", async () => {
  const s = await makeSigner();

  const msgMutations: Partial<MessageEnvelope>[] = [
    { channelID: OTHER },
    { keyVersion: 4 },
    { senderUserID: OTHER },
    { senderEd25519Fp: h32(0xee) },
    { writerScope: OTHER },
    { clientMsgID: OTHER },
    { senderTs: 1754730000001 },
    { wseq: 43 },
    { reply: { parentSender: OTHER, parentScope: SCOPE, parentClientMsgID: CMID, parentEnvHash: null } },
    { bodyText: "hello, signed world!" },
    {
      attachments: [
        {
          attachmentID: "aaaa0000-0000-0000-0000-00000000aaaa",
          attKeyVersion: 1,
          byteLen: 1,
          ciphertextSha256: h32(1),
          encMetaSha256: null,
          encPreviewSha256: null,
        },
      ],
    },
  ];
  const base = makeMessage(s.fp);
  const sigMsg = parseEnvelope(await signEnvelope(base, s.priv));
  assert.equal(sigMsg.kind, "envelope");
  if (sigMsg.kind !== "envelope") return;
  for (const m of msgMutations) {
    const mutated = encodeEnvelopeCanonical(makeMessage(s.fp, m));
    assert.notEqual(hex(mutated), hex(sigMsg.canonical));
    assert.equal(await verifyEnvelopeSig(mutated, sigMsg.sig, s.pub), false, JSON.stringify(m));
  }

  const editMutations: Partial<EditEnvelope>[] = [
    { channelID: OTHER },
    { keyVersion: 4 },
    { senderEd25519Fp: h32(0xee) },
    { clientMsgID: OTHER },
    { targetScope: OTHER },
    { targetClientMsgID: OTHER },
    { prevRevHash: h32(8) },
    { prevRevHash: null },
    { senderTs: 1 },
    { bodyText: "x" },
  ];
  const sigEdit = parseEnvelope(await signEnvelope(makeEdit(s.fp), s.priv));
  assert.equal(sigEdit.kind, "envelope");
  if (sigEdit.kind !== "envelope") return;
  for (const m of editMutations) {
    const mutated = encodeEnvelopeCanonical(makeEdit(s.fp, m));
    assert.equal(await verifyEnvelopeSig(mutated, sigEdit.sig, s.pub), false, JSON.stringify(m));
  }

  const rsMutations: Partial<ReactionSetEnvelope>[] = [
    { channelID: OTHER },
    { actorUserID: SENDER },
    { senderEd25519Fp: h32(0xee) },
    { clientMsgID: OTHER },
    { targetSender: OTHER },
    { targetEnvHash: null },
    { targetEnvHash: h32(10) },
    { prevSetHash: h32(3) },
    { senderTs: 2 },
    { emoji: ["👍"] },
    { emoji: ["🎉", "👍"] }, // order is signed
  ];
  const sigRs = parseEnvelope(await signEnvelope(makeReactionSet(s.fp), s.priv));
  assert.equal(sigRs.kind, "envelope");
  if (sigRs.kind !== "envelope") return;
  for (const m of rsMutations) {
    const mutated = encodeEnvelopeCanonical(makeReactionSet(s.fp, m));
    assert.equal(await verifyEnvelopeSig(mutated, sigRs.sig, s.pub), false, JSON.stringify(m));
  }
});

test("raw byte flips across the canonical break the signature", async () => {
  const s = await makeSigner();
  const signed = await signEnvelope(makeMessage(s.fp), s.priv);
  const parsed = parseEnvelope(signed);
  assert.equal(parsed.kind, "envelope");
  if (parsed.kind !== "envelope") return;
  for (let i = 0; i < parsed.canonical.length; i += 7) {
    const tampered = new Uint8Array(parsed.canonical);
    tampered[i] ^= 0x01;
    assert.equal(await verifyEnvelopeSig(tampered, parsed.sig, s.pub), false, `flip at ${i}`);
  }
});

// ---- cross-object / cross-channel confusion ------------------------------

test("cross-object confusion: a message signature never verifies as another type", async () => {
  const s = await makeSigner();
  const msg = makeMessage(s.fp);
  const signedMsg = parseEnvelope(await signEnvelope(msg, s.priv));
  assert.equal(signedMsg.kind, "envelope");
  if (signedMsg.kind !== "envelope") return;
  // Same field values wherever the types overlap, different objType byte.
  const edit = encodeEnvelopeCanonical(makeEdit(s.fp, { bodyText: msg.bodyText, senderTs: msg.senderTs }));
  const rs = encodeEnvelopeCanonical(makeReactionSet(s.fp, { senderTs: msg.senderTs }));
  assert.equal(await verifyEnvelopeSig(edit, signedMsg.sig, s.pub), false);
  assert.equal(await verifyEnvelopeSig(rs, signedMsg.sig, s.pub), false);
  // And flipping the objType byte in place invalidates the signature.
  const flipped = new Uint8Array(signedMsg.canonical);
  flipped[iDomain.length] = 0x02;
  assert.equal(await verifyEnvelopeSig(flipped, signedMsg.sig, s.pub), false);
});

// ---- replay identity -----------------------------------------------------

test("replay identity is (actor, writer_scope, client_msg_id) for all three types", async () => {
  const s = await makeSigner();
  const msg = makeMessage(s.fp);
  const edit = makeEdit(s.fp);
  const rs = makeReactionSet(s.fp);
  assert.equal(envelopeActor(msg), SENDER);
  assert.equal(envelopeActor(edit), SENDER);
  assert.equal(envelopeActor(rs), OTHER); // actor_user_id, not the target's sender
  assert.equal(replayIdentity(msg), `${SENDER}/${SCOPE}/${CMID}`);
  // The triple is sealed INSIDE the signed envelope: re-delivering the same
  // envelope under a new server row id cannot change it. (First-seen binding
  // and render-once land with the 83-2 dedup store.)
  const again = parseEnvelope(await signEnvelope(msg, s.priv));
  assert.equal(again.kind, "envelope");
  if (again.kind !== "envelope") return;
  assert.equal(replayIdentity(again.env), replayIdentity(msg));
});

// ---- classification ------------------------------------------------------

test("classify: retired generation labels history, never current speech", async () => {
  const s = await makeSigner();
  const parsed = parseEnvelope(await signEnvelope(makeMessage(s.fp), s.priv));
  const cls = await classifyEnvelope(parsed, OUTER_OK, resolveAs({ kind: "retired", ed25519Public: s.pub }));
  assert.equal(cls.status, "verified-former-identity");
});

test("classify: foreign fingerprint is forged", async () => {
  const s = await makeSigner();
  const parsed = parseEnvelope(await signEnvelope(makeMessage(s.fp), s.priv));
  const cls = await classifyEnvelope(parsed, OUTER_OK, resolveAs({ kind: "foreign" }));
  assert.equal(cls.status, "forged");
});

test("classify: wrong key is forged even with a matching frame", async () => {
  const s = await makeSigner();
  const eve = await makeSigner();
  const parsed = parseEnvelope(await signEnvelope(makeMessage(s.fp), s.priv));
  const cls = await classifyEnvelope(parsed, OUTER_OK, resolveAs({ kind: "current", ed25519Public: eve.pub }));
  assert.equal(cls.status, "forged");
});

test("classify: server frame relabeling is mismatch and inner wins", async () => {
  const s = await makeSigner();
  const parsed = parseEnvelope(await signEnvelope(makeMessage(s.fp), s.priv));
  const resolve = resolveAs({ kind: "current", ed25519Public: s.pub });
  for (const outer of [
    { ...OUTER_OK, channelID: OTHER },
    { ...OUTER_OK, keyVersion: 4 },
    { ...OUTER_OK, senderUserID: OTHER },
  ]) {
    const cls = await classifyEnvelope(parsed, outer, resolve);
    assert.equal(cls.status, "mismatch");
    assert.equal((cls.env as MessageEnvelope).senderUserID, SENDER); // the signed truth, for rendering
  }
});

test("classify: reaction outer sender is the ACTOR, and a relabel mismatches", async () => {
  const s = await makeSigner();
  const parsed = parseEnvelope(await signEnvelope(makeReactionSet(s.fp), s.priv));
  const resolve = resolveAs({ kind: "current", ed25519Public: s.pub });
  const ok = await classifyEnvelope(parsed, { ...OUTER_OK, senderUserID: OTHER }, resolve);
  assert.equal(ok.status, "verified"); // OTHER is the actor here
  const relabeled = await classifyEnvelope(parsed, { ...OUTER_OK, senderUserID: SENDER }, resolve);
  assert.equal(relabeled.status, "mismatch");
});

test("classify: unpinned when no pin exists or the resolver fails", async () => {
  const s = await makeSigner();
  const parsed = parseEnvelope(await signEnvelope(makeMessage(s.fp), s.priv));
  assert.equal((await classifyEnvelope(parsed, OUTER_OK, resolveAs({ kind: "unpinned" }))).status, "unpinned");
  const failing = async (): Promise<SignerResolution> => {
    throw new Error("network down");
  };
  assert.equal((await classifyEnvelope(parsed, OUTER_OK, failing)).status, "unpinned");
});

test("classify: a valid envelope transplanted to another user's frame is caught", async () => {
  // Eve (a member; she holds the space key) reuses Alice's VALID signed
  // envelope but the server frame says Eve sent it: signature verifies under
  // Alice's key, frame disagrees -> mismatch, inner (Alice) wins. If instead
  // the resolver is asked about (Eve, Alice's fp) and finds the fp is not
  // Eve's chain -> foreign -> forged. Both paths refuse the relabel.
  const alice = await makeSigner();
  const parsed = parseEnvelope(await signEnvelope(makeMessage(alice.fp), alice.priv));
  const asEve: OuterFrame = { ...OUTER_OK, senderUserID: OTHER };
  const viaTrust = await classifyEnvelope(parsed, asEve, resolveAs({ kind: "foreign" }));
  assert.equal(viaTrust.status, "forged");
  const viaFrame = await classifyEnvelope(parsed, asEve, resolveAs({ kind: "current", ed25519Public: alice.pub }));
  assert.equal(viaFrame.status, "mismatch");
});

// ---- encoder degenerate input --------------------------------------------

test("encoder throws on out-of-range scalars", async () => {
  const s = await makeSigner();
  assert.throws(() => encodeEnvelopeCanonical(makeMessage(s.fp, { keyVersion: 0 })));
  assert.throws(() => encodeEnvelopeCanonical(makeMessage(s.fp, { keyVersion: 2 ** 32 })));
  assert.throws(() => encodeEnvelopeCanonical(makeMessage(s.fp, { senderTs: -1 })));
  assert.throws(() => encodeEnvelopeCanonical(makeMessage(s.fp, { senderTs: 2 ** 53 })));
  assert.throws(() => encodeEnvelopeCanonical(makeMessage(s.fp, { wseq: 1.5 })));
  assert.throws(() =>
    encodeEnvelopeCanonical(
      makeMessage(s.fp, {
        attachments: [
          {
            attachmentID: "aaaa0000-0000-0000-0000-00000000aaaa",
            attKeyVersion: 1,
            byteLen: 0, // empty ciphertext is nonsense
            ciphertextSha256: h32(1),
            encMetaSha256: null,
            encPreviewSha256: null,
          },
        ],
      }),
    ),
  );
});
