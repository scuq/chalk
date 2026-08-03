// Tests for crypto/channel-crypto.ts -- the per-channel encryption brain.
// Uses real derived identities (so wrap/unwrap + self-sig verification are
// genuine) published into a fake in-memory server, plus fake-indexeddb for
// the key cache. This validates the actual cross-user flow end to end in
// Node, before any browser: Alice (creator) bootstraps, Bob gets auto-
// rewrapped, Bob unwraps + decrypts Alice's message.

import "fake-indexeddb/auto";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { ChannelCrypto, type CryptoTransport, type ChannelCryptoIdentity, CURRENT_KEY_VERSION } from "./channel-crypto";
import { deriveIdentityFromMnemonic } from "./identity";
import { generateMnemonic } from "./bip39";
import { clearSpaceKeys, clearVerification, loadSpaceKey } from "./idb";
import { generateSpaceKey, wrapSpaceKeyUnsigned, wrapSpaceKeySigned, decryptMessage } from "./spacekey";

// A fake server: channel_keys table + identity_keys table, speaking the same
// frames as internal/server/ws.go. The "caller" identity is set per ChannelCrypto
// instance via its own userID in payloads, so we model multiple users by
// sharing one server across instances.
function makeServer() {
  const channelKeys = new Map<string, { suite: number; blobB64: string }>(); // "c:v:r"
  const identities = new Map<string, { x: string; e: string; s: string; gen: number }>();
  const ck = (c: string, v: number, r: string) => `${c}:${v}:${r}`;

  function transportFor(): CryptoTransport {
    return {
      async request(type: string, p: any): Promise<any> {
        switch (type) {
          case "publish_identity":
            identities.set(p.__caller, { x: p.x25519_pub, e: p.ed25519_pub, s: p.self_sig, gen: p.generation ?? 1 });
            return { generation: p.generation ?? 1 };
          case "fetch_identity": {
            const r = identities.get(p.user_id);
            if (!r) return { found: false, user_id: p.user_id };
            return { found: true, user_id: p.user_id, generation: r.gen, x25519_pub: r.x, ed25519_pub: r.e, self_sig: r.s };
          }
          case "publish_channel_key":
            channelKeys.set(ck(p.channel_id, p.key_version, p.recipient_id), { suite: p.wrap_suite, blobB64: p.blob });
            return { channel_id: p.channel_id, key_version: p.key_version, recipient_id: p.recipient_id };
          case "fetch_channel_key": {
            // recipient is always the caller
            const row = channelKeys.get(ck(p.channel_id, p.key_version, p.__caller));
            if (!row) return { found: false, channel_id: p.channel_id };
            return { found: true, channel_id: p.channel_id, key_version: p.key_version, wrap_suite: row.suite, blob: row.blobB64 };
          }
          case "fetch_channel_key_recipients": {
            const out: string[] = [];
            const suites: Record<string, number> = {};
            for (const [k, row] of channelKeys) {
              const [c, v, r] = k.split(":");
              if (c === p.channel_id && Number(v) === p.key_version) {
                out.push(r);
                suites[r] = row.suite; // 82-6
              }
            }
            return { channel_id: p.channel_id, key_version: p.key_version, recipients: out, wrap_suites: suites };
          }
        }
        throw new Error("unexpected " + type);
      },
    };
  }
  return { transportFor, channelKeys, identities };
}

// Build a ChannelCrypto for a freshly derived identity, and publish that
// identity to the shared server. Wraps the transport so every request carries
// __caller = this user's id (the fake server uses it as the authenticated user).
async function makeUser(server: ReturnType<typeof makeServer>, userID: string) {
  const id = await deriveIdentityFromMnemonic(await generateMnemonic());
  const base = server.transportFor();
  const transport: CryptoTransport = {
    request: (type, payload) => base.request(type, { ...(payload as any), __caller: userID }),
  };
  // publish identity so peers can fetch + verify it
  await transport.request("publish_identity", {
    generation: id.generation,
    x25519_pub: bytesToBase64(id.x25519Public),
    ed25519_pub: bytesToBase64(id.ed25519Public),
    self_sig: bytesToBase64(id.selfSig),
  });
  const identity: ChannelCryptoIdentity = {
    userID,
    x25519Private: id.x25519Private,
    x25519Public: id.x25519Public,
    // 82-3: real signing material, not a stub -- 82-4 signs every wrap it
    // produces, and this fixture is what proves the signatures verify.
    ed25519Private: id.ed25519Private,
    ed25519Public: id.ed25519Public,
  };
  // short key-wait so deferred-decrypt tests are fast + deterministic
  return new ChannelCrypto(transport, identity, { keyWaitMs: 50 });
}

// A device with nothing remembered: no cached space keys AND no identity pins.
//
// Both halves are needed since 82-5, and the second is easy to forget. Every
// test here derives FRESH identities but reuses the ids "alice"/"bob"/"carol",
// while fake-indexeddb is one database for the whole process. Now that wraps
// are signed, opening one pins its signer -- so a pin left by an earlier test
// names a DIFFERENT key under the same id, which trust.ts correctly reads as a
// substitution and refuses. Real devices have neither problem (user ids are
// uuids, and each device has its own store), so this is fixture hygiene, not a
// behaviour under test.
async function freshDevice(): Promise<void> {
  await clearSpaceKeys();
  for (const id of ["alice", "bob", "carol"]) await clearVerification(id);
}

