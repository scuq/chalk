// Tests for src/crypto/guest-link.ts (80-12). The properties the magic link
// depends on: determinism (creator and guest derive the SAME identity from
// the same secret, independently), the creator-made wrap opening with the
// guest-derived key (the anti-substitution core), and fragment round-trips.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  deriveGuestLink,
  mintGuestLink,
  buildJoinURL,
  parseJoinFragment,
  openGuestWrap,
  bytesToBase64url,
  GUEST_SECRET_BYTES,
} from "./guest-link";
import { generateSpaceKey, wrapSpaceKeyUnsigned, wrapSpaceKeySigned, unwrapSpaceKey } from "./spacekey";
import { verifyIdentitySelfSig } from "./identity";

const SECRET_A = new Uint8Array(32).map((_, i) => i);
const SECRET_B = new Uint8Array(32).map((_, i) => 255 - i);

test("same secret derives the same lookup and keypair, independently", async () => {
  const creatorSide = await deriveGuestLink(new Uint8Array(SECRET_A));
  const guestSide = await deriveGuestLink(new Uint8Array(SECRET_A));

  assert.equal(creatorSide.lookupHex, guestSide.lookupHex);
  assert.equal(creatorSide.lookupHex.length, 32); // 16 bytes hex
  assert.deepEqual(creatorSide.identity.x25519Public, guestSide.identity.x25519Public);
  assert.deepEqual(creatorSide.identity.ed25519Public, guestSide.identity.ed25519Public);

  // The derived identity is a first-class one: its self-signature verifies,
  // so co-members' existing fetch-identity checks pass unchanged.
  assert.equal(
    await verifyIdentitySelfSig(
      guestSide.identity.x25519Public,
      guestSide.identity.ed25519Public,
      guestSide.identity.selfSig,
    ),
    true,
  );
});

test("different secrets derive different identities and lookups", async () => {
  const a = await deriveGuestLink(new Uint8Array(SECRET_A));
  const b = await deriveGuestLink(new Uint8Array(SECRET_B));
  assert.notEqual(a.lookupHex, b.lookupHex);
  assert.notDeepEqual(a.identity.x25519Public, b.identity.x25519Public);
});

test("a creator-made wrap opens with the guest-derived key", async () => {
  // Creator side: derive the guest's public key from the secret, reserve a
  // guest id, wrap the space key to it.
  const creatorSide = await deriveGuestLink(new Uint8Array(SECRET_A));
  const spaceKey = generateSpaceKey();
  const channelID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const guestID = "33333333-3333-3333-3333-333333333333";
  const wrap = await wrapSpaceKeyUnsigned(spaceKey, creatorSide.identity.x25519Public, { channelID, keyVersion: 1, recipientID: guestID });

  // Guest side: re-derive from the fragment alone and unwrap.
  const guestSide = await deriveGuestLink(new Uint8Array(SECRET_A));
  const opened = await unwrapSpaceKey(wrap, guestSide.identity.x25519Private, channelID, 1, guestID);
  assert.ok(opened, "wrap must open with the fragment-derived key");
  assert.deepEqual(opened, spaceKey);

  // A SUBSTITUTED identity (any key the creator did not derive) cannot open
  // it -- the server holding the wrap gains nothing by swapping keys.
  const mallory = await deriveGuestLink(new Uint8Array(SECRET_B));
  assert.equal(
    await unwrapSpaceKey(wrap, mallory.identity.x25519Private, channelID, 1, guestID),
    null,
  );
  // And the AAD pins the reserved guest id: the same wrap under another id
  // is dead too.
  assert.equal(
    await unwrapSpaceKey(wrap, guestSide.identity.x25519Private, channelID, 1, "44444444-4444-4444-4444-444444444444"),
    null,
  );
});

