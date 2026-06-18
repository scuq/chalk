// chalk -- local persistence of the cryptographic identity.
//
// Stores the DerivedIdentity (from crypto/identity.ts) in IndexedDB so a
// returning session doesn't have to re-prompt for the 24-word phrase.
//
// STORAGE STRATEGY (forced by a real browser difference, confirmed by the
// CryptoKey-in-IndexedDB feasibility test):
//   * Ed25519 private  -> stored as its NON-extractable CryptoKey object.
//     Structured-cloning an Ed25519 CryptoKey into IndexedDB works on all
//     three target engines, so the signing key keeps the strongest
//     protection (its bytes never exist in JS, and it cannot be exported
//     even after reload).
//   * X25519 private   -> stored as a JWK (which contains the private
//     scalar `d`). Safari/WebKit currently CANNOT structured-clone an
//     X25519 CryptoKey into IndexedDB (it reads back as a plain object),
//     so we persist the exportable JWK and re-import on load. We use the
//     JWK path uniformly (all engines) for a single code path.
//     CONSEQUENCE: the X25519 private key is recoverable bytes at rest,
//     and identity.ts imports it extractable so it can be exported. This
//     is a conscious, documented trade-off: a script with IndexedDB read
//     access could recover the X25519 decryption key. The 24-word phrase
//     is already the wallet-seed-grade root, so this widens the X25519
//     blast radius to what Safari forces; it does not affect Ed25519.
//
// loadIdentity hides this split: callers always get back a StoredIdentity
// with both private keys as usable CryptoKeys.
//
// Scope: per-user, one active identity per user on this device, keyed by
// user id. Browser-only (IndexedDB) -- no Node test ships; the feasibility
// test page and the in-app flow are its validation.

import type { DerivedIdentity } from "./identity";

const DB_NAME = "chalk";
const DB_VERSION = 1;
const STORE = "identity";

/** A loaded identity record, with both private keys as usable CryptoKeys. */
export interface StoredIdentity {
  userID: string;
  generation: number;
  x25519Private: CryptoKey;
  ed25519Private: CryptoKey;
  x25519Public: Uint8Array;
  ed25519Public: Uint8Array;
  selfSig: Uint8Array;
}

// The on-disk shape: X25519 as JWK, Ed25519 as a CryptoKey.
interface IdentityRecord {
  userID: string;
  generation: number;
  x25519PrivateJwk: JsonWebKey;
  ed25519Private: CryptoKey;
  x25519Public: Uint8Array;
  ed25519Public: Uint8Array;
  selfSig: Uint8Array;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "userID" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB.open failed"));
    req.onblocked = () => reject(new Error("indexedDB.open blocked"));
  });
}

function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    let result: T;
    req.onsuccess = () => {
      result = req.result;
    };
    req.onerror = () => reject(req.error);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error("transaction aborted"));
  });
}

/**
 * saveIdentity persists the derived identity for userID, overwriting any
 * existing record. The X25519 key is exported to JWK (identity.ts imports
 * it extractable for this purpose); the Ed25519 key is stored as-is.
 */
export async function saveIdentity(userID: string, identity: DerivedIdentity): Promise<void> {
  const x25519PrivateJwk = await crypto.subtle.exportKey("jwk", identity.x25519Private);
  const record: IdentityRecord = {
    userID,
    generation: identity.generation,
    x25519PrivateJwk,
    ed25519Private: identity.ed25519Private,
    x25519Public: identity.x25519Public,
    ed25519Public: identity.ed25519Public,
    selfSig: identity.selfSig,
  };
  const db = await openDB();
  try {
    await tx(db, "readwrite", (s) => s.put(record));
  } finally {
    db.close();
  }
}

/**
 * loadIdentity returns the stored identity for userID, re-importing the
 * X25519 key from its JWK, or null if none is present / the record is
 * malformed (e.g. a fresh device that must re-enter the phrase).
 */
export async function loadIdentity(userID: string): Promise<StoredIdentity | null> {
  const db = await openDB();
  let rec: IdentityRecord | undefined;
  try {
    rec = await tx<IdentityRecord | undefined>(db, "readonly", (s) => s.get(userID));
  } finally {
    db.close();
  }
  if (!rec) return null;
  // The Ed25519 key must survive structured-clone as a CryptoKey; the
  // X25519 JWK must be present. Anything else means a broken record.
  if (!(rec.ed25519Private instanceof CryptoKey) || !rec.x25519PrivateJwk) {
    return null;
  }
  let x25519Private: CryptoKey;
  try {
    x25519Private = await crypto.subtle.importKey(
      "jwk",
      rec.x25519PrivateJwk,
      { name: "X25519" },
      true,
      ["deriveBits"],
    );
  } catch {
    return null;
  }
  return {
    userID: rec.userID,
    generation: rec.generation,
    x25519Private,
    ed25519Private: rec.ed25519Private,
    x25519Public: rec.x25519Public,
    ed25519Public: rec.ed25519Public,
    selfSig: rec.selfSig,
  };
}

/** hasIdentity reports whether a usable identity is stored for userID. */
export async function hasIdentity(userID: string): Promise<boolean> {
  return (await loadIdentity(userID)) !== null;
}

/**
 * clearIdentity removes the stored identity for userID. Used on logout-and-
 * forget or before re-deriving a rotated identity.
 */
export async function clearIdentity(userID: string): Promise<void> {
  const db = await openDB();
  try {
    await tx(db, "readwrite", (s) => s.delete(userID));
  } finally {
    db.close();
  }
}
