// chalk -- 82-2 identity anchoring (trust-on-first-use pinning).
//
// WHY THIS EXISTS. Signing channel-key wraps (82-1) is only worth anything if
// the question "which Ed25519 key is Bob's?" has a trustworthy answer. Today it
// does not:
//
//   * identity_keys.self_sig is Ed25519(x25519_pub) and covers NEITHER the
//     user id NOR the generation (migration 0031);
//   * fetch_identity's answer is assembled by the server.
//
// So a malicious server mints a keypair, computes a perfectly valid self
// signature, serves it under Bob's user id, and signs a wrap with it. Every
// signature check passes. Binding user_id into self_sig would not help either:
// a self-signature is self-asserted, so the attacker simply picks both the key
// and the claimed id.
//
// The only sound anchors are out-of-band comparison (phase 24's picture words)
// and trust-on-first-use. This module adds the latter and makes both readable
// by the crypto path, which previously consulted neither.
//
// WHAT TOFU DOES AND DOESN'T BUY. A server that lies from the very first fetch
// of a peer gets its key pinned, and TOFU never detects that -- only picture-word
// verification does. What TOFU does close is every LATER substitution: having
// answered once, the server is committed, and any change is visible. That turns
// a silent, repeatable attack into a one-shot that has to be right before you
// have ever seen the peer.

import { loadVerification, saveVerification } from "./idb";
import { fetchIdentity, type IdentityTransport, type PeerIdentity } from "./identity-sync";
import type { VerificationRecord } from "./safety-number";

/**
 * PinState is the trust standing of an identity key we just saw.
 *
 *   first_seen         no pin existed; we just wrote one (TOFU)
 *   pinned             matches the pin we already held
 *   manually_verified  matches, and the user compared it out of band
 *   changed            a pin exists and this is NOT it -- treat as hostile
 */
export type PinState = "first_seen" | "pinned" | "manually_verified" | "changed";

/** trusted reports whether a pin state may be relied on to accept key material. */
export function trusted(pin: PinState): boolean {
  return pin === "first_seen" || pin === "pinned" || pin === "manually_verified";
}