test("join URL and fragment round-trip, carrying the owner key", async () => {
  const m = await mintGuestLink();
  const ownerKey = new Uint8Array(32).map((_, i) => i + 7);
  const url = buildJoinURL("https://chat.example.org", m, ownerKey);
  assert.match(url, /^https:\/\/chat\.example\.org\/join\/[0-9a-f]{32}#[A-Za-z0-9_-]+$/);

  const frag = parseJoinFragment(new URL(url).hash);
  assert.ok(frag);
  assert.deepEqual(frag!.secret, m.secret);
  assert.deepEqual(frag!.ownerEd25519Pub, ownerKey);

  // Re-derivation from the parsed fragment lands on the same lookup.
  const rederived = await deriveGuestLink(frag!.secret);
  assert.equal(rederived.lookupHex, m.lookupHex);
});

// The fragment grew from 32 to 64 bytes; links minted before 82-7 are still in
// people's chat histories and must still parse -- as "no anchor", which is the
// distinction openGuestWrap needs.
test("a pre-82-7 fragment parses with no owner key", async () => {
  const m = await mintGuestLink();
  const frag = parseJoinFragment("#" + bytesToBase64url(m.secret));
  assert.ok(frag);
  assert.deepEqual(frag!.secret, m.secret);
  assert.equal(frag!.ownerEd25519Pub, null);
});

test("parseJoinFragment refuses malformed input", () => {
  assert.equal(parseJoinFragment(""), null);
  assert.equal(parseJoinFragment("#"), null);
  assert.equal(parseJoinFragment("#not-base64!!"), null);
  // Only the two defined lengths parse; anything else is refused rather than
  // truncated into a shape that happens to fit.
  assert.equal(parseJoinFragment("#" + bytesToBase64url(new Uint8Array(16))), null);
  assert.equal(parseJoinFragment("#" + bytesToBase64url(new Uint8Array(48))), null);
  assert.equal(parseJoinFragment("#" + bytesToBase64url(new Uint8Array(65))), null);
});

test("buildJoinURL refuses an owner key of the wrong size", async () => {
  const m = await mintGuestLink();
  assert.throws(() => buildJoinURL("https://x.org", m, new Uint8Array(31)));
});

test("mintGuestLink secrets are unique and sized", async () => {
  const a = await mintGuestLink();
  const b = await mintGuestLink();
  assert.equal(a.secret.length, GUEST_SECRET_BYTES);
  assert.notDeepEqual(a.secret, b.secret);
});

// ---- 82-7: the guest's trust decision ------------------------------------
//
// Before this slice a guest opened whatever wrap the server handed back. The
// derived identity meant the server could not read the room, but it could
// still SUBSTITUTE a key of its own -- seal it to the guest's public key (which
// it holds, having been given it at mint) and the guest would adopt it, joining
// a room the server can read while believing it joined the owner's.
//
// The fix has to work with what the guest actually has: no account, no pins, no
// prior state. The one thing it has that the server does not is the fragment.

const CH = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const GUEST_ID = "33333333-3333-3333-3333-333333333333";
const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const SLOT = { channelID: CH, keyVersion: 1, recipientID: GUEST_ID };

async function makeOwner() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { priv: kp.privateKey, pub };
}

test("guest opens a wrap signed by the owner named in the fragment", async () => {
  const guest = await deriveGuestLink(new Uint8Array(SECRET_A));
  const owner = await makeOwner();
  const spaceKey = generateSpaceKey();
  const wrap = await wrapSpaceKeySigned(
    spaceKey, guest.identity.x25519Public, SLOT, OWNER_ID, owner.priv, owner.pub,
  );

  const opened = await openGuestWrap(wrap, guest.identity.x25519Private, SLOT, OWNER_ID, owner.pub);
  assert.deepEqual(opened, spaceKey);
});

