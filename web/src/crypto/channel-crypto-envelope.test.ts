// Tests for the 83-2 half of crypto/channel-crypto.ts: sign-then-seal on
// send, envelope-aware fail-closed opening on receive, the pin-based signer
// resolution, and the replay first-seen binding -- end to end with real
// derived identities, a fake in-memory server, and fake-indexeddb.
//
// User ids here are UUIDS (unlike channel-crypto.test.ts's "alice"/"bob"),
// because the signed envelope encodes the actor as strict uuid16.

import "fake-indexeddb/auto";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  ChannelCrypto,
  PLACEHOLDER_FAILED,
  type CryptoTransport,
  type ChannelCryptoIdentity,
} from "./channel-crypto";
import { deriveIdentityFromMnemonic } from "./identity";
import { generateMnemonic } from "./bip39";
import { clearSpaceKeys, clearVerification, clearReplayRecords, loadSpaceKey } from "./idb";
import { encryptMessage } from "./spacekey";
import { OBJ_MESSAGE, signEnvelope, ed25519Fingerprint, type MessageEnvelope } from "./envelope";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const EVE = "eeeeeeee-0000-4000-8000-000000000003";
const DAVE = "dddddddd-0000-4000-8000-000000000004";
const CH = "11111111-2222-4333-8444-555555555555";
const SCOPE = "99999999-0000-4000-8000-000000000009";

// ---- fixture: fake server + users (mirrors channel-crypto.test.ts) -------

function makeServer() {
  const channelKeys = new Map<string, { suite: number; blobB64: string }>();
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
  return { transportFor };
}

async function makeUser(server: ReturnType<typeof makeServer>, userID: string, publish = true) {
  const id = await deriveIdentityFromMnemonic(await generateMnemonic());
  const base = server.transportFor();
  const transport: CryptoTransport = {
    request: (type, payload) => base.request(type, { ...(payload as any), __caller: userID }),
  };
  if (publish) {
    await transport.request("publish_identity", {
      generation: id.generation,
      x25519_pub: b64(id.x25519Public),
      ed25519_pub: b64(id.ed25519Public),
      self_sig: b64(id.selfSig),
    });
  }
  const identity: ChannelCryptoIdentity = {
    userID,
    x25519Private: id.x25519Private,
    x25519Public: id.x25519Public,
    ed25519Private: id.ed25519Private,
    ed25519Public: id.ed25519Public,
  };
  return { cc: new ChannelCrypto(transport, identity, { keyWaitMs: 50 }), identity: id };
}

async function freshDevice(): Promise<void> {
  await clearSpaceKeys();
  await clearReplayRecords();
  for (const id of [ALICE, BOB, EVE, DAVE]) await clearVerification(id);
}

function b64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

// Boot a channel where alice (creator) + the listed peers all hold the key.
async function bootChannel(users: { cc: ChannelCrypto }[], memberIDs: string[]) {
  // creator bootstraps + wraps for everyone published; then each peer opens.
  assert.equal(await users[0].cc.ensureChannelKey(CH, memberIDs, memberIDs[0]), "ready");
  for (const u of users.slice(1)) {
    assert.equal(await u.cc.ensureChannelKey(CH, memberIDs, memberIDs[0]), "ready");
  }
}

function makeEnv(sender: string, fp: Uint8Array, keyVersion: number, over: Partial<MessageEnvelope> = {}): MessageEnvelope {
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
    bodyText: "handcrafted",
    attachments: [],
    ...over,
  };
}

// ---- the flows -----------------------------------------------------------

test("sign-then-seal round trip: bob verifies alice's message", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, ALICE);
  const bob = await makeUser(server, BOB);
  await bootChannel([alice, bob], [ALICE, BOB]);

  const enc = await alice.cc.signAndEncryptEnvelope(CH, (keyVersion, fp) =>
    makeEnv(ALICE, fp, keyVersion, { bodyText: "hello bob" }),
  );
  assert.equal(enc.kind, "encrypted");
  if (enc.kind !== "encrypted") return;
  assert.equal(enc.objectHash.length, 32);

  const opened = await bob.cc.openMessageForChannel(CH, enc.keyVersion, enc.body, {
    serverMsgID: "row-1",
    senderUserID: ALICE,
  });
  assert.equal(opened.text, "hello bob");
  assert.equal(opened.verify, "verified"); // resolver fetched + TOFU-pinned alice
  assert.equal(opened.duplicate, undefined);
  assert.equal(opened.env?.senderUserID, ALICE);
  assert.equal(opened.objectHashHex?.length, 64);
});