export interface TrustedIdentity {
  identity: PeerIdentity;
  pin: PinState;
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * pinStateFor decides the standing of `ed25519Public` for a peer against the
 * stored record, and returns the record to write (null = leave storage alone).
 *
 * Pure, so the state machine is testable without IndexedDB.
 *
 * The pre-82 upgrade: records written before this slice have no pinned key. We
 * cannot tell from them whether the key we are looking at now is the one the
 * user verified -- only the caller's digest comparison can, and that is the
 * UI's job. So a keyless record is treated as "no pin for crypto purposes" and
 * upgraded in place on first sight, preserving its manual `source`.
 */
export function pinStateFor(
  stored: VerificationRecord | null,
  peerUserID: string,
  ed25519Public: Uint8Array,
  generation: number,
  now: number,
): { pin: PinState; write: VerificationRecord | null } {
  const b64 = toB64(ed25519Public);

  if (!stored) {
    return {
      pin: "first_seen",
      write: {
        peerUserID,
        digestHex: "",
        generation,
        verifiedAt: 0,
        ed25519PubB64: b64,
        source: "tofu",
        pinnedAt: now,
      },
    };
  }

  // Pre-82 record: adopt the key we see now, keeping its provenance. An absent
  // `source` means manual -- before 82 nothing but the button wrote here.
  if (!stored.ed25519PubB64) {
    const source = stored.source ?? "manual";
    return {
      pin: source === "manual" ? "manually_verified" : "pinned",
      write: { ...stored, ed25519PubB64: b64, source, pinnedAt: stored.pinnedAt ?? now },
    };
  }

  if (stored.ed25519PubB64 !== b64) {
    // Deliberately does NOT overwrite: the pin is the evidence. Note also that
    // a HIGHER `generation` must not auto-accept -- generation is server-
    // asserted, so that rule would hand the attack straight back.
    return { pin: "changed", write: null };
  }

  return { pin: (stored.source ?? "manual") === "manual" ? "manually_verified" : "pinned", write: null };
}

/**
 * fetchTrustedIdentity resolves a peer's identity and reports its pin standing,
 * writing a TOFU pin on first sight.
 *
 * Returns null only when the peer has no usable identity at all (no published
 * key, or a self-signature that does not verify). A "changed" peer still
 * returns -- with the flag -- because the CALLER decides what to do about it,
 * and the members panel needs the material to show the comparison.
 */
export async function fetchTrustedIdentity(
  ws: IdentityTransport,
  userID: string,
): Promise<TrustedIdentity | null> {
  const identity = await fetchIdentity(ws, userID);
  if (!identity) return null;

  const stored = await loadVerification(userID);
  const { pin, write } = pinStateFor(stored, userID, identity.ed25519Public, identity.generation, Date.now());
  if (write) await saveVerification(write);
  return { identity, pin };
}

/**
 * resolveSigner answers "whose key is this?" from local pins alone.
 *
 * Read-only and OFFLINE BY CONSTRUCTION -- it never calls the transport. That
 * matters: it is what lets the unattended warm path (which sweeps dozens of
 * channels with no user gesture) check provenance without turning into a burst
 * of identity fetches, and it guarantees the answer comes from what this device
 * already believed rather than from whatever the server says right now.
 *
 * Returns null when no pinned peer in `userIDs` owns the key -- including when
 * the owner's pin is "changed", since a repudiated pin is not an answer.
 */
export async function resolveSigner(
  candidateEd25519Pub: Uint8Array,
  userIDs: string[],
): Promise<{ userID: string; pin: "pinned" | "manually_verified" } | null> {
  const want = toB64(candidateEd25519Pub);
  for (const id of userIDs) {
    const rec = await loadVerification(id);
    if (!rec?.ed25519PubB64 || rec.ed25519PubB64 !== want) continue;
    return { userID: id, pin: (rec.source ?? "manual") === "manual" ? "manually_verified" : "pinned" };
  }
  return null;
}

/**
 * MemberTrust is what the members panel shows for one peer. Five states, not
 * three, because 82-2 gave the client a fourth thing to know and the old
 * vocabulary could not say it:
 *
 *   no_identity  the peer has published nothing to trust
 *   unverified   no pin at all -- we have never successfully seen this peer
 *   pinned       TOFU: we recognise this key, but nobody compared it in person
 *   verified     compared out of band, and the safety number still matches
 *   changed      the pin was repudiated, or a verified digest no longer matches
 */
export type MemberTrust = "no_identity" | "unverified" | "pinned" | "verified" | "changed";

/**
 * memberTrust combines the PIN state (whose key is this?) with the DIGEST
 * comparison (is this the number the user compared?) into the one label the
 * panel shows.
 *
 * It exists because doing this inline got it wrong. A TOFU record carries
 * `digestHex: ""` -- nothing was compared out of band -- and feeding that
 * straight to verificationState() reads "" !== <current digest> as **changed**,
 * so from 82-2 until this slice every peer showed "key changed" on first sight.
 * "Key changed" is the loudest badge in the product; making it the default was
 * both alarming and, worse, the thing that would train a user to ignore it.
 *
 * The rule: a repudiated pin outranks everything (it says "not who you
 * pinned", which is strictly graver than "not what you compared"); an empty
 * stored digest means never-compared, never mismatched.
 */
export function memberTrust(
  pin: PinState,
  currentDigestHex: string,
  stored: VerificationRecord | null,
): MemberTrust {
  if (pin === "changed") return "changed";
  if (!stored) return "unverified";
  if (!stored.digestHex) return "pinned"; // TOFU only; nothing was compared
  return stored.digestHex === currentDigestHex ? "verified" : "changed";
}

/**
 * markManuallyVerified upgrades a peer's record after an out-of-band picture-word
 * comparison. Never downgrades: a manual pin stays manual.
 */
export async function markManuallyVerified(
  peerUserID: string,
  ed25519Public: Uint8Array,
  digestHex: string,
  generation: number,
): Promise<void> {
  const now = Date.now();
  const stored = await loadVerification(peerUserID);
  await saveVerification({
    peerUserID,
    digestHex,
    generation,
    verifiedAt: now,
    ed25519PubB64: toB64(ed25519Public),
    source: "manual",
    pinnedAt: stored?.pinnedAt ?? now,
  });
}
