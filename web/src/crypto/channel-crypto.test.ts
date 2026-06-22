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
import { clearSpaceKeys } from "./idb";

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
            for (const k of channelKeys.keys()) {
              const [c, v, r] = k.split(":");
              if (c === p.channel_id && Number(v) === p.key_version) out.push(r);
            }
            return { channel_id: p.channel_id, key_version: p.key_version, recipients: out };
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
  };
  // short key-wait so deferred-decrypt tests are fast + deterministic
  return new ChannelCrypto(transport, identity, { keyWaitMs: 50 });
}

function bytesToBase64(b: Uint8Array): string {
  let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s);
}

const CH = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

test("creator bootstraps a keyless channel -> ready, and can encrypt", async () => {
  await clearSpaceKeys();
  const server = makeServer();
  const alice = await makeUser(server, "alice");

  const status = await alice.ensureChannelKey(CH, ["alice"], "alice");
  assert.equal(status, "ready");
  assert.equal(alice.hasKey(CH), true);

  const enc = await alice.encryptForChannel(CH, "hello world");
  assert.equal(enc.kind, "encrypted");
});

test("non-creator on a keyless channel is blocked (waiting), never plaintext", async () => {
  await clearSpaceKeys();
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
  await clearSpaceKeys();
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
  await clearSpaceKeys();

  // Bob opens: Alice already wrapped the key for him, so he's ready.
  const bStatus = await bob.ensureChannelKey(CH, members, "alice");
  assert.equal(bStatus, "ready");
  assert.equal(bob.hasKey(CH), true);

  // Bob decrypts Alice's message.
  const text = await bob.decryptForChannel(CH, keyVersion, body);
  assert.equal(text, "secret for the channel");
});

test("waiting: encrypted channel, member opens before being wrapped for -> waiting, send blocked", async () => {
  await clearSpaceKeys();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  // Carol exists but is NOT yet a member when Alice bootstraps, so Alice
  // doesn't wrap for her.
  const carol = await makeUser(server, "carol");

  await alice.ensureChannelKey(CH, ["alice"], "alice"); // only alice is a member

  // The idb space-key cache is per-browser; Alice and Carol are different
  // browsers, so clear the shared test cache to isolate Carol's view.
  await clearSpaceKeys();

  // Carol is later added; she opens but Alice hasn't rewrapped for her yet.
  const cStatus = await carol.ensureChannelKey(CH, ["alice", "carol"], "alice");
  assert.equal(cStatus, "waiting");
  const enc = await carol.encryptForChannel(CH, "blocked");
  assert.equal(enc.kind, "waiting");
});

test("deferred decrypt: a message arriving before the key resolves once the key lands", async () => {
  await clearSpaceKeys();
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

  await clearSpaceKeys(); // Bob is a different browser

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
  await clearSpaceKeys();
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
  await clearSpaceKeys();
  const server = makeServer();
  const bob = await makeUser(server, "bob");
  // a key_version>=1 body but Bob holds no key for this channel
  const text = await bob.decryptForChannel(CH, 1, bytesToBase64(new Uint8Array([1, 2, 3, 4])));
  assert.match(text, /key not available/);
});

test("idempotent open: ensureChannelKey twice stays ready and doesn't double-mint", async () => {
  await clearSpaceKeys();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  await alice.ensureChannelKey(CH, ["alice"], "alice");
  const before = server.channelKeys.size;
  const again = await alice.ensureChannelKey(CH, ["alice"], "alice");
  assert.equal(again, "ready");
  assert.equal(server.channelKeys.size, before); // no new wrap minted
});

test("keyRecipients reflects who has a wrap; reshareKey wraps the missing", async () => {
  await clearSpaceKeys();
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
  await clearSpaceKeys();
  const cStatus = await carol.ensureChannelKey(CH, members, "alice");
  assert.equal(cStatus, "ready");
});

test("reshareKey returns false when we don't hold the key", async () => {
  await clearSpaceKeys();
  const server = makeServer();
  const bob = await makeUser(server, "bob");
  // Bob never bootstrapped/received the key -> cannot re-share.
  const ok = await bob.reshareKey(CH, ["alice", "bob"]);
  assert.equal(ok, false);
});

// ---- phase 25: key rotation ----

test("rotation: creator mints v2, both members encrypt/decrypt under it", async () => {
  await clearSpaceKeys();
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

test("rotation: messages under the OLD version still decrypt after rotating", async () => {
  await clearSpaceKeys();
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
  await clearSpaceKeys();
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
  await clearSpaceKeys();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  await alice.ensureChannelKey(CH, ["alice"], "alice");
  assert.equal(await alice.rotateChannelKey(CH, ["alice"], 1), false);
  assert.equal(await alice.rotateChannelKey(CH, ["alice"], 0), false);
  assert.equal(alice.currentVersion(CH), 1);
});

test("setCurrentKeyVersion is monotonic (never moves backwards)", async () => {
  await clearSpaceKeys();
  const server = makeServer();
  const alice = await makeUser(server, "alice");
  assert.equal(alice.currentVersion(CH), CURRENT_KEY_VERSION);
  alice.setCurrentKeyVersion(CH, 3);
  assert.equal(alice.currentVersion(CH), 3);
  alice.setCurrentKeyVersion(CH, 2);
  assert.equal(alice.currentVersion(CH), 3);
});
