// 83-5: the client half of the atomic first-responder rotation. A fake
// server applies the same rule as store.RotateChannelKeyAtomic (exact
// roster, signed wraps, expected == current, one winner). Asserts: any
// member rotates; the loser of a race reads "stale" and then opens the
// winner's key; the removed member is wrapped for nothing; and a message
// sealed under the new version opens for every remaining member.

import "fake-indexeddb/auto";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { ChannelCrypto, type CryptoTransport, type ChannelCryptoIdentity } from "./channel-crypto";
import { deriveIdentity } from "./identity";
import { clearSpaceKeys, clearVerification, clearReplayRecords } from "./idb";
import { OBJ_MESSAGE, type MessageEnvelope } from "./envelope";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const CAROL = "cccccccc-0000-4000-8000-000000000003";
const CH = "11111111-2222-4333-8444-555555555555";
const SCOPE = "99999999-0000-4000-8000-000000000009";

function b64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

function makeServer() {
  const channelKeys = new Map<string, { suite: number; blobB64: string }>();
  const identities = new Map<string, { x: string; e: string; s: string }>();
  const ck = (c: string, v: number, r: string) => `${c}:${v}:${r}`;
  const state = { current: 1, dueFrom: null as number | null, roster: new Set<string>([ALICE, BOB, CAROL]) };
  function transportFor(): CryptoTransport {
    return {
      async request(type: string, p: any): Promise<any> {
        switch (type) {
          case "publish_identity":
            identities.set(p.__caller, { x: p.x25519_pub, e: p.ed25519_pub, s: p.self_sig });
            return { generation: 1 };
          case "fetch_identity": {
            const r = identities.get(p.user_id);
            if (!r) return { found: false, user_id: p.user_id };
            return { found: true, user_id: p.user_id, generation: 1, x25519_pub: r.x, ed25519_pub: r.e, self_sig: r.s };
          }
          case "publish_channel_key":
            channelKeys.set(ck(p.channel_id, p.key_version, p.recipient_id), { suite: p.wrap_suite, blobB64: p.blob });
            return {};
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
          case "rotate_channel_key": {
            // the atomic rule, serialized by JS's single thread
            if (!state.roster.has(p.__caller)) throw new Error("not_a_member");
            if (state.current !== p.expected_version || (state.dueFrom !== null && state.dueFrom !== p.expected_version)) {
              throw new Error(`stale_key_version: current_key_version is ${state.current}`);
            }
            const ids = new Set<string>((p.wraps ?? []).map((w: any) => w.recipient_id));
            if (ids.size !== state.roster.size || [...ids].some((id) => !state.roster.has(id))) {
              throw new Error("roster mismatch");
            }
            for (const w of p.wraps) {
              if (w.wrap_suite < 2) throw new Error("unsigned");
              channelKeys.set(ck(p.channel_id, p.expected_version + 1, w.recipient_id), { suite: w.wrap_suite, blobB64: w.blob });
            }
            state.current = p.expected_version + 1;
            state.dueFrom = null;
            return { channel_id: p.channel_id, current_key_version: state.current };
          }
        }
        throw new Error("unexpected " + type);
      },
    };
  }
  return { transportFor, state, channelKeys };
}

async function makeUser(server: ReturnType<typeof makeServer>, userID: string, seed: number) {
  const id = await deriveIdentity(new Uint8Array(64).fill(seed), 1);
  const base = server.transportFor();
  const transport: CryptoTransport = {
    request: (type, payload) => base.request(type, { ...(payload as any), __caller: userID }),
  };
  await transport.request("publish_identity", {
    x25519_pub: b64(id.x25519Public),
    ed25519_pub: b64(id.ed25519Public),
    self_sig: b64(id.selfSig),
  });
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
    objType: OBJ_MESSAGE, channelID: CH, keyVersion, senderUserID: sender, senderEd25519Fp: fp,
    writerScope: SCOPE, clientMsgID: crypto.randomUUID(), senderTs: Date.now(), wseq: 1, reply: null,
    bodyText: body, attachments: [],
  };
}

test("83-5: shrink, then two responders race -- one wins, the loser adopts, nobody wraps the removed member", async () => {
  await clearSpaceKeys();
  await clearReplayRecords();
  for (const id of [ALICE, BOB, CAROL]) await clearVerification(id);
  const server = makeServer();
  const alice = await makeUser(server, ALICE, 1);
  const bob = await makeUser(server, BOB, 2);
  const carol = await makeUser(server, CAROL, 3);
  void carol;
  const all = [ALICE, BOB, CAROL];
  assert.equal(await alice.ensureChannelKey(CH, all, ALICE), "ready");
  assert.equal(await bob.ensureChannelKey(CH, all, ALICE), "ready");
  assert.equal(await carol.ensureChannelKey(CH, all, ALICE), "ready");

  // carol is removed: the server marks the channel due from version 1
  server.state.roster.delete(CAROL);
  server.state.dueFrom = 1;
  const remaining = [ALICE, BOB];

  // bob (not the creator) and alice both respond; exactly one rotates
  const [ra, rb] = await Promise.all([
    alice.rotateChannelKeyAtomic(CH, remaining, 1),
    bob.rotateChannelKeyAtomic(CH, remaining, 1),
  ]);
  const kinds = [ra.kind, rb.kind].sort();
  assert.deepEqual(kinds, ["rotated", "stale"]);
  assert.equal(server.state.current, 2);
  assert.equal(server.state.dueFrom, null);
  // wraps at v2 exist for the survivors only
  assert.ok(server.channelKeys.has(`${CH}:2:${ALICE}`));
  assert.ok(server.channelKeys.has(`${CH}:2:${BOB}`));
  assert.equal(server.channelKeys.has(`${CH}:2:${CAROL}`), false);

  // the loser fetches the winner's wrap through the normal path and both
  // open a message sealed under v2
  const winner = ra.kind === "rotated" ? alice : bob;
  const loser = ra.kind === "rotated" ? bob : alice;
  assert.equal(await loser.ensureChannelKey(CH, remaining, ALICE), "ready");
  const fpOwner = ra.kind === "rotated" ? ALICE : BOB;
  const m = await winner.signAndEncryptEnvelope(CH, (v, fp) => env(fpOwner, fp, v, "under v2"));
  assert.equal(m.kind, "encrypted");
  if (m.kind !== "encrypted") return;
  assert.equal(m.keyVersion, 2);
  const opened = await loser.openMessageForChannel(CH, 2, m.body, { serverMsgID: "r1", senderUserID: fpOwner });
  assert.equal(opened.text, "under v2");
  assert.equal(opened.verify, "verified");
  // (carol has no v2 wrap server-side -- asserted above. She is not asked to
  // open the message here because every instance in this fixture shares one
  // fake-indexeddb, so the winner's cached key would be visible to her; real
  // devices have separate stores.)

  // a stale responder against the already-rotated channel is told so
  const late = await alice.rotateChannelKeyAtomic(CH, remaining, 1);
  assert.equal(late.kind, "stale");
  if (late.kind === "stale") assert.equal(late.current, 2);

  // 2-person channel: bob leaves, alice rotates alone with her own wrap
  server.state.roster.delete(BOB);
  server.state.dueFrom = 2;
  const solo = await alice.rotateChannelKeyAtomic(CH, [ALICE], 2);
  assert.equal(solo.kind, "rotated");
  assert.equal(server.state.current, 3);
});
