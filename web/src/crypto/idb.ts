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
// v2 (phase 23d): adds the space_keys store for cached channel keys.
// v3 (phase 24): adds the verifications store for local-only safety-number
// verification records.
// v4 (att-2): adds the attachment_cache store for cached attachment CIPHERTEXT
// (full blobs + previews), so scroll-back doesn't re-fetch over the network.
// Ciphertext, not plaintext: every byte at rest stays key-protected, the same
// invariant as space keys and identity.
const DB_VERSION = 4;
const STORE = "identity";
const SPACE_KEY_STORE = "space_keys";
const VERIFICATION_STORE = "verifications";
const ATTACHMENT_CACHE_STORE = "attachment_cache";

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
      if (!db.objectStoreNames.contains(SPACE_KEY_STORE)) {
        db.createObjectStore(SPACE_KEY_STORE, { keyPath: "cacheKey" });
      }
      if (!db.objectStoreNames.contains(VERIFICATION_STORE)) {
        db.createObjectStore(VERIFICATION_STORE, { keyPath: "peerUserID" });
      }
      if (!db.objectStoreNames.contains(ATTACHMENT_CACHE_STORE)) {
        db.createObjectStore(ATTACHMENT_CACHE_STORE, { keyPath: "cacheKey" });
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
  storeName: string = STORE,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const req = fn(t.objectStore(storeName));
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

// ---- space-key cache (phase 23d) -------------------------------------
//
// Caches the UNWRAPPED channel space key (raw 32 bytes) per
// (channelID, keyVersion) so a channel doesn't re-fetch + re-unwrap its key
// on every open. Unlike the identity X25519 key, a space key is plain bytes
// (Uint8Array), which structured-clones into IndexedDB on every engine -- no
// JWK workaround needed. Keyed by "channelID:keyVersion".
//
// Security note: this widens the space key's at-rest exposure to the same
// level as the X25519 private key (already recoverable bytes at rest, by the
// Safari-forced JWK decision). A script with IndexedDB read access could read
// cached space keys; the 24-word phrase remains the root that gates deriving
// the identity needed to unwrap them in the first place.

interface SpaceKeyRecord {
  cacheKey: string; // "channelID:keyVersion"
  channelID: string;
  keyVersion: number;
  key: Uint8Array; // raw 32-byte space key
}

function spaceCacheKey(channelID: string, keyVersion: number): string {
  return `${channelID}:${keyVersion}`;
}

/** saveSpaceKey caches the unwrapped space key for a channel + version. */
export async function saveSpaceKey(channelID: string, keyVersion: number, key: Uint8Array): Promise<void> {
  const record: SpaceKeyRecord = {
    cacheKey: spaceCacheKey(channelID, keyVersion),
    channelID,
    keyVersion,
    key,
  };
  const db = await openDB();
  try {
    await tx(db, "readwrite", (s) => s.put(record), SPACE_KEY_STORE);
  } finally {
    db.close();
  }
}

/** loadSpaceKey returns the cached space key, or null if not cached. */
export async function loadSpaceKey(channelID: string, keyVersion: number): Promise<Uint8Array | null> {
  const db = await openDB();
  let rec: SpaceKeyRecord | undefined;
  try {
    rec = await tx<SpaceKeyRecord | undefined>(
      db,
      "readonly",
      (s) => s.get(spaceCacheKey(channelID, keyVersion)),
      SPACE_KEY_STORE,
    );
  } finally {
    db.close();
  }
  if (!rec || !(rec.key instanceof Uint8Array) || rec.key.length !== 32) return null;
  return rec.key;
}

/** clearSpaceKeys removes every cached space key (e.g. on logout-and-forget). */
export async function clearSpaceKeys(): Promise<void> {
  const db = await openDB();
  try {
    await tx(db, "readwrite", (s) => s.clear(), SPACE_KEY_STORE);
  } finally {
    db.close();
  }
}

// ---- safety-number verification records (phase 24, local-only) -------
//
// A user's decision that they compared a peer's safety number out of band and
// it matched. Stored LOCAL-ONLY: the server can neither read nor forge it,
// which is the whole point of out-of-band verification. Keyed by peer userID;
// pins the verified digest + the peer's generation so any later key change is
// detected (the digest will differ -> status "changed").

import type { VerificationRecord } from "./safety-number";

/** saveVerification records that the peer's current safety number was verified. */
export async function saveVerification(record: VerificationRecord): Promise<void> {
  const db = await openDB();
  try {
    await tx(db, "readwrite", (s) => s.put(record), VERIFICATION_STORE);
  } finally {
    db.close();
  }
}

/** loadVerification returns the stored record for a peer, or null. */
export async function loadVerification(peerUserID: string): Promise<VerificationRecord | null> {
  const db = await openDB();
  let rec: VerificationRecord | undefined;
  try {
    rec = await tx<VerificationRecord | undefined>(
      db,
      "readonly",
      (s) => s.get(peerUserID),
      VERIFICATION_STORE,
    );
  } finally {
    db.close();
  }
  return rec ?? null;
}

/** clearVerification removes a peer's verification record (e.g. on key change). */
export async function clearVerification(peerUserID: string): Promise<void> {
  const db = await openDB();
  try {
    await tx(db, "readwrite", (s) => s.delete(peerUserID), VERIFICATION_STORE);
  } finally {
    db.close();
  }
}

// ---- attachment ciphertext cache (att-2) -----------------------------
//
// Caches the SERVER'S CIPHERTEXT for an attachment (full blob or preview)
// keyed by "attachmentID:keyVersion:variant". Storing ciphertext -- not the
// decrypted image -- keeps the "only key-protected bytes touch disk" invariant:
// a profile attacker still needs the space-key store to read anything, exactly
// as for messages. On read we decrypt in memory, mint a transient object URL,
// and revoke it on eviction/unmount (that lifecycle lives in attachments/cache).
//
// The store is bounded by an LRU policy in attachments/cache.ts; this module
// only provides the raw persistence + a lightweight metadata listing (cacheKey,
// byteLen, lastAccess) so the policy can pick victims without loading blobs.

/** AttachmentCacheVariant distinguishes the full ciphertext from the preview. */
export type AttachmentCacheVariant = "full" | "preview";

interface AttachmentCacheRecord {
  cacheKey: string; // "attachmentID:keyVersion:variant"
  attachmentID: string;
  keyVersion: number;
  variant: AttachmentCacheVariant;
  bytes: Uint8Array; // ciphertext (suite||nonce||ct||tag), as fetched
  byteLen: number;
  lastAccess: number; // unix millis; bumped on read for LRU
}

/** AttachmentCacheEntryMeta is the blob-free view used by the LRU policy. */
export interface AttachmentCacheEntryMeta {
  cacheKey: string;
  byteLen: number;
  lastAccess: number;
}

function attachmentCacheKey(
  attachmentID: string,
  keyVersion: number,
  variant: AttachmentCacheVariant,
): string {
  return `${attachmentID}:${keyVersion}:${variant}`;
}

/** putAttachmentBlob stores (or overwrites) a ciphertext blob in the cache. */
export async function putAttachmentBlob(
  attachmentID: string,
  keyVersion: number,
  variant: AttachmentCacheVariant,
  bytes: Uint8Array,
): Promise<void> {
  const record: AttachmentCacheRecord = {
    cacheKey: attachmentCacheKey(attachmentID, keyVersion, variant),
    attachmentID,
    keyVersion,
    variant,
    bytes,
    byteLen: bytes.byteLength,
    lastAccess: Date.now(),
  };
  const db = await openDB();
  try {
    await tx(db, "readwrite", (s) => s.put(record), ATTACHMENT_CACHE_STORE);
  } finally {
    db.close();
  }
}

/**
 * getAttachmentBlob returns the cached ciphertext for an attachment variant, or
 * null if not cached. On a hit it bumps lastAccess (best-effort; a failed touch
 * never fails the read) so the LRU policy sees recency.
 */
export async function getAttachmentBlob(
  attachmentID: string,
  keyVersion: number,
  variant: AttachmentCacheVariant,
): Promise<Uint8Array | null> {
  const key = attachmentCacheKey(attachmentID, keyVersion, variant);
  const db = await openDB();
  let rec: AttachmentCacheRecord | undefined;
  try {
    rec = await tx<AttachmentCacheRecord | undefined>(
      db,
      "readonly",
      (s) => s.get(key),
      ATTACHMENT_CACHE_STORE,
    );
  } finally {
    db.close();
  }
  if (!rec || !(rec.bytes instanceof Uint8Array)) return null;
  // Best-effort recency bump in a separate transaction; ignore failures.
  void touchAttachmentBlob(key).catch(() => {});
  return rec.bytes;
}

async function touchAttachmentBlob(cacheKey: string): Promise<void> {
  const db = await openDB();
  try {
    // Single readwrite transaction: get + conditional put are atomic, so a
    // concurrent clear() can't interleave between them and resurrect an entry.
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(ATTACHMENT_CACHE_STORE, "readwrite");
      const store = t.objectStore(ATTACHMENT_CACHE_STORE);
      const getReq = store.get(cacheKey);
      getReq.onsuccess = () => {
        const rec = getReq.result as AttachmentCacheRecord | undefined;
        if (rec) {
          rec.lastAccess = Date.now();
          store.put(rec);
        }
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error("touch aborted"));
    });
  } finally {
    db.close();
  }
}