function bytesToBase64(b: Uint8Array): string {
  let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const CH = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

test("creator bootstraps a keyless channel -> ready, and can encrypt", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, "alice");

  const status = await alice.ensureChannelKey(CH, ["alice"], "alice");
  assert.equal(status, "ready");
  assert.equal(alice.hasKey(CH), true);

  const enc = await alice.encryptForChannel(CH, "hello world");
  assert.equal(enc.kind, "encrypted");
});

test("non-creator on a keyless channel is blocked (waiting), never plaintext", async () => {
  await freshDevice();
  const server = makeServer();
  const bob = await makeUser(server, "bob");
  // channel created by alice; bob opens first, no key exists yet. Fail-closed:
  // bob waits for the creator to bootstrap -- he can NOT send plaintext.
  const status = await bob.ensureChannelKey(CH, ["alice", "bob"], "alice");
  assert.equal(status, "waiting");
  const enc = await bob.encryptForChannel(CH, "hi");
  assert.equal(enc.kind, "waiting");
});

test("end-to-end: Alice (creator) bootstraps + rewraps for Bob; Bob unwraps + decrypts", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  const bob = await makeUser(server, "bob");
  const members = ["alice", "bob"];

  // Alice opens: bootstraps the key and auto-rewraps for Bob.
  const aStatus = await alice.ensureChannelKey(CH, members, "alice");
  assert.equal(aStatus, "ready");

  // Alice encrypts a message.
  const enc = await alice.encryptForChannel(CH, "secret for the channel");
  assert.equal(enc.kind, "encrypted");
  const keyVersion = enc.kind === "encrypted" ? enc.keyVersion : 0;
  const body = enc.kind === "encrypted" ? enc.body : "";

  // Bob is a different browser: clear the shared test cache so he must
  // genuinely fetch + unwrap his own wrap (not read Alice's cached key).
  await freshDevice();

  // Bob opens: Alice already wrapped the key for him, so he's ready.
  const bStatus = await bob.ensureChannelKey(CH, members, "alice");
  assert.equal(bStatus, "ready");
  assert.equal(bob.hasKey(CH), true);

  // Bob decrypts Alice's message.
  const text = await bob.decryptForChannel(CH, keyVersion, body);
  assert.equal(text, "secret for the channel");
});

test("waiting: encrypted channel, member opens before being wrapped for -> waiting, send blocked", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  // Carol exists but is NOT yet a member when Alice bootstraps, so Alice
  // doesn't wrap for her.
  const carol = await makeUser(server, "carol");

  await alice.ensureChannelKey(CH, ["alice"], "alice"); // only alice is a member

  // The idb space-key cache is per-browser; Alice and Carol are different
  // browsers, so clear the shared test cache to isolate Carol's view.
  await freshDevice();

  // Carol is later added; she opens but Alice hasn't rewrapped for her yet.
  const cStatus = await carol.ensureChannelKey(CH, ["alice", "carol"], "alice");
  assert.equal(cStatus, "waiting");
  const enc = await carol.encryptForChannel(CH, "blocked");
  assert.equal(enc.kind, "waiting");
});

test("deferred decrypt: a message arriving before the key resolves once the key lands", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  const bob = await makeUser(server, "bob");
  const members = ["alice", "bob"];

  // Alice bootstraps + rewraps for Bob, then encrypts a message.
  await alice.ensureChannelKey(CH, members, "alice");
  const enc = await alice.encryptForChannel(CH, "hello bob");
  assert.equal(enc.kind, "encrypted");
  const body = enc.kind === "encrypted" ? enc.body : "";
  const kv = enc.kind === "encrypted" ? enc.keyVersion : 0;

  await freshDevice(); // Bob is a different browser

  // Bob starts decrypting BEFORE he has the key (channel not settled yet);
  // the decrypt should defer, not immediately placeholder.
  const decryptP = bob.decryptForChannel(CH, kv, body);
  // Now Bob's ensureChannelKey runs (fetches + unwraps his wrap), settling the
  // key and waking the deferred decrypt.
  await bob.ensureChannelKey(CH, members, "alice");
  const text = await decryptP;
  assert.equal(text, "hello bob"); // resolved, not a placeholder
});

test("settled keyless channel returns the placeholder promptly (no long wait)", async () => {
  await freshDevice();
  const server = makeServer();
  const bob = await makeUser(server, "bob");
  // Bob opens a keyless channel he didn't create -> settles as "waiting".
  await bob.ensureChannelKey(CH, ["alice", "bob"], "alice");
  const t0 = Date.now();
  const text = await bob.decryptForChannel(CH, 1, bytesToBase64(new Uint8Array([1, 2, 3, 4])));
  // settled + no key => immediate placeholder, well under the 50ms safety wait.
  assert.ok(Date.now() - t0 < 40, "should not wait for the key on a settled channel");
  assert.match(text, /key not available/);
});

test("decryptForChannel blocks a null/0 keyVersion body (never shows plaintext)", async () => {
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  // Fail-closed: an unencrypted body is replaced by a placeholder, not shown.
  assert.match(await alice.decryptForChannel(CH, undefined, "plain text body"), /blocked: unencrypted/);
  assert.match(await alice.decryptForChannel(CH, 0, "still plain"), /blocked: unencrypted/);
});

