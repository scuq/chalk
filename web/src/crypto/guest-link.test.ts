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
  bytesToBase64url,
  GUEST_SECRET_BYTES,
} from "./guest-link";
import { generateSpaceKey, wrapSpaceKey, unwrapSpaceKey } from "./spacekey";
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
  const wrap = await wrapSpaceKey(spaceKey, creatorSide.identity.x25519Public, channelID, 1, guestID);

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

test("join URL and fragment round-trip", async () => {
  const m = await mintGuestLink();
  const url = buildJoinURL("https://chat.example.org", m);
  assert.match(url, /^https:\/\/chat\.example\.org\/join\/[0-9a-f]{32}#[A-Za-z0-9_-]+$/);

  const fragment = new URL(url).hash;
  const secret = parseJoinFragment(fragment);
  assert.ok(secret);
  assert.deepEqual(secret, m.secret);

  // Re-derivation from the parsed fragment lands on the same lookup.
  const rederived = await deriveGuestLink(secret!);
  assert.equal(rederived.lookupHex, m.lookupHex);
});

test("parseJoinFragment refuses malformed input", () => {
  assert.equal(parseJoinFragment(""), null);
  assert.equal(parseJoinFragment("#"), null);
  assert.equal(parseJoinFragment("#not-base64!!"), null);
  // wrong length
  assert.equal(parseJoinFragment("#" + bytesToBase64url(new Uint8Array(16))), null);
});

test("mintGuestLink secrets are unique and sized", async () => {
  const a = await mintGuestLink();
  const b = await mintGuestLink();
  assert.equal(a.secret.length, GUEST_SECRET_BYTES);
  assert.notDeepEqual(a.secret, b.secret);
});
