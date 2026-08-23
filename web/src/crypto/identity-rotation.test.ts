// 83-4 end to end: a real identity rotation through the chain -- the cert
// minted by the retiring key, the server's atomic retire-and-insert (faked
// here with the same sequence rule), the resolver walking forward to the new
// key, the pin rolling forward, old history reading as
// verified-former-identity, and a tampered generation hitting the wall.

import "fake-indexeddb/auto";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { ChannelCrypto, type CryptoTransport, type ChannelCryptoIdentity } from "./channel-crypto";
import { deriveIdentity, type DerivedIdentity } from "./identity";
import { fetchVerifiedChain, publishRotatedIdentity } from "./identity-sync";
import { fetchTrustedIdentity } from "./trust";
import { clearSpaceKeys, clearVerification, clearReplayRecords, loadVerification } from "./idb";
import { OBJ_MESSAGE, type MessageEnvelope } from "./envelope";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const CH = "11111111-2222-4333-8444-555555555555";
const SCOPE = "99999999-0000-4000-8000-000000000009";

function b64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

interface Gen {
  generation: number;
  x: string;
  e: string;
  s: string;
  cert?: string;
  retired?: boolean;
}

// Fake server with the 83-4 rotation rule: generation >= 2 needs a cert and
// must be active+1; the previous generation is retired in the same step.
function makeServer() {
  const channelKeys = new Map<string, { suite: number; blobB64: string }>();
  const identities = new Map<string, Gen[]>();
  const ck = (c: string, v: number, r: string) => `${c}:${v}:${r}`;
  function transportFor(): CryptoTransport {
    return {
      async request(type: string, p: any): Promise<any> {
        switch (type) {
          case "publish_identity": {
            const gens = identities.get(p.__caller) ?? [];
            const gen = p.generation ?? 1;
            if (gen >= 2) {
              const active = gens.find((g) => !g.retired);
              if (!p.gen_cert || !active || active.generation !== gen - 1) throw new Error("rotation out of sequence");
              active.retired = true;
              gens.push({ generation: gen, x: p.x25519_pub, e: p.ed25519_pub, s: p.self_sig, cert: p.gen_cert });
            } else if (!gens.some((g) => g.generation === 1)) {
              gens.push({ generation: 1, x: p.x25519_pub, e: p.ed25519_pub, s: p.self_sig });
            }
            identities.set(p.__caller, gens);
            return { generation: gen };
          }
          case "fetch_identity": {
            const r = identities.get(p.user_id)?.find((g) => !g.retired);
            if (!r) return { found: false, user_id: p.user_id };
            return { found: true, user_id: p.user_id, generation: r.generation, x25519_pub: r.x, ed25519_pub: r.e, self_sig: r.s };
          }
          case "fetch_identity_chain": {
            const gens = identities.get(p.user_id) ?? [];
            return {
              found: gens.length > 0,
              user_id: p.user_id,
              generations: gens.map((g) => ({
                generation: g.generation,
                x25519_pub: g.x,
                ed25519_pub: g.e,
                self_sig: g.s,
                gen_cert: g.cert,
                retired_at: g.retired ? 1 : undefined,
              })),
            };
          }
          case "publish_channel_key":
            channelKeys.set(ck(p.channel_id, p.key_version, p.recipient_id), { suite: p.wrap_suite, blobB64: p.blob });
            return { channel_id: p.channel_id, key_version: p.key_version, recipient_id: p.recipient_id };
          case "fetch_channel_key": {
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
                suites[r] = row.suite;
              }
            }
            return { channel_id: p.channel_id, key_version: p.key_version, recipients: out, wrap_suites: suites };
          }
        }
        throw new Error("unexpected " + type);
      },
    };
  }
  return { transportFor, identities };
}

function transportAs(server: ReturnType<typeof makeServer>, userID: string): CryptoTransport {
  const base = server.transportFor();
  return { request: (type, payload) => base.request(type, { ...(payload as any), __caller: userID }) };
}

async function makeUser(server: ReturnType<typeof makeServer>, userID: string, seedByte: number, generation = 1) {
  const id = await deriveIdentity(new Uint8Array(64).fill(seedByte), generation);
  const transport = transportAs(server, userID);
  if (generation === 1) {
    await transport.request("publish_identity", {
      generation: 1,
      x25519_pub: b64(id.x25519Public),
      ed25519_pub: b64(id.ed25519Public),
      self_sig: b64(id.selfSig),
    });
  }
  return { id, transport, cc: ccFor(transport, userID, id) };
}

function ccFor(transport: CryptoTransport, userID: string, id: DerivedIdentity): ChannelCrypto {
  const identity: ChannelCryptoIdentity = {
    userID,
    x25519Private: id.x25519Private,
    x25519Public: id.x25519Public,
    ed25519Private: id.ed25519Private,
    ed25519Public: id.ed25519Public,
  };
  return new ChannelCrypto(transport, identity, { keyWaitMs: 50 });
}

function env(sender: string, fp: Uint8Array, keyVersion: number, body: string): MessageEnvelope {
  return {
    objType: OBJ_MESSAGE,
    channelID: CH,
    keyVersion,
    senderUserID: sender,
    senderEd25519Fp: fp,
    writerScope: SCOPE,
    clientMsgID: crypto.randomUUID(),
    senderTs: Date.now(),
    wseq: 1,
    reply: null,
    bodyText: body,
    attachments: [],
  };
}