test("decryptForChannel returns a placeholder when the key isn't available", async () => {
  await freshDevice();
  const server = makeServer();
  const bob = await makeUser(server, "bob");
  // a key_version>=1 body but Bob holds no key for this channel
  const text = await bob.decryptForChannel(CH, 1, bytesToBase64(new Uint8Array([1, 2, 3, 4])));
  assert.match(text, /key not available/);
});

test("idempotent open: ensureChannelKey twice stays ready and doesn't double-mint", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  await alice.ensureChannelKey(CH, ["alice"], "alice");
  const before = server.channelKeys.size;
  const again = await alice.ensureChannelKey(CH, ["alice"], "alice");
  assert.equal(again, "ready");
  assert.equal(server.channelKeys.size, before); // no new wrap minted
});

test("keyRecipients reflects who has a wrap; reshareKey wraps the missing", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  const carol = await makeUser(server, "carol");

  // Alice bootstraps with only herself as a member -> only she has a wrap.
  await alice.ensureChannelKey(CH, ["alice"], "alice");
  let recips = await alice.keyRecipients(CH);
  assert.deepEqual([...recips], ["alice"]);

  // Carol is added; before re-share she is "waiting" (no wrap).
  const members = ["alice", "carol"];
  recips = await alice.keyRecipients(CH);
  assert.equal(recips.has("carol"), false);

  // Alice re-shares to all waiting members -> Carol now has a wrap.
  const ok = await alice.reshareKey(CH, members);
  assert.equal(ok, true);
  recips = await alice.keyRecipients(CH);
  assert.equal(recips.has("alice"), true);
  assert.equal(recips.has("carol"), true);

  // And Carol can now actually unwrap + the key works end to end.
  await freshDevice();
  const cStatus = await carol.ensureChannelKey(CH, members, "alice");
  assert.equal(cStatus, "ready");
});

test("reshareKey returns false when we don't hold the key", async () => {
  await freshDevice();
  const server = makeServer();
  const bob = await makeUser(server, "bob");
  // Bob never bootstrapped/received the key -> cannot re-share.
  const ok = await bob.reshareKey(CH, ["alice", "bob"]);
  assert.equal(ok, false);
});

// ---- phase 25: key rotation ----

test("rotation: creator mints v2, both members encrypt/decrypt under it", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  const bob = await makeUser(server, "bob");
  const members = ["alice", "bob"];

  await alice.ensureChannelKey(CH, members, "alice");
  await bob.ensureChannelKey(CH, members, "alice");
  assert.equal(alice.currentVersion(CH), 1);

  const ok = await alice.rotateChannelKey(CH, members, 2);
  assert.equal(ok, true);
  assert.equal(alice.currentVersion(CH), 2);

  const enc = await alice.encryptForChannel(CH, "after rotation");
  assert.equal(enc.kind, "encrypted");
  if (enc.kind !== "encrypted") return;
  assert.equal(enc.keyVersion, 2);

  bob.setCurrentKeyVersion(CH, 2);
  await bob.ensureChannelKey(CH, members, "alice");
  const dec = await bob.decryptForChannel(CH, enc.keyVersion, enc.body);
  assert.equal(dec, "after rotation");
});

// 82-3: rotation used to write the in-memory key map directly, bypassing the
// module's single adoption chokepoint. The provenance record is the observable
// proof that it now goes through remember() like everything else -- and that a
// self-minted key is recorded as self-minted, not as something adopted from
// the wire.
test("rotation records self-minted provenance (it no longer bypasses remember)", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  const members = ["alice"];

  await alice.ensureChannelKey(CH, members, "alice");
  assert.deepEqual((await loadSpaceKey(CH, 1))!.provenance, { kind: "self_minted" });

  assert.equal(await alice.rotateChannelKey(CH, members, 2), true);
  assert.deepEqual((await loadSpaceKey(CH, 2))!.provenance, { kind: "self_minted" });

  // And the rotated key is genuinely usable through the normal path, which is
  // what would break if remember() had been skipped.
  const enc = await alice.encryptForChannel(CH, "post-rotation");
  assert.equal(enc.kind, "encrypted");
  if (enc.kind !== "encrypted") return;
  assert.equal(enc.keyVersion, 2);
  assert.equal(await alice.decryptForChannel(CH, 2, enc.body), "post-rotation");
});

// NOTE ON THIS FIXTURE: every user in these tests shares one fake-IndexedDB,
// which real devices do not. So a second user's getKey() finds the FIRST
// user's cached key and returns "ready" without ever fetching a wrap. Clearing
// the cache between the two is what forces the wrap to actually be fetched and
// opened -- without it, this test would pass while exercising nothing.
// 82-5 changed this test's answer, which is the point of the slice: the wrap
// Alice's rewrap path really produces is signed, so what Bob records is WHO
// gave him the key -- not "unsigned", as it was through 82-4.
test("a key adopted from the wire records the member who signed it", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  const bob = await makeUser(server, "bob");
  const members = ["alice", "bob"];

  await alice.ensureChannelKey(CH, members, "alice"); // alice mints + rewraps for bob
  assert.deepEqual((await loadSpaceKey(CH, 1))!.provenance, { kind: "self_minted" });
  assert.equal(
    server.channelKeys.get(`${CH}:1:bob`)!.suite,
    2,
    "the rewrap path must publish a signed wrap, not a suite-1 one",
  );

  await freshDevice(); // bob is a different device: empty cache, no pins
  const status = await bob.ensureChannelKey(CH, members, "alice");
  assert.equal(status, "ready", "bob must open alice's wrap, not read a shared cache");
  assert.deepEqual((await loadSpaceKey(CH, 1))!.provenance, {
    kind: "signed",
    signerUserID: "alice",
    trust: "pinned", // first sight of Alice on this device -> TOFU
  });
});