// THE attack this slice exists for. The server knows the guest's X25519 public
// key, so it can produce a flawless suite-1 wrap of a key it chose. Only the
// fragment says "a wrap for this link is signed", and that is what refuses it.
test("hostile: a substituted UNSIGNED wrap is refused when the fragment has an anchor", async () => {
  const guest = await deriveGuestLink(new Uint8Array(SECRET_A));
  const owner = await makeOwner();
  const serverKey = generateSpaceKey();
  const forged = await wrapSpaceKeyUnsigned(serverKey, guest.identity.x25519Public, SLOT);

  // It opens perfectly as a sealed box -- validity was never the question.
  assert.ok(await unwrapSpaceKey(forged, guest.identity.x25519Private, CH, 1, GUEST_ID));
  assert.equal(
    await openGuestWrap(forged, guest.identity.x25519Private, SLOT, OWNER_ID, owner.pub),
    null,
    "a downgrade to unsigned must be refused",
  );
});

test("hostile: a wrap signed by anyone but the fragment's owner is refused", async () => {
  const guest = await deriveGuestLink(new Uint8Array(SECRET_A));
  const owner = await makeOwner();
  const attacker = await makeOwner();
  const wrap = await wrapSpaceKeySigned(
    generateSpaceKey(), guest.identity.x25519Public, SLOT, OWNER_ID, attacker.priv, attacker.pub,
  );
  assert.equal(
    await openGuestWrap(wrap, guest.identity.x25519Private, SLOT, OWNER_ID, owner.pub),
    null,
  );
});

// owner_user_id comes from the server, but it is INSIDE the signed message, so
// re-labelling whose key this is breaks the signature instead of laundering it.
test("hostile: a mislabelled owner id fails verification", async () => {
  const guest = await deriveGuestLink(new Uint8Array(SECRET_A));
  const owner = await makeOwner();
  const wrap = await wrapSpaceKeySigned(
    generateSpaceKey(), guest.identity.x25519Public, SLOT, OWNER_ID, owner.priv, owner.pub,
  );
  assert.equal(
    await openGuestWrap(wrap, guest.identity.x25519Private, SLOT, "99999999-9999-9999-9999-999999999999", owner.pub),
    null,
  );
  assert.equal(
    await openGuestWrap(wrap, guest.identity.x25519Private, SLOT, "", owner.pub),
    null,
  );
});

// The compatibility direction, and its limit, stated honestly: a link minted
// before 82-7 has no anchor, so its unsigned wrap is still accepted -- those
// links keep working, and they keep the old exposure until they expire (hours).
test("a pre-82-7 link still opens its unsigned wrap", async () => {
  const guest = await deriveGuestLink(new Uint8Array(SECRET_A));
  const spaceKey = generateSpaceKey();
  const wrap = await wrapSpaceKeyUnsigned(spaceKey, guest.identity.x25519Public, SLOT);
  assert.deepEqual(
    await openGuestWrap(wrap, guest.identity.x25519Private, SLOT, OWNER_ID, null),
    spaceKey,
  );
});

// ...but a signature cannot be bolted onto a legacy link to look better than it
// is: with no anchor there is nothing to check it against, so it is refused
// rather than accepted on the strength of merely having a signature.
test("a signed wrap on an anchorless link is refused, not trusted", async () => {
  const guest = await deriveGuestLink(new Uint8Array(SECRET_A));
  const owner = await makeOwner();
  const wrap = await wrapSpaceKeySigned(
    generateSpaceKey(), guest.identity.x25519Public, SLOT, OWNER_ID, owner.priv, owner.pub,
  );
  assert.equal(
    await openGuestWrap(wrap, guest.identity.x25519Private, SLOT, OWNER_ID, null),
    null,
  );
});

test("guest wrap opening is total: malformed input returns null, never throws", async () => {
  const guest = await deriveGuestLink(new Uint8Array(SECRET_A));
  const owner = await makeOwner();
  for (const bad of [
    { suite: 2, blob: new Uint8Array(0) },
    { suite: 2, blob: new Uint8Array(187) },
    { suite: 1, blob: new Uint8Array(3) },
    { suite: 99, blob: new Uint8Array(188) },
  ]) {
    assert.equal(await openGuestWrap(bad, guest.identity.x25519Private, SLOT, OWNER_ID, owner.pub), null);
    assert.equal(await openGuestWrap(bad, guest.identity.x25519Private, SLOT, OWNER_ID, null), null);
  }
});
