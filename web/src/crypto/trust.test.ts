// Tests for crypto/trust.ts (82-2 identity anchoring).
//
// The property under test is the one that makes signed wraps worth anything:
// having answered "this key is Bob's" once, the server is committed to it, and
// any later substitution is refused rather than silently adopted.

import "fake-indexeddb/auto";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  pinStateFor,
  fetchTrustedIdentity,
  resolveSigner,
  markManuallyVerified,
  memberTrust,
  trusted,
} from "./trust";
import { loadVerification, saveVerification, clearVerification } from "./idb";
import type { VerificationRecord } from "./safety-number";
import type { IdentityTransport } from "./identity-sync";
import { deriveIdentity } from "./identity";

function keyFrom(seed: number): Uint8Array {
  return new Uint8Array(32).map((_, i) => (i * seed + seed) & 0xff);
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// ---- the pure state machine ---------------------------------------------

test("no record -> first_seen, and a tofu pin is written", () => {
  const k = keyFrom(1);
  const { pin, write } = pinStateFor(null, "bob", k, 1, 1000);
  assert.equal(pin, "first_seen");
  assert.equal(write?.ed25519PubB64, b64(k));
  assert.equal(write?.source, "tofu");
  assert.equal(write?.pinnedAt, 1000);
});

test("matching pin -> pinned, and nothing is rewritten", () => {
  const k = keyFrom(2);
  const stored: VerificationRecord = {
    peerUserID: "bob",
    digestHex: "",
    generation: 1,
    verifiedAt: 0,
    ed25519PubB64: b64(k),
    source: "tofu",
    pinnedAt: 1,
  };
  const { pin, write } = pinStateFor(stored, "bob", k, 1, 2000);
  assert.equal(pin, "pinned");
  assert.equal(write, null);
});

test("a manual pin reads as manually_verified, not merely pinned", () => {
  const k = keyFrom(3);
  const stored: VerificationRecord = {
    peerUserID: "bob",
    digestHex: "abc",
    generation: 1,
    verifiedAt: 5,
    ed25519PubB64: b64(k),
    source: "manual",
    pinnedAt: 1,
  };
  assert.equal(pinStateFor(stored, "bob", k, 1, 2000).pin, "manually_verified");
});

test("a different key under the same id -> changed, and the pin SURVIVES", () => {
  const pinned = keyFrom(4);
  const substituted = keyFrom(5);
  const stored: VerificationRecord = {
    peerUserID: "bob",
    digestHex: "",
    generation: 1,
    verifiedAt: 0,
    ed25519PubB64: b64(pinned),
    source: "tofu",
    pinnedAt: 1,
  };
  const { pin, write } = pinStateFor(stored, "bob", substituted, 1, 2000);
  assert.equal(pin, "changed");
  // The pin is the evidence. Overwriting it would let a server launder a
  // substitution into a fresh "pinned" on the next fetch.
  assert.equal(write, null);
});

test("a HIGHER generation does not launder a substituted key", () => {
  const pinned = keyFrom(6);
  const substituted = keyFrom(7);
  const stored: VerificationRecord = {
    peerUserID: "bob",
    digestHex: "",
    generation: 1,
    verifiedAt: 0,
    ed25519PubB64: b64(pinned),
    source: "tofu",
    pinnedAt: 1,
  };
  // generation is server-asserted, so "it rotated" is not a claim we can accept.
  assert.equal(pinStateFor(stored, "bob", substituted, 99, 2000).pin, "changed");
});

test("a pre-82 record adopts the key it first sees and keeps manual provenance", () => {
  const k = keyFrom(8);
  const legacy: VerificationRecord = {
    peerUserID: "bob",
    digestHex: "deadbeef",
    generation: 1,
    verifiedAt: 42,
  };
  const { pin, write } = pinStateFor(legacy, "bob", k, 1, 3000);
  assert.equal(pin, "manually_verified"); // pre-82 rows were only ever manual
  assert.equal(write?.ed25519PubB64, b64(k));
  assert.equal(write?.source, "manual");
  assert.equal(write?.digestHex, "deadbeef", "must not discard what the user verified");
  assert.equal(write?.verifiedAt, 42);
});

test("trusted() admits every state except changed", () => {
  assert.equal(trusted("first_seen"), true);
  assert.equal(trusted("pinned"), true);
  assert.equal(trusted("manually_verified"), true);
  assert.equal(trusted("changed"), false);
});

// ---- against the real store ---------------------------------------------

// A transport that serves whatever identity blob it is currently told to,
// standing in for a server that may lie.
function serverServing(identities: Map<string, unknown>): IdentityTransport & { calls: number } {
  const t = {
    calls: 0,
    async request<P, R>(_type: string, payload?: P): Promise<R> {
      t.calls++;
      const id = (payload as { user_id: string }).user_id;
      const blob = identities.get(id);
      return (blob ?? { found: false }) as R;
    },
  };
  return t;
}

async function identityBlobFor(mnemonicSeed: number) {
  const seed = new Uint8Array(64).map((_, i) => (i + mnemonicSeed) & 0xff);
  const ident = await deriveIdentity(seed);
  return {
    found: true,
    user_id: "ignored-by-design",
    generation: 1,
    x25519_pub: b64(ident.x25519Public),
    ed25519_pub: b64(ident.ed25519Public),
    self_sig: b64(ident.selfSig),
    _ed: ident.ed25519Public,
  };
}

test("fetchTrustedIdentity pins on first sight and holds the line afterwards", async () => {
  await clearVerification("bob");
  const real = await identityBlobFor(1);
  const server = serverServing(new Map([["bob", real]]));

  const first = await fetchTrustedIdentity(server, "bob");
  assert.equal(first?.pin, "first_seen");
  assert.equal(first?.identity.userID, "bob", "must use the id we asked for, not the echo");

  const second = await fetchTrustedIdentity(server, "bob");
  assert.equal(second?.pin, "pinned");

  // The server now substitutes a different, internally-valid identity.
  const fake = await identityBlobFor(2);
  const hostile = serverServing(new Map([["bob", fake]]));
  const third = await fetchTrustedIdentity(hostile, "bob");
  assert.equal(third?.pin, "changed");

  // And the original pin is still what is stored.
  const rec = await loadVerification("bob");
  assert.equal(rec?.ed25519PubB64, b64(real._ed));
});

test("fetchTrustedIdentity ignores a server user_id echo that differs", async () => {
  await clearVerification("carol");
  const blob = await identityBlobFor(3);
  blob.user_id = "mallory"; // the server claims this is someone else
  const server = serverServing(new Map([["carol", blob]]));
  const got = await fetchTrustedIdentity(server, "carol");
  assert.equal(got?.identity.userID, "carol");
});

test("resolveSigner finds the pinned owner and makes no network calls", async () => {
  await clearVerification("dave");
  await clearVerification("erin");
  const dave = keyFrom(11);
  const erin = keyFrom(12);
  await saveVerification({
    peerUserID: "dave", digestHex: "", generation: 1, verifiedAt: 0,
    ed25519PubB64: b64(dave), source: "tofu", pinnedAt: 1,
  });
  await saveVerification({
    peerUserID: "erin", digestHex: "x", generation: 1, verifiedAt: 9,
    ed25519PubB64: b64(erin), source: "manual", pinnedAt: 1,
  });

  assert.deepEqual(await resolveSigner(dave, ["dave", "erin"]), { userID: "dave", pin: "pinned" });
  assert.deepEqual(await resolveSigner(erin, ["dave", "erin"]), { userID: "erin", pin: "manually_verified" });
  // An unknown key belongs to nobody -- the warm path relies on this.
  assert.equal(await resolveSigner(keyFrom(13), ["dave", "erin"]), null);
  // A key we know, but not among the candidates offered.
  assert.equal(await resolveSigner(dave, ["erin"]), null);
});

test("resolveSigner ignores pre-82 records that carry no pinned key", async () => {
  await clearVerification("frank");
  await saveVerification({ peerUserID: "frank", digestHex: "old", generation: 1, verifiedAt: 1 });
  assert.equal(await resolveSigner(keyFrom(14), ["frank"]), null);
});

test("markManuallyVerified upgrades a tofu pin and never downgrades", async () => {
  await clearVerification("grace");
  const k = keyFrom(15);
  await saveVerification({
    peerUserID: "grace", digestHex: "", generation: 1, verifiedAt: 0,
    ed25519PubB64: b64(k), source: "tofu", pinnedAt: 77,
  });

  await markManuallyVerified("grace", k, "cafebabe", 1);
  const rec = await loadVerification("grace");
  assert.equal(rec?.source, "manual");
  assert.equal(rec?.digestHex, "cafebabe");
  assert.equal(rec?.pinnedAt, 77, "original first-sight time is preserved");

  // A later TOFU sighting must not knock it back down to "pinned".
  const { pin, write } = pinStateFor(rec!, "grace", k, 1, 9999);
  assert.equal(pin, "manually_verified");
  assert.equal(write, null);
});

// ---- 82-8: the badge the panel actually shows ----------------------------
//
// The regression this function exists for: a TOFU record carries digestHex "",
// and feeding that to verificationState() reads as "changed". From 82-2 until
// 82-8 every peer therefore showed "key changed" the first time you opened the
// members panel -- the loudest badge in the product, shown by default, which
// is how a real one gets ignored.

const DIGEST = "aabbcc";

function rec(over: Partial<VerificationRecord> = {}): VerificationRecord {
  return {
    peerUserID: "bob",
    digestHex: DIGEST,
    generation: 1,
    verifiedAt: 1000,
    ed25519PubB64: b64(keyFrom(1)),
    source: "manual",
    pinnedAt: 1000,
    ...over,
  };
}

test("a TOFU pin reads as pinned, NOT as changed", () => {
  // Exactly what fetchTrustedIdentity writes on first sight.
  const tofu = rec({ digestHex: "", verifiedAt: 0, source: "tofu" });
  assert.equal(memberTrust("first_seen", DIGEST, tofu), "pinned");
  assert.equal(memberTrust("pinned", DIGEST, tofu), "pinned");
});

test("an out-of-band verification whose digest still matches reads verified", () => {
  assert.equal(memberTrust("manually_verified", DIGEST, rec()), "verified");
});

test("a verified peer whose digest moved reads changed", () => {
  assert.equal(memberTrust("manually_verified", "ffffff", rec()), "changed");
});

test("a repudiated pin outranks the digest comparison", () => {
  // The digest would say "verified"; the pin says "not who you pinned", which
  // is the graver claim and must win.
  assert.equal(memberTrust("changed", DIGEST, rec()), "changed");
  assert.equal(memberTrust("changed", DIGEST, null), "changed");
});

test("no record at all reads unverified", () => {
  assert.equal(memberTrust("first_seen", DIGEST, null), "unverified");
});

// End-to-end against the real store: pin a peer, then ask what the panel would
// show. This is the path that was broken, so it is worth asserting whole.
test("first sight of a peer shows pinned, not changed", async () => {
  await clearVerification("carol");
  const id = await deriveIdentity(new Uint8Array(64).fill(7));
  const ws: IdentityTransport = {
    async request() {
      return {
        found: true,
        user_id: "carol",
        generation: 1,
        x25519_pub: b64(id.x25519Public),
        ed25519_pub: b64(id.ed25519Public),
        self_sig: b64(id.selfSig),
      } as never;
    },
  };
  const seen = await fetchTrustedIdentity(ws, "carol");
  assert.ok(seen);
  assert.equal(seen!.pin, "first_seen");
  const stored = await loadVerification("carol");
  assert.equal(memberTrust(seen!.pin, DIGEST, stored), "pinned");
});