test("rotation: messages under the OLD version still decrypt after rotating", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  const bob = await makeUser(server, "bob");
  const members = ["alice", "bob"];

  await alice.ensureChannelKey(CH, members, "alice");
  await bob.ensureChannelKey(CH, members, "alice");

  const v1msg = await alice.encryptForChannel(CH, "before rotation");
  assert.equal(v1msg.kind, "encrypted");
  if (v1msg.kind !== "encrypted") return;
  assert.equal(v1msg.keyVersion, 1);

  await alice.rotateChannelKey(CH, members, 2);

  const dec = await alice.decryptForChannel(CH, v1msg.keyVersion, v1msg.body);
  assert.equal(dec, "before rotation");
});

test("rotation: a removed member has no wrap at the new version", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  await makeUser(server, "bob");
  const before = ["alice", "bob"];

  await alice.ensureChannelKey(CH, before, "alice");
  await alice.ensureChannelKey(CH, before, "alice");

  const after = ["alice"];
  await alice.rotateChannelKey(CH, after, 2);

  alice.setCurrentKeyVersion(CH, 2);
  const recips = new Set(await alice.keyRecipients(CH));
  assert.equal(recips.has("alice"), true);
  assert.equal(recips.has("bob"), false);
});

test("rotation: rejects a non-forward version", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  await alice.ensureChannelKey(CH, ["alice"], "alice");
  assert.equal(await alice.rotateChannelKey(CH, ["alice"], 1), false);
  assert.equal(await alice.rotateChannelKey(CH, ["alice"], 0), false);
  assert.equal(alice.currentVersion(CH), 1);
});

test("setCurrentKeyVersion is monotonic (never moves backwards)", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  assert.equal(alice.currentVersion(CH), CURRENT_KEY_VERSION);
  alice.setCurrentKeyVersion(CH, 3);
  assert.equal(alice.currentVersion(CH), 3);
  alice.setCurrentKeyVersion(CH, 2);
  assert.equal(alice.currentVersion(CH), 3);
});

// ---- 82-4: a hostile server ---------------------------------------------
//
// The fake server above is honest. These tests give it the one capability the
// threat model grants it -- writing whatever it likes into channel_keys -- and
// assert the client refuses to adopt the result.
//
// The server's advantage is real and worth restating: recipients' X25519
// PUBLIC keys are published to it, so it can seal a key it chose into a
// perfectly well-formed wrap for any member. Only the signature stops it.

/** Seals `key` to `recipient` and signs it as `signer`, exactly as a client would. */
async function signedWrapFor(
  key: Uint8Array,
  recipientX25519Pub: Uint8Array,
  slot: { channelID: string; keyVersion: number; recipientID: string },
  signerUserID: string,
  signer: { ed25519Private: CryptoKey; ed25519Public: Uint8Array },
) {
  return wrapSpaceKeySigned(
    key,
    recipientX25519Pub,
    slot,
    signerUserID,
    signer.ed25519Private,
    signer.ed25519Public,
  );
}

// The sharpest case in the audit: the creator publishes its own wrap, reads it
// back, and adopts whatever decrypts -- then hands that key to every member via
// rewrapForMissing. Injecting on the SECOND fetch_channel_key is what lands on
// the read-back specifically (the first is the "do I already have one?" probe).
test("hostile: a substituted READ-BACK during bootstrap is refused and not redistributed", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  const attacker = await deriveIdentityFromMnemonic(await generateMnemonic());
  const members = ["alice", "bob"];

  const alicePub = base64ToBytes(server.identities.get("alice")!.x);
  const serverKey = generateSpaceKey();
  const forged = await signedWrapFor(
    serverKey,
    alicePub,
    { channelID: CH, keyVersion: 1, recipientID: "alice" },
    "alice",
    { ed25519Private: attacker.ed25519Private, ed25519Public: attacker.ed25519Public },
  );

  const inner = (alice as unknown as { transport: CryptoTransport }).transport;
  let fetches = 0;
  const injecting: CryptoTransport = {
    async request(type, payload) {
      if (type === "fetch_channel_key") {
        fetches++;
        if (fetches === 2) {
          // the read-back
          return {
            found: true,
            channel_id: CH,
            key_version: 1,
            wrap_suite: forged.suite,
            blob: bytesToBase64(forged.blob),
          } as never;
        }
      }
      return inner.request(type, payload);
    },
  };
  const victim = new ChannelCrypto(
    injecting,
    (alice as unknown as { identity: ChannelCryptoIdentity }).identity,
    { keyWaitMs: 50 },
  );

  const status = await victim.ensureChannelKey(CH, members, "alice");
  assert.equal(fetches >= 2, true, "the read-back must actually have happened");
  assert.equal(status, "waiting", "a foreign-signed read-back must abort the bootstrap");
  assert.equal(
    server.channelKeys.get(`${CH}:1:bob`),
    undefined,
    "the creator must not become the attacker's delivery mechanism",
  );
});

