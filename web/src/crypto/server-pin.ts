// chalk -- 83-6: the home-server pin.
//
// Claim 3 of the revised trust model: a client can detect a MITM toward the
// server it originally registered with. The pin is the server's Ed25519
// identity, stored per origin in IndexedDB; the inner sealed channel
// (crypto/innerchan.ts, ws-client.ts) compares the key the server proves it
// holds against it at every connect.
//
//   registration  the trust anchor: pinned when the account is created
//                 (fetched over the same TLS as the signup form -- a MITM
//                 present at first registration wins that device, exactly
//                 the first-contact limit TOFU always has, stated plainly)
//   tofu          an account that predates phase 83 pins at its first login
//                 after the update (D.4)
//   repin         the wall: the user compared the fingerprint the server now
//                 presents with the one the operator announced and chose to
//                 trust it. Never silent.

import { loadServerPin, saveServerPin, type ServerPinRecord } from "./idb";
import { serverFingerprint } from "./innerchan";

export type { ServerPinRecord };

function originOf(): string {
  try {
    if (typeof window !== "undefined" && window.location?.origin) return window.location.origin;
  } catch {
    // stubbed/absent window in tests
  }
  return "chalk";
}

function toB64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** loadPinnedServerKey returns the pinned raw key for this origin, or null. */
export async function loadPinnedServerKey(origin = originOf()): Promise<Uint8Array | null> {
  try {
    const rec = await loadServerPin(origin);
    return rec ? fromB64(rec.ed25519PubB64) : null;
  } catch {
    return null; // storage unavailable: treated as no pin (TOFU), never as a wall
  }
}

/** pinServerKey writes the pin for this origin. */
export async function pinServerKey(
  pub: Uint8Array,
  source: ServerPinRecord["source"],
  origin = originOf(),
): Promise<ServerPinRecord> {
  const rec: ServerPinRecord = {
    origin,
    ed25519PubB64: toB64(pub),
    fingerprint: await serverFingerprint(pub),
    source,
    pinnedAt: Date.now(),
  };
  await saveServerPin(rec);
  return rec;
}

/**
 * fetchAndPinServerIdentity is the registration-time pin: GET the server's
 * identity over the signup TLS session and pin it. A server without an
 * identity key (404: dev stack) pins nothing and says so. Never throws --
 * registration must not fail because the pin could not be written.
 */
export async function fetchAndPinServerIdentity(): Promise<ServerPinRecord | null> {
  try {
    const res = await fetch("/api/server-identity", { credentials: "same-origin" });
    if (!res.ok) return null;
    const body = (await res.json()) as { ed25519_pub?: string };
    if (!body.ed25519_pub) return null;
    const pub = fromB64(body.ed25519_pub);
    if (pub.length !== 32) return null;
    return await pinServerKey(pub, "registration");
  } catch {
    return null;
  }
}
