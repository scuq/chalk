// Tests for src/crypto/guest-envelope.ts (80-17). A guest opens a signed
// envelope of a member to its body text, never to envelope bytes. The guest
// labels the text with the same verdicts that members use.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { deriveGuestLink, bytesToBase64 } from "./guest-link";
import { generateSpaceKey, encryptMessage, decryptMessage } from "./spacekey";
import { signEnvelope, ed25519Fingerprint, OBJ_MESSAGE, type MessageEnvelope } from "./envelope";
import type { DerivedIdentity } from "./identity";
import type { IdentityTransport } from "./identity-sync";
import { openGuestBody, guestSignerResolver } from "./guest-envelope";
import { PLACEHOLDER_FAILED } from "./channel-crypto";

const CH = "11111111-2222-3333-4444-555555555555";
const MEMBER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SCOPE = "0f0f0f0f-1e1e-2d2d-3c3c-4b4b4b4b4b4b";
const CMID = "12345678-9abc-def0-1234-56789abcdef0";
const OUTER = { channelID: CH, keyVersion: 1, senderUserID: MEMBER };

// Any derived identity stands in for a member: same key shapes, same self-sig.
async function identityFrom(fill: number): Promise<DerivedIdentity> {
  return (await deriveGuestLink(new Uint8Array(32).fill(fill))).identity;
}

function transportFor(id: DerivedIdentity | null, calls: string[] = [], fail = false): IdentityTransport {
  return {
    request: async <P, R>(type: string, payload?: P): Promise<R> => {
      calls.push(type + ":" + JSON.stringify(payload));
      if (fail) throw new Error("offline");
      assert.equal(type, "fetch_identity");
      if (!id) return { found: false } as R;
      return {
        found: true,
        user_id: MEMBER,
        generation: 1,
        x25519_pub: bytesToBase64(id.x25519Public),
        ed25519_pub: bytesToBase64(id.ed25519Public),
        self_sig: bytesToBase64(id.selfSig),
      } as R;
    },
  };
}

async function signedPlaintext(id: DerivedIdentity, text: string): Promise<Uint8Array> {
  const env: MessageEnvelope = {
    objType: OBJ_MESSAGE,
    channelID: CH,
    keyVersion: 1,
    senderUserID: MEMBER,
    senderEd25519Fp: await ed25519Fingerprint(id.ed25519Public),
    writerScope: SCOPE,
    clientMsgID: CMID,
    senderTs: 1760000000000,
    wseq: 1,
    reply: null,
    bodyText: text,
    attachments: [],
  };
  return signEnvelope(env, id.ed25519Private);
}

// Round-trip through the real seal, as the room does.
async function throughTheSeal(pt: Uint8Array): Promise<Uint8Array> {
  const sk = generateSpaceKey();
  const ct = await encryptMessage(sk, CH, 1, pt);
  const out = await decryptMessage(sk, CH, 1, ct);
  assert.ok(out, "seal round-trip");
  return out!;
}

test("a member's signed envelope opens to exactly its body text, verified", async () => {
  const member = await identityFrom(1);
  const pt = await throughTheSeal(await signedPlaintext(member, "hello from member"));
  const opened = await openGuestBody(pt, OUTER, guestSignerResolver(transportFor(member)));
  assert.equal(opened.text, "hello from member");
  assert.equal(opened.verify, "verified");
  assert.ok(!opened.text.includes("chalk-msg-sig"));
});

test("legacy bare text (the guest's own sends) passes through as unsigned", async () => {
  const pt = await throughTheSeal(new TextEncoder().encode("hello from guest"));
  const opened = await openGuestBody(pt, OUTER, guestSignerResolver(transportFor(null)));
  assert.deepEqual(opened, { text: "hello from guest", verify: "unsigned" });
});

test("a malformed envelope renders the placeholder, never its bytes", async () => {
  const member = await identityFrom(1);
  const signed = await signedPlaintext(member, "truncated");
  const opened = await openGuestBody(signed.subarray(0, signed.length - 1), OUTER, guestSignerResolver(transportFor(member)));
  assert.equal(opened.text, PLACEHOLDER_FAILED);
  assert.equal(opened.verify, "unsigned");
});

test("a signature by a key that is not the sender's current identity is forged; the text still shows", async () => {
  const signer = await identityFrom(1);
  const published = await identityFrom(2);
  const pt = await throughTheSeal(await signedPlaintext(signer, "who wrote this"));
  const opened = await openGuestBody(pt, OUTER, guestSignerResolver(transportFor(published)));
  assert.equal(opened.verify, "forged");
  assert.equal(opened.text, "who wrote this");
});

test("a sender whose identity cannot be fetched is unpinned; the text still shows", async () => {
  const member = await identityFrom(1);
  const pt = await throughTheSeal(await signedPlaintext(member, "still readable"));
  const offline = await openGuestBody(pt, OUTER, guestSignerResolver(transportFor(member, [], true)));
  assert.deepEqual(offline, { text: "still readable", verify: "unpinned" });
  const none = await openGuestBody(pt, OUTER, guestSignerResolver(transportFor(null)));
  assert.deepEqual(none, { text: "still readable", verify: "unpinned" });
});

test("the resolver fetches a sender's identity once per session", async () => {
  const member = await identityFrom(1);
  const calls: string[] = [];
  const resolve = guestSignerResolver(transportFor(member, calls));
  for (const text of ["one", "two", "three"]) {
    const pt = await throughTheSeal(await signedPlaintext(member, text));
    assert.equal((await openGuestBody(pt, OUTER, resolve)).verify, "verified");
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0], `fetch_identity:{"user_id":"${MEMBER}"}`);
});