test("hostile: a substituted wrap found on the initial fetch is refused", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  const aliceID = await deriveIdentityFromMnemonic(await generateMnemonic()); // the attacker
  const members = ["alice", "bob"];

  // Alice's real X25519 public key, as the server holds it.
  const alicePubB64 = server.identities.get("alice")!.x;
  const alicePub = base64ToBytes(alicePubB64);

  // The server pre-loads Alice's own slot with a key IT chose, signed by an
  // identity that is not Alice's. This is the C-01 attack: the creator adopts
  // it and then hands it to the whole channel.
  const serverKey = generateSpaceKey();
  const forged = await signedWrapFor(
    serverKey,
    alicePub,
    { channelID: CH, keyVersion: 1, recipientID: "alice" },
    "alice", // claims to be Alice
    { ed25519Private: aliceID.ed25519Private, ed25519Public: aliceID.ed25519Public },
  );
  server.channelKeys.set(`${CH}:1:alice`, {
    suite: forged.suite,
    blobB64: bytesToBase64(forged.blob),
  });

  const status = await alice.ensureChannelKey(CH, members, "alice");

  assert.equal(status, "waiting", "must refuse rather than adopt a foreign-signed read-back");
  // The decisive assertion: the attacker's key must not have reached Bob.
  const bobRow = server.channelKeys.get(`${CH}:1:bob`);
  assert.equal(bobRow, undefined, "creator must not redistribute a key it refused");
});

test("hostile: a peer wrap signed by an unpinned identity is refused", async () => {
  await freshDevice();
  const server = makeServer();
  const bob = await makeUser(server, "bob");
  const stranger = await deriveIdentityFromMnemonic(await generateMnemonic());
  const members = ["alice", "bob"];

  const bobPub = base64ToBytes(server.identities.get("bob")!.x);
  const serverKey = generateSpaceKey();
  const forged = await signedWrapFor(
    serverKey,
    bobPub,
    { channelID: CH, keyVersion: 1, recipientID: "bob" },
    "alice",
    { ed25519Private: stranger.ed25519Private, ed25519Public: stranger.ed25519Public },
  );
  server.channelKeys.set(`${CH}:1:bob`, { suite: forged.suite, blobB64: bytesToBase64(forged.blob) });

  // "alice" has never published an identity, so nothing can vouch for that key.
  const status = await bob.ensureChannelKey(CH, members, "alice");
  assert.equal(status, "waiting");
  assert.equal(bob.hasKey(CH), false);
});

test("a wrap signed by a genuine member IS accepted, and records who signed it", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  const bob = await makeUser(server, "bob");
  const members = ["alice", "bob"];

  // Alice really holds the key and really signs a wrap for Bob.
  await alice.ensureChannelKey(CH, members, "alice");
  const realKey = (await loadSpaceKey(CH, 1))!.key;
  const aliceIdent = server.identities.get("alice")!;
  const bobPub = base64ToBytes(server.identities.get("bob")!.x);

  // Re-derive Alice's signing key the way her client would hold it. We take it
  // from the ChannelCrypto identity rather than re-deriving, so the signature
  // is genuinely hers.
  const aliceSigner = (alice as unknown as { identity: ChannelCryptoIdentity }).identity;
  const wrap = await signedWrapFor(
    realKey,
    bobPub,
    { channelID: CH, keyVersion: 1, recipientID: "bob" },
    "alice",
    aliceSigner,
  );
  assert.equal(bytesToBase64(aliceSigner.ed25519Public), aliceIdent.e);
  server.channelKeys.set(`${CH}:1:bob`, { suite: wrap.suite, blobB64: bytesToBase64(wrap.blob) });

  await freshDevice(); // bob is a different device
  const status = await bob.ensureChannelKey(CH, members, "alice");
  assert.equal(status, "ready");

  const held = (await loadSpaceKey(CH, 1))!;
  assert.equal(held.provenance.kind, "signed");
  if (held.provenance.kind !== "signed") return;
  assert.equal(held.provenance.signerUserID, "alice");
  // First sight of Alice on this device, so the pin is TOFU, not in-person.
  assert.equal(held.provenance.trust, "pinned");
});

test("warm does not reach for the network to resolve a signer", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  const bob = await makeUser(server, "bob");
  const members = ["alice", "bob"];

  await alice.ensureChannelKey(CH, members, "alice");
  const realKey = (await loadSpaceKey(CH, 1))!.key;
  const bobPub = base64ToBytes(server.identities.get("bob")!.x);
  const aliceSigner = (alice as unknown as { identity: ChannelCryptoIdentity }).identity;
  const wrap = await signedWrapFor(
    realKey,
    bobPub,
    { channelID: CH, keyVersion: 1, recipientID: "bob" },
    "alice",
    aliceSigner,
  );
  server.channelKeys.set(`${CH}:1:bob`, { suite: wrap.suite, blobB64: bytesToBase64(wrap.blob) });

  // Count identity fetches during the warm. Bob has never pinned Alice, so the
  // warm cannot resolve her -- and must accept that rather than go looking.
  await freshDevice();
  let identityFetches = 0;
  const counting: CryptoTransport = {
    request: (type, payload) => {
      if (type === "fetch_identity") identityFetches++;
      return (bob as unknown as { transport: CryptoTransport }).transport.request(type, payload);
    },
  };
  const quiet = new ChannelCrypto(counting, (bob as unknown as { identity: ChannelCryptoIdentity }).identity, {
    keyWaitMs: 50,
  });

  await quiet.warmChannelKey(CH, members);
  assert.equal(identityFetches, 0, "the unattended warm path must not fetch identities");
  assert.equal(quiet.hasKey(CH), false, "and must not adopt what it could not attribute");
});