/** deleteAttachmentBlob removes one cached variant by its cache key. */
export async function deleteAttachmentBlob(cacheKey: string): Promise<void> {
  const db = await openDB();
  try {
    await tx(db, "readwrite", (s) => s.delete(cacheKey), ATTACHMENT_CACHE_STORE);
  } finally {
    db.close();
  }
}

/**
 * listAttachmentCacheMeta returns the blob-free metadata for every cache entry,
 * so the LRU policy can compute the total size and choose eviction victims
 * without loading the ciphertext into memory.
 */
export async function listAttachmentCacheMeta(): Promise<AttachmentCacheEntryMeta[]> {
  const db = await openDB();
  let recs: AttachmentCacheRecord[];
  try {
    recs = await tx<AttachmentCacheRecord[]>(
      db,
      "readonly",
      (s) => s.getAll(),
      ATTACHMENT_CACHE_STORE,
    );
  } finally {
    db.close();
  }
  return (recs ?? []).map((r) => ({
    cacheKey: r.cacheKey,
    byteLen: r.byteLen,
    lastAccess: r.lastAccess,
  }));
}

/** clearAttachmentCache removes every cached attachment blob (logout / settings). */
export async function clearAttachmentCache(): Promise<void> {
  const db = await openDB();
  try {
    await tx(db, "readwrite", (s) => s.clear(), ATTACHMENT_CACHE_STORE);
  } finally {
    db.close();
  }
}