test("replay: the same envelope under a new server row renders once", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, ALICE);
  const bob = await makeUser(server, BOB);
  await bootChannel([alice, bob], [ALICE, BOB]);

  const enc = await alice.cc.signAndEncryptEnvelope(CH, (v, fp) => makeEnv(ALICE, fp, v));
  assert.equal(enc.kind, "encrypted");
  if (enc.kind !== "encrypted") return;

  const first = await bob.cc.openMessageForChannel(CH, enc.keyVersion, enc.body, { serverMsgID: "row-1", senderUserID: ALICE });
  assert.equal(first.duplicate, undefined);
  // history refetch: same row id is NOT a duplicate
  const same = await bob.cc.openMessageForChannel(CH, enc.keyVersion, enc.body, { serverMsgID: "row-1", senderUserID: ALICE });
  assert.equal(same.duplicate, undefined);
  // replay under a fresh server id: duplicate, render once
  const replayed = await bob.cc.openMessageForChannel(CH, enc.keyVersion, enc.body, { serverMsgID: "row-2", senderUserID: ALICE });
  assert.equal(replayed.duplicate, true);
});

test("legacy body opens as unsigned with its text", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, ALICE);
  const bob = await makeUser(server, BOB);
  await bootChannel([alice, bob], [ALICE, BOB]);

  const enc = await alice.cc.encryptForChannel(CH, "plain old text");
  assert.equal(enc.kind, "encrypted");
  if (enc.kind !== "encrypted") return;
  const opened = await bob.cc.openMessageForChannel(CH, enc.keyVersion, enc.body, { serverMsgID: "row-1", senderUserID: ALICE });
  assert.equal(opened.text, "plain old text");
  assert.equal(opened.verify, "unsigned");
  assert.equal(opened.env, undefined);
});

test("server frame relabeling yields mismatch (signature still valid)", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, ALICE);
  const bob = await makeUser(server, BOB);
  await bootChannel([alice, bob], [ALICE, BOB]);

  const enc = await alice.cc.signAndEncryptEnvelope(CH, (v, fp) => makeEnv(ALICE, fp, v));
  assert.equal(enc.kind, "encrypted");
  if (enc.kind !== "encrypted") return;
  // the server claims EVE sent it; the envelope says (and proves) ALICE
  const opened = await bob.cc.openMessageForChannel(CH, enc.keyVersion, enc.body, { serverMsgID: "row-1", senderUserID: EVE });
  assert.equal(opened.verify, "mismatch");
  assert.equal(opened.env?.senderUserID, ALICE); // inner truth, for rendering
});

test("member-on-member impersonation is forged", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, ALICE);
  const bob = await makeUser(server, BOB);
  const eve = await makeUser(server, EVE);
  await bootChannel([alice, bob, eve], [ALICE, BOB, EVE]);

  // bob pins alice by verifying one honest message first
  const honest = await alice.cc.signAndEncryptEnvelope(CH, (v, fp) => makeEnv(ALICE, fp, v));
  assert.equal(honest.kind, "encrypted");
  if (honest.kind !== "encrypted") return;
  await bob.cc.openMessageForChannel(CH, honest.keyVersion, honest.body, { serverMsgID: "row-0", senderUserID: ALICE });

  // eve (a member, holds the key) claims to be alice, signing with her own key
  const forged = await eve.cc.signAndEncryptEnvelope(CH, (v, fp) => makeEnv(ALICE, fp, v, { bodyText: "im alice trust me" }));
  assert.equal(forged.kind, "encrypted");
  if (forged.kind !== "encrypted") return;
  const opened = await bob.cc.openMessageForChannel(CH, forged.keyVersion, forged.body, { serverMsgID: "row-1", senderUserID: ALICE });
  assert.equal(opened.verify, "forged"); // eve's fp is not alice's pinned key
  assert.equal(opened.text, "im alice trust me"); // content still shown, under the warning
});

test("a sender with no published identity opens as unpinned, and is not replay-bound", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, ALICE);
  const bob = await makeUser(server, BOB);
  await bootChannel([alice, bob], [ALICE, BOB]);

  // dave never published an identity; craft his signed message directly with
  // the channel key from the shared cache.
  const daveId = await deriveIdentityFromMnemonic(await generateMnemonic());
  const held = await loadSpaceKey(CH, 1);
  assert.ok(held);
  const fp = await ed25519Fingerprint(daveId.ed25519Public);
  const signed = await signEnvelope(makeEnv(DAVE, fp, 1), daveId.ed25519Private);
  const body = b64(await encryptMessage(held!.key, CH, 1, signed));

  const opened = await bob.cc.openMessageForChannel(CH, 1, body, { serverMsgID: "row-1", senderUserID: DAVE });
  assert.equal(opened.verify, "unpinned");
  // unbound: seeing it later under another row must not read as replay
  const again = await bob.cc.openMessageForChannel(CH, 1, body, { serverMsgID: "row-2", senderUserID: DAVE });
  assert.equal(again.duplicate, undefined);
});