// THE test for C-01 as it exists today. The attacker above used suite 2, which
// pre-82 code rejects as an unknown suite -- so those tests prove the new path
// is sound but would also have "passed" before the fix. A real attacker uses
// the suite that exists in the wild: SUITE 1, unsigned, which the old code
// adopted without question.
//
// The rule that closes it needs no signature and no trust store: at bootstrap,
// a read-back carrying a DIFFERENT key than the one just minted did not come
// from this user's other device doing the same thing, so it is refused.
test("hostile: an UNSIGNED read-back carrying a different key is refused (C-01)", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  await makeUser(server, "bob"); // so alice has someone real to rewrap for
  const members = ["alice", "bob"];

  const alicePub = base64ToBytes(server.identities.get("alice")!.x);
  const serverKey = generateSpaceKey();
  // A plain suite-1 wrap. The server needs only Alice's PUBLIC key to make it,
  // and it opens perfectly under her private key.
  const forged = await wrapSpaceKeyUnsigned(serverKey, alicePub, {
    channelID: CH,
    keyVersion: 1,
    recipientID: "alice",
  });

  const inner = (alice as unknown as { transport: CryptoTransport }).transport;
  let fetches = 0;
  const injecting: CryptoTransport = {
    async request(type, payload) {
      if (type === "fetch_channel_key") {
        fetches++;
        if (fetches === 2) {
          return {
            found: true, channel_id: CH, key_version: 1,
            wrap_suite: forged.suite, blob: bytesToBase64(forged.blob),
          } as never;
        }
      }
      return inner.request(type, payload);
    },
  };
  const victim = new ChannelCrypto(
    injecting,
    (alice as unknown as { identity: ChannelCryptoIdentity }).identity,
    { keyWaitMs: 50 },
  );

  const status = await victim.ensureChannelKey(CH, members, "alice");
  assert.equal(status, "ready", "alice keeps her own key and carries on");

  // The decisive check: whatever Alice now holds and hands out must NOT be the
  // server's key. Encrypt with it and confirm the server's key cannot read it.
  const enc = await victim.encryptForChannel(CH, "for members only");
  assert.equal(enc.kind, "encrypted");
  if (enc.kind !== "encrypted") return;
  assert.equal(
    await decryptMessage(serverKey, CH, enc.keyVersion, base64ToBytes(enc.body)),
    null,
    "the substituted key must not be able to read the channel",
  );

  // And Bob was wrapped for -- with Alice's real key, not the server's.
  const bobRow = server.channelKeys.get(`${CH}:1:bob`);
  assert.notEqual(bobRow, undefined, "alice still distributes her own key");
});

// ---- 82-5: the two standing rules ---------------------------------------
//
// Both live in adopt(). They exist because signing wraps only helps while a
// signature cannot be routed around, and there are two ways around one:
// overwrite a slot that was already answered, or wait for a version whose slot
// is empty and answer THAT one in the old, unsigned suite.

test("never-replace: a second, different key for an answered slot is refused", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  const bob = await makeUser(server, "bob");
  const members = ["alice", "bob"];

  await alice.ensureChannelKey(CH, members, "alice"); // real key, wrapped for bob
  const realKey = (await loadSpaceKey(CH, 1))!.key;

  // A second wrap for the SAME slot carrying different key material, signed by
  // Alice just as validly. Nothing about it is detectable as forged -- the only
  // thing wrong with it is that the slot already has an answer.
  const aliceSigner = (alice as unknown as { identity: ChannelCryptoIdentity }).identity;
  const second = await signedWrapFor(
    generateSpaceKey(),
    base64ToBytes(server.identities.get("bob")!.x),
    { channelID: CH, keyVersion: 1, recipientID: "bob" },
    "alice",
    aliceSigner,
  );

  await freshDevice(); // bob's device

  // Two opens of one channel in flight -- a channel switch racing a
  // key_available event. The second fetch is slow, so it lands after the first
  // has adopted, which is how a filled slot comes to be offered a second answer.
  const innerT = (bob as unknown as { transport: CryptoTransport }).transport;
  let fetches = 0;
  const racing: CryptoTransport = {
    async request(type, payload) {
      if (type === "fetch_channel_key" && ++fetches === 2) {
        await new Promise((r) => setTimeout(r, 25));
        return {
          found: true, channel_id: CH, key_version: 1,
          wrap_suite: second.suite, blob: bytesToBase64(second.blob),
        } as never;
      }
      return innerT.request(type, payload);
    },
  };
  const dev = new ChannelCrypto(
    racing,
    (bob as unknown as { identity: ChannelCryptoIdentity }).identity,
    { keyWaitMs: 50 },
  );

  const [first, late] = await Promise.all([
    dev.ensureChannelKey(CH, members, "alice"),
    dev.ensureChannelKey(CH, members, "alice"),
  ]);
  assert.equal(first, "ready");
  assert.equal(late, "waiting", "the late arrival must not be adopted over the held key");
  assert.equal(
    bytesToBase64((await loadSpaceKey(CH, 1))!.key),
    bytesToBase64(realKey),
    "the key the channel actually uses must be the one already agreed",
  );
});

