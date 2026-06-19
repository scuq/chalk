// Tests for src/crypto/identity-sync.ts. Uses a fake transport (no socket)
// to exercise the publish payload shape and -- most importantly -- the
// verify-on-fetch security behavior: a tampered or substituted identity
// must come back as null, never as usable keys.
//
// Run via `node test.mjs` from web/.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { publishIdentity, fetchIdentity, type IdentityTransport } from "./identity-sync";
import { deriveIdentity } from "./identity";

function hexToBytes(h: string): Uint8Array {
  const o = new Uint8Array(h.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16);
  return o;
}
const SEED = hexToBytes(
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" +
    "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f",
);
function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// A fake transport that records the last request and returns a canned ack.
function fakeTransport(ack: unknown): IdentityTransport & { lastType?: string; lastPayload?: unknown } {
  const t: IdentityTransport & { lastType?: string; lastPayload?: unknown } = {
    async request<P, R>(type: string, payload?: P): Promise<R> {
      t.lastType = type;
      t.lastPayload = payload;
      return ack as R;
    },
  };
  return t;
}

test("publishIdentity sends correct frame type + base64 fields, returns generation", async () => {
  const id = await deriveIdentity(SEED);
  const ws = fakeTransport({ generation: 1 });
  const gen = await publishIdentity(ws, id);
  assert.equal(gen, 1);
  assert.equal(ws.lastType, "publish_identity");
  const p = ws.lastPayload as Record<string, unknown>;
  assert.equal(p.generation, 1);
  assert.equal(p.x25519_pub, b64(id.x25519Public));
  assert.equal(p.ed25519_pub, b64(id.ed25519Public));
  assert.equal(p.self_sig, b64(id.selfSig));
});

test("fetchIdentity returns a verified peer identity for a genuine record", async () => {
  const id = await deriveIdentity(SEED);
  const ws = fakeTransport({
    found: true,
    user_id: "peer-1",
    generation: 1,
    x25519_pub: b64(id.x25519Public),
    ed25519_pub: b64(id.ed25519Public),
    self_sig: b64(id.selfSig),
  });
  const peer = await fetchIdentity(ws, "peer-1");
  assert.notEqual(peer, null);
  assert.equal(peer!.userID, "peer-1");
  assert.equal(peer!.x25519Public.length, 32);
  assert.equal(ws.lastType, "fetch_identity");
  assert.deepEqual(ws.lastPayload, { user_id: "peer-1" });
});

test("fetchIdentity returns null when the X25519 key was substituted (self-sig fails)", async () => {
  const id = await deriveIdentity(SEED);
  const tampered = id.x25519Public.slice();
  tampered[0] ^= 1; // server swapped the encryption key
  const ws = fakeTransport({
    found: true,
    user_id: "peer-1",
    generation: 1,
    x25519_pub: b64(tampered),
    ed25519_pub: b64(id.ed25519Public),
    self_sig: b64(id.selfSig),
  });
  assert.equal(await fetchIdentity(ws, "peer-1"), null);
});

test("fetchIdentity returns null when found is false", async () => {
  const ws = fakeTransport({ found: false, user_id: "peer-1" });
  assert.equal(await fetchIdentity(ws, "peer-1"), null);
});

test("fetchIdentity returns null when key fields are missing", async () => {
  const ws = fakeTransport({ found: true, user_id: "peer-1", generation: 1 });
  assert.equal(await fetchIdentity(ws, "peer-1"), null);
});

test("fetchIdentity returns null on malformed base64", async () => {
  const id = await deriveIdentity(SEED);
  const ws = fakeTransport({
    found: true,
    user_id: "peer-1",
    generation: 1,
    x25519_pub: "!!!not base64!!!",
    ed25519_pub: b64(id.ed25519Public),
    self_sig: b64(id.selfSig),
  });
  assert.equal(await fetchIdentity(ws, "peer-1"), null);
});

test("round-trip: publish then fetch the same identity verifies", async () => {
  const id = await deriveIdentity(SEED);
  // simulate the server echoing back what publish stored
  const pub = fakeTransport({ generation: 1 });
  await publishIdentity(pub, id);
  const stored = pub.lastPayload as { x25519_pub: string; ed25519_pub: string; self_sig: string };
  const fetchWs = fakeTransport({
    found: true,
    user_id: "self",
    generation: 1,
    x25519_pub: stored.x25519_pub,
    ed25519_pub: stored.ed25519_pub,
    self_sig: stored.self_sig,
  });
  const peer = await fetchIdentity(fetchWs, "self");
  assert.notEqual(peer, null);
});