test("own echo verifies via self-resolution (no pin record for self)", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, ALICE);
  await bootChannel([alice], [ALICE]);

  const enc = await alice.cc.signAndEncryptEnvelope(CH, (v, fp) => makeEnv(ALICE, fp, v));
  assert.equal(enc.kind, "encrypted");
  if (enc.kind !== "encrypted") return;
  const opened = await alice.cc.openMessageForChannel(CH, enc.keyVersion, enc.body, { serverMsgID: "row-1", senderUserID: ALICE });
  assert.equal(opened.verify, "verified");
});

test("decryptForChannel flattens an envelope to display text (previews/search)", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, ALICE);
  await bootChannel([alice], [ALICE]);

  const enc = await alice.cc.signAndEncryptEnvelope(CH, (v, fp) => makeEnv(ALICE, fp, v, { bodyText: "preview me" }));
  assert.equal(enc.kind, "encrypted");
  if (enc.kind !== "encrypted") return;
  assert.equal(await alice.cc.decryptForChannel(CH, enc.keyVersion, enc.body), "preview me");
});

test("a non-message envelope in a message slot fails closed", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, ALICE);
  const bob = await makeUser(server, BOB);
  await bootChannel([alice, bob], [ALICE, BOB]);

  // seal a MALFORMED almost-envelope (domain prefix + garbage) directly
  const held = await loadSpaceKey(CH, 1);
  assert.ok(held);
  const junk = new TextEncoder().encode("chalk-msg-sig.v1 followed by junk");
  const body = b64(await encryptMessage(held!.key, CH, 1, junk));
  const opened = await bob.cc.openMessageForChannel(CH, 1, body, { serverMsgID: "row-1", senderUserID: ALICE });
  assert.equal(opened.verify, "unsigned"); // D.4: renders as unsigned...
  assert.equal(opened.text, PLACEHOLDER_FAILED); // ...but never its bytes as prose
});

// ---- 83-3: edits and reactions ------------------------------------------

import { OBJ_EDIT, OBJ_REACTION_SET, type EditEnvelope, type ReactionSetEnvelope } from "./envelope";

function makeEditEnv(
  sender: string,
  fp: Uint8Array,
  keyVersion: number,
  prevRevHash: Uint8Array | null,
  body: string,
): EditEnvelope {
  return {
    objType: OBJ_EDIT,
    channelID: CH,
    keyVersion,
    senderUserID: sender,
    senderEd25519Fp: fp,
    writerScope: SCOPE,
    clientMsgID: crypto.randomUUID(),
    targetSender: sender,
    targetScope: SCOPE,
    targetClientMsgID: "cccccccc-0000-4000-8000-00000000000c",
    prevRevHash,
    senderTs: Date.now(),
    bodyText: body,
    attachments: [],
  };
}

function makeReactionEnv(
  actor: string,
  fp: Uint8Array,
  keyVersion: number,
  emoji: string[],
): ReactionSetEnvelope {
  return {
    objType: OBJ_REACTION_SET,
    channelID: CH,
    keyVersion,
    actorUserID: actor,
    senderEd25519Fp: fp,
    writerScope: SCOPE,
    clientMsgID: crypto.randomUUID(),
    targetSender: ALICE,
    targetScope: SCOPE,
    targetClientMsgID: "cccccccc-0000-4000-8000-00000000000c",
    targetEnvHash: null,
    prevSetHash: null,
    senderTs: Date.now(),
    emoji,
  };
}

test("83-3: an edited message's current body (0x02) opens in the message feed", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, ALICE);
  const bob = await makeUser(server, BOB);
  await bootChannel([alice, bob], [ALICE, BOB]);

  const enc = await alice.cc.signAndEncryptEnvelope(CH, (v, fp) =>
    makeEditEnv(ALICE, fp, v, new Uint8Array(32).fill(9), "edited text"),
  );
  assert.equal(enc.kind, "encrypted");
  if (enc.kind !== "encrypted") return;
  const opened = await bob.cc.openMessageForChannel(CH, enc.keyVersion, enc.body, {
    serverMsgID: "row-1",
    senderUserID: ALICE,
  });
  assert.equal(opened.verify, "verified");
  assert.equal(opened.text, "edited text");
  assert.equal(opened.env?.objType, OBJ_EDIT);
  assert.ok(opened.raw); // the chain walk needs the envelope bytes
});