test("ratchet: once a channel has yielded a signed key, an unsigned one is refused", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  const bob = await makeUser(server, "bob");
  const members = ["alice", "bob"];

  await alice.ensureChannelKey(CH, members, "alice");
  await freshDevice(); // bob's device
  await bob.ensureChannelKey(CH, members, "alice");
  assert.equal((await loadSpaceKey(CH, 1))!.provenance.kind, "signed");

  // Alice "rotates". The server cannot sign as Alice, so it does the only thing
  // left: answers the fresh v2 slot in suite 1, which 82-5 still accepts for
  // channels that have never seen better.
  const serverKey = generateSpaceKey();
  const forged = await wrapSpaceKeyUnsigned(serverKey, base64ToBytes(server.identities.get("bob")!.x), {
    channelID: CH,
    keyVersion: 2,
    recipientID: "bob",
  });
  server.channelKeys.set(`${CH}:2:bob`, { suite: forged.suite, blobB64: bytesToBase64(forged.blob) });

  bob.setCurrentKeyVersion(CH, 2);
  const status = await bob.ensureChannelKey(CH, members, "alice");
  assert.equal(status, "waiting", "a downgrade to unsigned must not be accepted");
  assert.equal(bob.hasKey(CH, 2), false);
  assert.equal(await loadSpaceKey(CH, 2), null, "and must not be cached either");
});

test("ratchet: survives a reload -- it is read from the key cache, not memory", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  const bob = await makeUser(server, "bob");
  const members = ["alice", "bob"];

  await alice.ensureChannelKey(CH, members, "alice");
  await freshDevice();
  await bob.ensureChannelKey(CH, members, "alice"); // signed adoption at v1

  const forged = await wrapSpaceKeyUnsigned(generateSpaceKey(), base64ToBytes(server.identities.get("bob")!.x), {
    channelID: CH,
    keyVersion: 2,
    recipientID: "bob",
  });
  server.channelKeys.set(`${CH}:2:bob`, { suite: forged.suite, blobB64: bytesToBase64(forged.blob) });

  // A new instance on the same device: nothing remembered in memory, so the
  // only thing that can still say "this channel has been signed for" is the
  // provenance persisted alongside the v1 key.
  const reloaded = new ChannelCrypto(
    (bob as unknown as { transport: CryptoTransport }).transport,
    (bob as unknown as { identity: ChannelCryptoIdentity }).identity,
    { keyWaitMs: 50 },
  );
  reloaded.setCurrentKeyVersion(CH, 2);
  assert.equal(await reloaded.ensureChannelKey(CH, members, "alice"), "waiting");
  assert.equal(await loadSpaceKey(CH, 2), null);
});

// The control the two tests above need: without it, "refuse every unsigned
// wrap" would pass them both, and that is a different (82-6) rule which would
// lock every existing channel out of its own key.
test("ratchet: a channel that has only ever been unsigned still accepts unsigned", async () => {
  await freshDevice();
  const server = makeServer();
  await makeUser(server, "alice"); // published so the rewrap sweep has a real peer
  const bob = await makeUser(server, "bob");
  const members = ["alice", "bob"];

  const bobPub = base64ToBytes(server.identities.get("bob")!.x);
  const legacyKey = generateSpaceKey();
  for (const v of [1, 2]) {
    const w = await wrapSpaceKeyUnsigned(legacyKey, bobPub, { channelID: CH, keyVersion: v, recipientID: "bob" });
    server.channelKeys.set(`${CH}:${v}:bob`, { suite: w.suite, blobB64: bytesToBase64(w.blob) });
  }

  await freshDevice();
  assert.equal(await bob.ensureChannelKey(CH, members, "alice"), "ready");
  assert.equal((await loadSpaceKey(CH, 1))!.provenance.kind, "unsigned");

  bob.setCurrentKeyVersion(CH, 2);
  assert.equal(await bob.ensureChannelKey(CH, members, "alice"), "ready");
  assert.equal((await loadSpaceKey(CH, 2))!.provenance.kind, "unsigned");
});

// ---- 82-6: the self-healing sweep and the enforcement flag ---------------
//
// The sweep is what closes the soft window CHANNEL BY CHANNEL: any holder who
// opens a channel re-wraps every member still sitting on a legacy unsigned
// wrap, so the population of unsigned wraps shrinks to zero ahead of the
// operator flipping CHALK_WRAP_SIG_REQUIRED. The flag is what then refuses
// whatever the sweep never reached.

