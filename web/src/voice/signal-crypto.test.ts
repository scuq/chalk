// Tests for src/voice/signal-crypto.ts (30-4). Runs under `node test.mjs`
// (esbuild transpile + node --test; node's WebCrypto supports Ed25519, the
// same surface the identity tests already rely on).
//
// RTCPeerConnection does not exist under node, so the mesh manager itself
// (call.ts) is exercised in the browser gate (§7d relay-only call); here we
// pin down the two pure layers it depends on: the encrypted envelope and the
// fingerprint signature scheme.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  extractFingerprints,
  canonicalFingerprintMessage,
  signFingerprints,
  verifyFingerprints,
  sealSignal,
  openSignal,
  bytesToBase64,
  type FingerprintContext,
  type VoiceEnvelopeCrypto,
} from "./signal-crypto";

// ---- fixtures --------------------------------------------------------------

const SAMPLE_SDP = [
  "v=0",
  "o=- 46117317 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "c=IN IP4 0.0.0.0",
  "a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89",
  "a=mid:0",
].join("\r\n");

const CTX: FingerprintContext = {
  channelID: "11111111-1111-1111-1111-111111111111",
  fromUser: "22222222-2222-2222-2222-222222222222",
  fromDevice: "33333333-3333-3333-3333-333333333333",
  toUser: "44444444-4444-4444-4444-444444444444",
  toDevice: "55555555-5555-5555-5555-555555555555",
};

async function genEd25519(): Promise<{ priv: CryptoKey; pubRaw: Uint8Array }> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { priv: kp.privateKey, pubRaw };
}

// A fake envelope cipher: XOR with a keyVersion-derived byte. Enough to prove
// sealSignal/openSignal plumb bytes, base64, and the version faithfully.
function fakeCrypto(currentVersion: number, waiting = false): VoiceEnvelopeCrypto {
  const xor = (v: number, b: Uint8Array): Uint8Array => {
    const out = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) out[i] = b[i] ^ (v & 0xff);
    return out;
  };
  return {
    async encryptBytesForChannel(_cid, bytes) {
      if (waiting) return { kind: "waiting" };
      return { kind: "encrypted", ciphertext: xor(currentVersion, bytes), keyVersion: currentVersion };
    },
    async decryptBytesForChannel(_cid, keyVersion, ct) {
      if (keyVersion !== currentVersion) return null; // unknown version
      return xor(keyVersion, ct);
    },
  };
}

// ---- fingerprint extraction ------------------------------------------------

test("extractFingerprints finds session- and media-level lines in order", () => {
  const fps = extractFingerprints(SAMPLE_SDP);
  assert.equal(fps.length, 2);
  assert.ok(fps[0].startsWith("sha-256 AB:CD:EF"));
  assert.equal(fps[0], fps[1]);
});

test("extractFingerprints returns empty for SDP without fingerprints", () => {
  assert.deepEqual(extractFingerprints("v=0\r\ns=-\r\nm=audio 9 RTP/AVP 0"), []);
});

test("canonical message binds context: different channel -> different bytes", () => {
  const fps = extractFingerprints(SAMPLE_SDP);
  const a = canonicalFingerprintMessage(CTX, fps);
  const b = canonicalFingerprintMessage(
    { ...CTX, channelID: "99999999-9999-9999-9999-999999999999" },
    fps,
  );
  assert.notEqual(Buffer.from(a).toString("hex"), Buffer.from(b).toString("hex"));
});

// ---- sign / verify ---------------------------------------------------------

test("fingerprint sign/verify roundtrip", async () => {
  const { priv, pubRaw } = await genEd25519();
  const fps = extractFingerprints(SAMPLE_SDP);
  const sig = await signFingerprints(priv, CTX, fps);
  assert.equal(await verifyFingerprints(pubRaw, CTX, fps, sig), true);
});

test("verify fails on context swap (reverse direction = replay attempt)", async () => {
  const { priv, pubRaw } = await genEd25519();
  const fps = extractFingerprints(SAMPLE_SDP);
  const sig = await signFingerprints(priv, CTX, fps);
  const reversed: FingerprintContext = {
    channelID: CTX.channelID,
    fromUser: CTX.toUser,
    fromDevice: CTX.toDevice,
    toUser: CTX.fromUser,
    toDevice: CTX.fromDevice,
  };
  assert.equal(await verifyFingerprints(pubRaw, reversed, fps, sig), false);
});

test("verify fails on fingerprint substitution (the MITM case)", async () => {
  const { priv, pubRaw } = await genEd25519();
  const fps = extractFingerprints(SAMPLE_SDP);
  const sig = await signFingerprints(priv, CTX, fps);
  const swapped = fps.map((f) => f.replace("AB:CD", "DE:AD"));
  assert.equal(await verifyFingerprints(pubRaw, CTX, swapped, sig), false);
});

test("verify fails with the wrong public key", async () => {
  const alice = await genEd25519();
  const mallory = await genEd25519();
  const fps = extractFingerprints(SAMPLE_SDP);
  const sig = await signFingerprints(alice.priv, CTX, fps);
  assert.equal(await verifyFingerprints(mallory.pubRaw, CTX, fps, sig), false);
});

test("verify fails on garbage signature / empty fingerprint list", async () => {
  const { pubRaw } = await genEd25519();
  const fps = extractFingerprints(SAMPLE_SDP);
  assert.equal(await verifyFingerprints(pubRaw, CTX, fps, "!!!not-base64!!!"), false);
  assert.equal(await verifyFingerprints(pubRaw, CTX, [], bytesToBase64(new Uint8Array(64))), false);
});

test("signFingerprints refuses an SDP without fingerprints", async () => {
  const { priv } = await genEd25519();
  await assert.rejects(() => signFingerprints(priv, CTX, []));
});

// ---- envelope --------------------------------------------------------------

test("sealSignal/openSignal roundtrip carries object + version", async () => {
  const cc = fakeCrypto(3);
  const obj = { sdp: "v=0", fp_sig: "abc" };
  const sealed = await sealSignal(cc, CTX.channelID, obj);
  assert.ok(sealed);
  assert.equal(sealed!.v, 3);
  const opened = await openSignal(cc, CTX.channelID, sealed!);
  assert.deepEqual(opened, obj);
});

test("sealSignal returns null while the space key is waiting (fail-closed)", async () => {
  const cc = fakeCrypto(1, true);
  assert.equal(await sealSignal(cc, CTX.channelID, { x: 1 }), null);
});

test("openSignal returns null on unknown version, bad base64, malformed shape", async () => {
  const cc = fakeCrypto(2);
  const sealed = await sealSignal(cc, CTX.channelID, { hello: "world" });
  assert.ok(sealed);
  assert.equal(await openSignal(cc, CTX.channelID, { v: 999, ct: sealed!.ct }), null);
  assert.equal(await openSignal(cc, CTX.channelID, { v: 2, ct: "%%%" }), null);
  assert.equal(
    await openSignal(cc, CTX.channelID, { v: "2", ct: sealed!.ct } as unknown as {
      v: number;
      ct: string;
    }),
    null,
  );
});