test("83-3: openEditForChannel verifies without an outer sender claim", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, ALICE);
  const bob = await makeUser(server, BOB);
  await bootChannel([alice, bob], [ALICE, BOB]);

  const enc = await alice.cc.signAndEncryptEnvelope(CH, (v, fp) =>
    makeEditEnv(ALICE, fp, v, null, "legacy-original edit"),
  );
  assert.equal(enc.kind, "encrypted");
  if (enc.kind !== "encrypted") return;
  const opened = await bob.cc.openEditForChannel(CH, enc.keyVersion, enc.body);
  assert.equal(opened.verify, "verified");
  assert.equal(opened.text, "legacy-original edit");
  // and a reaction envelope is refused in this slot
  const rx = await alice.cc.signAndEncryptEnvelope(CH, (v, fp) => makeReactionEnv(ALICE, fp, v, ["x"]));
  assert.equal(rx.kind, "encrypted");
  if (rx.kind !== "encrypted") return;
  const wrongSlot = await bob.cc.openEditForChannel(CH, rx.keyVersion, rx.body);
  assert.equal(wrongSlot.verify, "unsigned");
  assert.equal(wrongSlot.text, PLACEHOLDER_FAILED);
});

test("83-3: signed reaction sets round trip, incl. the sealed empty-set clear", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, ALICE);
  const bob = await makeUser(server, BOB);
  await bootChannel([alice, bob], [ALICE, BOB]);

  const set = await bob.cc.signAndEncryptEnvelope(CH, (v, fp) => makeReactionEnv(BOB, fp, v, ["👍", "🎉"]));
  assert.equal(set.kind, "encrypted");
  if (set.kind !== "encrypted") return;
  const opened = await alice.cc.openReactionSetForChannel(CH, set.keyVersion, set.body, BOB);
  assert.deepEqual(opened.emoji, ["👍", "🎉"]);
  assert.equal(opened.verify, "verified");
  assert.equal(opened.env?.actorUserID, BOB);
  assert.equal(opened.objectHashHex?.length, 64);

  // the clear: a signed sealed EMPTY set -- still verified, still hashed
  const clear = await bob.cc.signAndEncryptEnvelope(CH, (v, fp) => makeReactionEnv(BOB, fp, v, []));
  assert.equal(clear.kind, "encrypted");
  if (clear.kind !== "encrypted") return;
  const openedClear = await alice.cc.openReactionSetForChannel(CH, clear.keyVersion, clear.body, BOB);
  assert.deepEqual(openedClear.emoji, []);
  assert.equal(openedClear.verify, "verified");
  assert.equal(openedClear.objectHashHex?.length, 64);
});

test("83-3: a legacy sealed-JSON reaction set still opens, labelled unsigned", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, ALICE);
  await bootChannel([alice], [ALICE]);

  const sealed = await alice.cc.sealJSONForChannel(CH, ["👍"]);
  assert.equal(sealed.kind, "encrypted");
  if (sealed.kind !== "encrypted") return;
  const opened = await alice.cc.openReactionSetForChannel(CH, sealed.keyVersion, sealed.body, ALICE);
  assert.deepEqual(opened.emoji, ["👍"]);
  assert.equal(opened.verify, "unsigned");
});

test("83-3: a reaction set signed by an impersonating member renders as nothing", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, ALICE);
  const bob = await makeUser(server, BOB);
  const eve = await makeUser(server, EVE);
  await bootChannel([alice, bob, eve], [ALICE, BOB, EVE]);

  // bob pins alice first (one honest message)
  const honest = await alice.cc.signAndEncryptEnvelope(CH, (v, fp) => makeEnv(ALICE, fp, v));
  assert.equal(honest.kind, "encrypted");
  if (honest.kind !== "encrypted") return;
  await bob.cc.openMessageForChannel(CH, honest.keyVersion, honest.body, { serverMsgID: "r0", senderUserID: ALICE });

  // eve signs a set claiming ALICE as actor
  const forged = await eve.cc.signAndEncryptEnvelope(CH, (v, fp) => makeReactionEnv(ALICE, fp, v, ["💀"]));
  assert.equal(forged.kind, "encrypted");
  if (forged.kind !== "encrypted") return;
  const opened = await bob.cc.openReactionSetForChannel(CH, forged.keyVersion, forged.body, ALICE);
  assert.deepEqual(opened.emoji, []); // no warning surface for reactions: fail to nothing
  assert.equal(opened.verify, "forged");
});

test("third audit: previews of an EDITED message show its text, not a failure", async () => {
  await freshDevice();
  const server = makeServer();
  const alice = await makeUser(server, ALICE);
  await bootChannel([alice], [ALICE]);
  const enc = await alice.cc.signAndEncryptEnvelope(CH, (v, fp) =>
    makeEditEnv(ALICE, fp, v, new Uint8Array(32).fill(3), "edited preview text"),
  );
  assert.equal(enc.kind, "encrypted");
  if (enc.kind !== "encrypted") return;
  // the display-text path previews use (thread last-reply, conversation list)
  assert.equal(await alice.cc.decryptForChannel(CH, enc.keyVersion, enc.body), "edited preview text");
});