test("sweep: a holder heals legacy unsigned wraps to signed, own slot included", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  const bob = await makeUser(server, "bob");
  const members = ["alice", "bob"];

  // A pre-82 channel: suite-1 wraps for both members, nothing else.
  const legacyKey = generateSpaceKey();
  for (const [m, pub] of [
    ["alice", base64ToBytes(server.identities.get("alice")!.x)],
    ["bob", base64ToBytes(server.identities.get("bob")!.x)],
  ] as Array<[string, Uint8Array]>) {
    const w = await wrapSpaceKeyUnsigned(legacyKey, pub, { channelID: CH, keyVersion: 1, recipientID: m });
    server.channelKeys.set(`${CH}:1:${m}`, { suite: w.suite, blobB64: bytesToBase64(w.blob) });
  }

  // Alice opens the channel: unwraps her legacy wrap (soft window), then the
  // sweep re-wraps BOTH slots signed -- hers is what arms the ratchet on her
  // other devices, Bob's is what upgrades him without any action of his own.
  assert.equal(await alice.ensureChannelKey(CH, members, "alice"), "ready");
  assert.equal(server.channelKeys.get(`${CH}:1:alice`)!.suite, 2, "own slot must be healed");
  assert.equal(server.channelKeys.get(`${CH}:1:bob`)!.suite, 2, "peer slot must be healed");

  // Bob, on a fresh device, now opens a SIGNED wrap attributed to Alice.
  await freshDevice();
  assert.equal(await bob.ensureChannelKey(CH, members, "alice"), "ready");
  assert.deepEqual((await loadSpaceKey(CH, 1))!.provenance, {
    kind: "signed",
    signerUserID: "alice",
    trust: "pinned",
  });
});

test("sweep: an unknown suite (pre-82-6 server) is left alone", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  const members = ["alice", "bob"];

  const legacyKey = generateSpaceKey();
  const w = await wrapSpaceKeyUnsigned(
    legacyKey,
    base64ToBytes(server.identities.get("alice")!.x),
    { channelID: CH, keyVersion: 1, recipientID: "alice" },
  );
  server.channelKeys.set(`${CH}:1:alice`, { suite: w.suite, blobB64: bytesToBase64(w.blob) });

  // An older server: recipients only, no wrap_suites field.
  const inner = (alice as unknown as { transport: CryptoTransport }).transport;
  const oldServer: CryptoTransport = {
    async request(type, payload) {
      const res = (await inner.request(type, payload)) as Record<string, unknown>;
      if (type === "fetch_channel_key_recipients") delete res.wrap_suites;
      return res as never;
    },
  };
  const dev = new ChannelCrypto(oldServer, (alice as unknown as { identity: ChannelCryptoIdentity }).identity, {
    keyWaitMs: 50,
  });

  assert.equal(await dev.ensureChannelKey(CH, members, "alice"), "ready");
  // Unknown must not be treated as worse: the slot is NOT republished.
  assert.equal(server.channelKeys.get(`${CH}:1:alice`)!.suite, 1);
});

test("flag: an unsigned wrap is refused when the server requires signatures", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  const bob = await makeUser(server, "bob");
  const members = ["alice", "bob"];

  // Bob's wrap is unsigned -- the un-swept-member case the flag exists for.
  const legacyKey = generateSpaceKey();
  const w = await wrapSpaceKeyUnsigned(
    legacyKey,
    base64ToBytes(server.identities.get("bob")!.x),
    { channelID: CH, keyVersion: 1, recipientID: "bob" },
  );
  server.channelKeys.set(`${CH}:1:bob`, { suite: w.suite, blobB64: bytesToBase64(w.blob) });

  bob.setWrapSigRequired(true);
  assert.equal(await bob.ensureChannelKey(CH, members, "alice"), "waiting");
  assert.equal(bob.hasKey(CH), false);
  assert.equal(await loadSpaceKey(CH, 1), null, "a refused wrap must not be cached");
  void alice; // present so the roster names a real, published member
});

// The recovery path deserves its own test with a genuinely shared key.
test("flag: re-share by a holder recovers a member stuck on an unsigned wrap", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  const bob = await makeUser(server, "bob");
  const members = ["alice", "bob"];

  // Alice bootstraps (signed all around), then bob's slot is REPLACED by an
  // unsigned wrap of the same key -- the shape of an un-swept legacy member.
  await alice.ensureChannelKey(CH, members, "alice");
  const realKey = (await loadSpaceKey(CH, 1))!.key;
  const unsigned = await wrapSpaceKeyUnsigned(
    realKey,
    base64ToBytes(server.identities.get("bob")!.x),
    { channelID: CH, keyVersion: 1, recipientID: "bob" },
  );
  server.channelKeys.set(`${CH}:1:bob`, { suite: unsigned.suite, blobB64: bytesToBase64(unsigned.blob) });

  await freshDevice();
  bob.setWrapSigRequired(true);
  assert.equal(await bob.ensureChannelKey(CH, members, "alice"), "waiting");

  // Alice re-shares: the sweep sees bob on suite 1 and upgrades him.
  assert.equal(await alice.reshareKey(CH, members), true);
  assert.equal(server.channelKeys.get(`${CH}:1:bob`)!.suite, 2);

  assert.equal(await bob.ensureChannelKey(CH, members, "alice"), "ready");
});

test("flag: latches -- a later welcome cannot relax it", async () => {
  await freshDevice();
  const server = makeServer();
  const bob = await makeUser(server, "bob");
  const members = ["alice", "bob"];

  const legacyKey = generateSpaceKey();
  const w = await wrapSpaceKeyUnsigned(
    legacyKey,
    base64ToBytes(server.identities.get("bob")!.x),
    { channelID: CH, keyVersion: 1, recipientID: "bob" },
  );
  server.channelKeys.set(`${CH}:1:bob`, { suite: w.suite, blobB64: bytesToBase64(w.blob) });

  bob.setWrapSigRequired(true);
  bob.setWrapSigRequired(false); // a reconnect "relaxing" the policy
  assert.equal(await bob.ensureChannelKey(CH, members, "alice"), "waiting");
});
