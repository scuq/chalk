// Tests for crypto/innerchan.ts -- 83-6. The known-answer test reproduces
// internal/innerchan's TestKnownAnswer from the same fixed inputs: the
// transcript hash must match, the Go-produced signature must verify, and
// the Go-sealed frame must open -- two implementations agreeing on every
// byte of the frozen construction.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { startClientHandshake, transcriptHash, deriveSession, serverFingerprint } from "./innerchan";

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function unhex(s: string): Uint8Array {
  return new Uint8Array(s.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
}
const fill = (b: number) => new Uint8Array(32).fill(b);

const PKCS8_ED25519 = unhex("302e020100300506032b657004220420");
async function ed25519PubFromSeed(seed: Uint8Array): Promise<{ pub: Uint8Array; priv: CryptoKey }> {
  const pkcs8 = new Uint8Array(PKCS8_ED25519.length + 32);
  pkcs8.set(PKCS8_ED25519, 0);
  pkcs8.set(seed, PKCS8_ED25519.length);
  const tmp = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", tmp);
  const b64 = jwk.x!.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const pub = new Uint8Array([...bin].map((c) => c.charCodeAt(0)));
  const priv = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  return { pub, priv };
}

async function x25519PubFromScalar(scalar: Uint8Array): Promise<Uint8Array> {
  const hs = await startClientHandshake({ ephSeed: scalar, nonce: fill(0) });
  return hs.hello.clientEphPub;
}

// Values asserted by internal/innerchan/innerchan_test.go TestKnownAnswer.
const KAT = {
  transcript: "5f33db1397e149e700d156a90fcc77da723e639da0b24023b863996b0effed20",
  frame: "0000000000000001a641c79613e5e8ea5dbcfde7486a901fd3daf5b943a36cce5aaa6d90",
  sig: "64f58b3b5cc056f6203a62400dc87b79a5c83e8c795b214bb5d8d330684b6dc42c65fdae068f5a06201f6520b1d5b81c71c8b7fdae810746881a6380dad0c30e",
};

test("known answer: transcript, signature and a Go-sealed frame agree byte for byte", async () => {
  const serverEphPub = await x25519PubFromScalar(fill(0x22));
  const server = await ed25519PubFromSeed(fill(0x33));
  const hs = await startClientHandshake({ ephSeed: fill(0x11), nonce: fill(0x44) });
  const th = await transcriptHash(hs.hello.clientEphPub, serverEphPub, hs.hello.clientNonce, server.pub);
  assert.equal(hex(th), KAT.transcript);
  // finish() verifies the Go signature and derives the same keys
  const sess = await hs.finish(serverEphPub, server.pub, unhex(KAT.sig), server.pub);
  const pt = await sess.open(unhex(KAT.frame));
  assert.equal(new TextDecoder().decode(pt), "known answer");
});

test("finish refuses a bad signature, a substituted key, and a non-pinned key", async () => {
  const serverEphPub = await x25519PubFromScalar(fill(0x22));
  const server = await ed25519PubFromSeed(fill(0x33));
  const other = await ed25519PubFromSeed(fill(0x55));
  const hs = await startClientHandshake({ ephSeed: fill(0x11), nonce: fill(0x44) });
  const badSig = unhex(KAT.sig);
  badSig[10] ^= 1;
  await assert.rejects(hs.finish(serverEphPub, server.pub, badSig, null));
  // MITM presents its own key: the signature was made by the real server
  await assert.rejects(hs.finish(serverEphPub, other.pub, unhex(KAT.sig), null));
  // valid signature, but not the key we pinned -> the wall
  await assert.rejects(hs.finish(serverEphPub, server.pub, unhex(KAT.sig), other.pub), /not the pinned key/);
  // TOFU (no pin) accepts
  await hs.finish(serverEphPub, server.pub, unhex(KAT.sig), null);
});

test("counters: replay and reordering of inbound frames are refused; outbound increases", async () => {
  // Build two sessions from the same secret so we can seal "as the server"
  // using the mirror trick: a session's c2s key sealed by one side is the
  // other's s2c only if derived with swapped infos -- so instead exercise
  // the inbound path with the KAT frame and its own counter rules.
  const serverEphPub = await x25519PubFromScalar(fill(0x22));
  const server = await ed25519PubFromSeed(fill(0x33));
  const hs = await startClientHandshake({ ephSeed: fill(0x11), nonce: fill(0x44) });
  const sess = await hs.finish(serverEphPub, server.pub, unhex(KAT.sig), null);
  const frame = unhex(KAT.frame);
  await sess.open(frame);
  await assert.rejects(sess.open(frame), /counter/); // replay
  const ctr2 = unhex(KAT.frame);
  ctr2[7] = 3; // skip ahead
  await assert.rejects(sess.open(ctr2), /counter/);
  // tampered ciphertext with the right counter
  const t = unhex(KAT.frame);
  t[7] = 2;
  t[t.length - 1] ^= 1;
  await assert.rejects(sess.open(t), /authenticate/);
  // outbound counters 1, 2, 3 ...
  const a = await sess.seal(new Uint8Array([1]));
  const b = await sess.seal(new Uint8Array([2]));
  assert.equal(a[7], 1);
  assert.equal(b[7], 2);
});

test("deriveSession is deterministic and fingerprint formats as chalkctl prints it", async () => {
  const th = fill(9);
  const ss = fill(7);
  const s1 = await deriveSession(ss, th);
  const s2 = await deriveSession(ss, th);
  const f1 = await s1.seal(new Uint8Array([42]));
  const f2 = await s2.seal(new Uint8Array([42]));
  assert.equal(hex(f1), hex(f2));
  const fp = await serverFingerprint(fill(1));
  assert.match(fp, /^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
});