test("rotation: forward resolution, pin roll-forward, former-identity history, and the wall", async () => {
  await clearSpaceKeys();
  await clearReplayRecords();
  await clearVerification(ALICE);
  await clearVerification(BOB);
  const server = makeServer();
  const alice = await makeUser(server, ALICE, 1);
  const bob = await makeUser(server, BOB, 2);
  assert.equal(await alice.cc.ensureChannelKey(CH, [ALICE, BOB], ALICE), "ready");
  assert.equal(await bob.cc.ensureChannelKey(CH, [ALICE, BOB], ALICE), "ready");

  // 1. gen-1 alice speaks; bob pins her
  const m1 = await alice.cc.signAndEncryptEnvelope(CH, (v, fp) => env(ALICE, fp, v, "from gen 1"));
  assert.equal(m1.kind, "encrypted");
  if (m1.kind !== "encrypted") return;
  const o1 = await bob.cc.openMessageForChannel(CH, m1.keyVersion, m1.body, { serverMsgID: "r1", senderUserID: ALICE });
  assert.equal(o1.verify, "verified");
  assert.equal((await loadVerification(ALICE))?.generation, 1);

  // 2. alice rotates: old key in hand signs the successor
  const chain1 = await fetchVerifiedChain(alice.transport, ALICE);
  assert.equal(chain1.length, 1);
  const gen2 = await deriveIdentity(new Uint8Array(64).fill(3), 2);
  assert.equal(await publishRotatedIdentity(alice.transport, ALICE, alice.id.ed25519Private, chain1[0], gen2), 2);
  const alice2 = ccFor(alice.transport, ALICE, gen2);
  // the space key is cached on this "device" (shared fake-indexeddb); re-wrapping
  // to the new X25519 key is the (unbuilt) phrase-rotation flow's job
  assert.equal(await alice2.ensureChannelKey(CH, [ALICE, BOB], ALICE), "ready");

  // 3. gen-2 alice speaks; bob's pin is still gen 1, the chain walks forward
  const m2 = await alice2.signAndEncryptEnvelope(CH, (v, fp) => env(ALICE, fp, v, "from gen 2"));
  assert.equal(m2.kind, "encrypted");
  if (m2.kind !== "encrypted") return;
  const o2 = await bob.cc.openMessageForChannel(CH, m2.keyVersion, m2.body, { serverMsgID: "r2", senderUserID: ALICE });
  assert.equal(o2.verify, "verified");

  // 4. bob re-fetches alice (channel open / members panel): the changed key is
  //    a chained rotation, so the pin rolls forward instead of walling
  const t = await fetchTrustedIdentity(bob.transport, ALICE);
  assert.ok(t);
  assert.equal(t!.pin, "pinned"); // TOFU source carries over; digest cleared
  const rec = await loadVerification(ALICE);
  assert.equal(rec?.generation, 2);
  assert.equal(rec?.ed25519PubB64, b64(gen2.ed25519Public));
  assert.equal(rec?.digestHex, "");

  // 5. gen-1 history now reads as former identity -- never as current speech
  const bob2 = ccFor(bob.transport, BOB, bob.id); // fresh brain: no stale chain cache
  const o1b = await bob2.openMessageForChannel(CH, m1.keyVersion, m1.body, { serverMsgID: "r1", senderUserID: ALICE });
  assert.equal(o1b.verify, "verified-former-identity");
  const o2b = await bob2.openMessageForChannel(CH, m2.keyVersion, m2.body, { serverMsgID: "r2", senderUserID: ALICE });
  assert.equal(o2b.verify, "verified");

  // 6. the wall: a database write swaps alice's active generation for an
  //    attacker key with no cert. The chain stops at gen 1, bob's pinned gen-2
  //    key is unreachable -> attacker messages are forged, the pin will not
  //    roll, and the identity-changed wall stands.
  const mallory = await deriveIdentity(new Uint8Array(64).fill(66), 3);
  server.identities.get(ALICE)!.forEach((g) => (g.retired = true));
  server.identities.get(ALICE)!.push({
    generation: 3,
    x: b64(mallory.x25519Public),
    e: b64(mallory.ed25519Public),
    s: b64(mallory.selfSig),
    // no cert: nobody with alice's key signed this
  });
  const malloryCC = ccFor(alice.transport, ALICE, mallory);
  assert.equal(await malloryCC.ensureChannelKey(CH, [ALICE, BOB], ALICE), "ready");
  const m3 = await malloryCC.signAndEncryptEnvelope(CH, (v, fp) => env(ALICE, fp, v, "im alice now"));
  assert.equal(m3.kind, "encrypted");
  if (m3.kind !== "encrypted") return;
  const bob3 = ccFor(bob.transport, BOB, bob.id);
  const o3 = await bob3.openMessageForChannel(CH, m3.keyVersion, m3.body, { serverMsgID: "r3", senderUserID: ALICE });
  assert.equal(o3.verify, "forged");
  const walled = await fetchTrustedIdentity(bob.transport, ALICE);
  assert.equal(walled?.pin, "changed");
  assert.equal((await loadVerification(ALICE))?.generation, 2); // pin untouched
  // and a legitimate gen-2 message still verifies against the held pin
  const o2c = await bob3.openMessageForChannel(CH, m2.keyVersion, m2.body, { serverMsgID: "r2", senderUserID: ALICE });
  assert.equal(o2c.verify, "verified");
});
