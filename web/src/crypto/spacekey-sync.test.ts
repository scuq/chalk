// Tests for crypto/spacekey-sync.ts (WS glue) and the idb.ts space-key
// cache. The sync layer is tested against a fake transport that mimics the
// server's channel-key acks; the cache is tested against fake-indexeddb
// (space keys are raw bytes, so they round-trip -- unlike the X25519
// CryptoKey, which needed the real-browser feasibility test).

// fake-indexeddb/auto registers globalThis.indexedDB so the space-key
// cache (idb.ts) is testable under Node. Test-only; not bundled into the app.
import "fake-indexeddb/auto";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  publishChannelKey,
  fetchChannelKey,
  fetchChannelKeyRecipients,
  type ChannelKeyTransport,
} from "./spacekey-sync";
import { generateSpaceKey, wrapSpaceKey, unwrapSpaceKey, type WrappedKey } from "./spacekey";
import { saveSpaceKey, loadSpaceKey, clearSpaceKeys } from "./idb";

function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// A fake transport: a tiny in-memory channel_keys table + the three acks.
function makeFakeServer() {
  const table = new Map<string, { suite: number; blobB64: string }>();
  const key = (c: string, v: number, r: string) => `${c}:${v}:${r}`;
  const ws: ChannelKeyTransport = {
    async request(type: string, payload?: any): Promise<any> {
      if (type === "publish_channel_key") {
        table.set(key(payload.channel_id, payload.key_version, payload.recipient_id), {
          suite: payload.wrap_suite,
          blobB64: payload.blob,
        });
        return { channel_id: payload.channel_id, key_version: payload.key_version, recipient_id: payload.recipient_id };
      }
      if (type === "fetch_channel_key") {
        // The fake "caller" is always recipient "me".
        const row = table.get(key(payload.channel_id, payload.key_version, "me"));
        if (!row) return { found: false, channel_id: payload.channel_id };
        return { found: true, channel_id: payload.channel_id, key_version: payload.key_version, wrap_suite: row.suite, blob: row.blobB64 };
      }
      if (type === "fetch_channel_key_recipients") {
        const recips: string[] = [];
        for (const k of table.keys()) {
          const [c, v, r] = k.split(":");
          if (c === payload.channel_id && Number(v) === payload.key_version) recips.push(r);
        }
        return { channel_id: payload.channel_id, key_version: payload.key_version, recipients: recips };
      }
      throw new Error("unexpected type " + type);
    },
  };
  return { ws, table };
}

async function makeRecipient(): Promise<{ priv: CryptoKey; pub: Uint8Array }> {
  const kp = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { priv: kp.privateKey, pub };
}

const CH = "11111111-2222-3333-4444-555555555555";
const VER = 1;

test("publish then fetch round-trips a wrap through the transport, unwraps correctly", async () => {
  const { ws } = makeFakeServer();
  const sk = generateSpaceKey();
  const me = await makeRecipient();
  const wrap = await wrapSpaceKey(sk, me.pub, CH, VER, "me");

  await publishChannelKey(ws, CH, VER, "me", wrap);
  const got = await fetchChannelKey(ws, CH, VER);
  assert.notEqual(got, null);
  assert.equal(got!.suite, wrap.suite);

  // The fetched wrap must unwrap to the original space key.
  const unwrapped = await unwrapSpaceKey(got as WrappedKey, me.priv, CH, VER, "me");
  assert.notEqual(unwrapped, null);
  assert.equal(bytesToHex(unwrapped!), bytesToHex(sk));
});

test("fetchChannelKey returns null when no wrap exists (waiting for access)", async () => {
  const { ws } = makeFakeServer();
  assert.equal(await fetchChannelKey(ws, CH, VER), null);
});

test("fetchChannelKey returns null on a malformed (non-base64) blob", async () => {
  const ws: ChannelKeyTransport = {
    async request() {
      return { found: true, channel_id: CH, key_version: VER, wrap_suite: 1, blob: "!!!not base64!!!" };
    },
  };
  // atob throws on invalid input -> caught -> null
  const got = await fetchChannelKey(ws, CH, VER).catch(() => "threw");
  assert.equal(got, null);
});

test("fetchChannelKeyRecipients lists who has a wrap; diff finds who's missing", async () => {
  const { ws } = makeFakeServer();
  const sk = generateSpaceKey();
  const me = await makeRecipient();
  const bob = await makeRecipient();
  await publishChannelKey(ws, CH, VER, "me", await wrapSpaceKey(sk, me.pub, CH, VER, "me"));
  await publishChannelKey(ws, CH, VER, "bob", await wrapSpaceKey(sk, bob.pub, CH, VER, "bob"));

  const have = await fetchChannelKeyRecipients(ws, CH, VER);
  assert.deepEqual(new Set(have), new Set(["me", "bob"]));

  // Diff against a member list to find who still needs the key.
  const members = ["me", "bob", "carol"];
  const missing = members.filter((m) => !have.includes(m));
  assert.deepEqual(missing, ["carol"]);
});

test("fetchChannelKeyRecipients returns [] when none exist", async () => {
  const { ws } = makeFakeServer();
  assert.deepEqual(await fetchChannelKeyRecipients(ws, CH, VER), []);
});

// ---- idb space-key cache (fake-indexeddb) ----

test("space-key cache: save then load round-trips raw bytes", async () => {
  await clearSpaceKeys();
  const sk = generateSpaceKey();
  await saveSpaceKey(CH, VER, sk);
  const got = await loadSpaceKey(CH, VER);
  assert.notEqual(got, null);
  assert.equal(bytesToHex(got!), bytesToHex(sk));
});

test("space-key cache: miss returns null; versions are independent", async () => {
  await clearSpaceKeys();
  assert.equal(await loadSpaceKey(CH, 99), null);
  const v1 = generateSpaceKey();
  const v2 = generateSpaceKey();
  await saveSpaceKey(CH, 1, v1);
  await saveSpaceKey(CH, 2, v2);
  assert.equal(bytesToHex((await loadSpaceKey(CH, 1))!), bytesToHex(v1));
  assert.equal(bytesToHex((await loadSpaceKey(CH, 2))!), bytesToHex(v2));
  assert.notEqual(bytesToHex(v1), bytesToHex(v2));
});

test("space-key cache: clear removes everything", async () => {
  const sk = generateSpaceKey();
  await saveSpaceKey(CH, VER, sk);
  await clearSpaceKeys();
  assert.equal(await loadSpaceKey(CH, VER), null);
});
