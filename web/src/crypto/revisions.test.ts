// Tests for crypto/revisions.ts -- 83-3 revision-chain verification.
//
// Builds a real signed chain (original 0x01, then edits 0x02 each hashing
// its predecessor) and asserts the walk accepts exactly it: withheld,
// reordered, retargeted, relinked and wrong-key chains all fail closed.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  OBJ_MESSAGE,
  OBJ_EDIT,
  signEnvelope,
  envelopeObjectHash,
  type MessageEnvelope,
  type EditEnvelope,
} from "./envelope";
import { verifyRevisionChain, classifyLiveEdit } from "./revisions";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const CH = "11111111-2222-4333-8444-555555555555";
const SCOPE = "99999999-0000-4000-8000-000000000009";
const CMID = "cccccccc-0000-4000-8000-00000000000c";

interface Signer {
  priv: CryptoKey;
  pub: Uint8Array;
}

async function makeSigner(): Promise<Signer> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
  return { priv: kp.privateKey, pub: new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)) };
}

function fp32(): Uint8Array {
  return new Uint8Array(32).fill(7);
}

function original(): MessageEnvelope {
  return {
    objType: OBJ_MESSAGE,
    channelID: CH,
    keyVersion: 1,
    senderUserID: ALICE,
    senderEd25519Fp: fp32(),
    writerScope: SCOPE,
    clientMsgID: CMID,
    senderTs: 1,
    wseq: 1,
    reply: null,
    bodyText: "v0",
    attachments: [],
  };
}

function edit(prevHash: Uint8Array, body: string, n: number): EditEnvelope {
  return {
    objType: OBJ_EDIT,
    channelID: CH,
    keyVersion: 1,
    senderUserID: ALICE,
    senderEd25519Fp: fp32(),
    writerScope: SCOPE,
    clientMsgID: `0000000${n}-0000-4000-8000-000000000000`,
    targetSender: ALICE,
    targetScope: SCOPE,
    targetClientMsgID: CMID,
    prevRevHash: prevHash,
    senderTs: 1 + n,
    bodyText: body,
    attachments: [],
  };
}

// Builds: revisions = [signed original, signed edit v1], current = signed
// edit v2. That is exactly what the server hands back after two edits.
async function makeChain(s: Signer) {
  const rev1 = await signEnvelope(original(), s.priv);
  const h1 = await envelopeObjectHash(rev1);
  const rev2 = await signEnvelope(edit(h1, "v1", 1), s.priv);
  const h2 = await envelopeObjectHash(rev2);
  const current = await signEnvelope(edit(h2, "v2", 2), s.priv);
  return { revisions: [rev1, rev2], current, h1, h2 };
}

test("a genuine two-edit chain verifies and recovers the original hash", async () => {
  const s = await makeSigner();
  const { revisions, current, h1 } = await makeChain(s);
  const res = await verifyRevisionChain(revisions, current, s.pub);
  assert.equal(res.ok, true);
  assert.equal(res.originalHashHex, [...h1].map((x) => x.toString(16).padStart(2, "0")).join(""));
  assert.equal(res.originalEnv?.bodyText, "v0");
});

test("withheld ancestry fails closed", async () => {
  const s = await makeSigner();
  const { revisions, current } = await makeChain(s);
  assert.equal((await verifyRevisionChain([], current, s.pub)).ok, false);
  assert.equal((await verifyRevisionChain([revisions[0]], current, s.pub)).ok, false); // middle missing
});

test("reordered revisions fail", async () => {
  const s = await makeSigner();
  const { revisions, current } = await makeChain(s);
  assert.equal((await verifyRevisionChain([revisions[1], revisions[0]], current, s.pub)).ok, false);
});

test("a broken hash link fails", async () => {
  const s = await makeSigner();
  const { revisions, h1 } = await makeChain(s);
  // current claims to extend rev1 directly, skipping rev2
  const skipping = await signEnvelope(edit(h1, "v2", 2), s.priv);
  assert.equal((await verifyRevisionChain(revisions, skipping, s.pub)).ok, false);
});

test("a chain signed by another key fails", async () => {
  const s = await makeSigner();
  const eve = await makeSigner();
  const { revisions, current } = await makeChain(s);
  assert.equal((await verifyRevisionChain(revisions, current, eve.pub)).ok, false);
});

test("a chain whose original targets a different message fails", async () => {
  const s = await makeSigner();
  const { current } = await makeChain(s);
  // rebuild rev1 with a different clientMsgID: current's target no longer matches
  const otherOrig = { ...original(), clientMsgID: "dddddddd-0000-4000-8000-00000000000d" };
  const rev1 = await signEnvelope(otherOrig, s.priv);
  const h1 = await envelopeObjectHash(rev1);
  const rev2 = await signEnvelope(edit(h1, "v1", 1), s.priv); // still targets CMID -> mismatch inside chain too
  assert.equal((await verifyRevisionChain([rev1, rev2], current, s.pub)).ok, false);
});

test("an edit of a legacy original (null prev link) is unverifiable", async () => {
  const s = await makeSigner();
  const e = edit(new Uint8Array(32).fill(1), "v1", 1);
  e.prevRevHash = null; // legacy original: nothing to walk back to
  const current = await signEnvelope(e, s.priv);
  assert.equal((await verifyRevisionChain([], current, s.pub)).ok, false);
});

test("classifyLiveEdit: extend vs fork vs unknown", () => {
  assert.equal(classifyLiveEdit("aa", "aa"), "verified");
  assert.equal(classifyLiveEdit("aa", "bb"), "forked");
  assert.equal(classifyLiveEdit(null, "aa"), "unknown");
  assert.equal(classifyLiveEdit("aa", undefined), "unknown");
});
