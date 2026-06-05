// web/src/mls/plaintext-cache.ts
//
// Phase 11c-4: device-local, encrypted-at-rest cache of decrypted MLS
// message plaintext, so a page reload can restore recently-read history
// without re-decrypting (which MLS forbids: decryptMessage consumes the
// ratchet key, so the same ciphertext cannot be decrypted twice).
//
// Security model:
//   * At rest (IndexedDB): AES-256-GCM ciphertext under the SAME 32-byte
//     device key CoreCrypto uses (getDeviceMlsKey). No new secret. The
//     cache is exactly as strong as CoreCrypto's own keystore: readable
//     on this device while the device key exists, opaque otherwise.
//   * In session: callers hold plaintext in normal memory/UI state, as
//     they already do. This module only governs the at-rest copy.
//
// Eviction: insertion-time TTL of 1 hour, applied LAZILY -- expired
// entries are purged when the cache is opened and skipped on read.
// There is no background sweep, so a tab/device left idle retains the
// last-cached plaintext on disk until the next open triggers the purge.
// This is a deliberate complexity tradeoff.
//
// Failure isolation (the load-bearing invariant): every operation is
// best-effort. Any failure -- DB won't open, key won't import, entry is
// corrupt, WebCrypto throws -- degrades to "no cache": get() returns
// null (treated as a miss -> caller falls back to live decrypt), put()
// silently no-ops. The cache can NEVER make decryption worse than the
// pre-cache behavior.

const DB_VERSION = 1;
const STORE = "plaintext";
const TTL_MS = 60 * 60 * 1000; // 1 hour, insertion-time

function dbName(userID: string): string {
  return `chalk-msgcache-${userID}`;
}

interface CacheEntry {
  // messageID is the IndexedDB key (out-of-line), not stored in value.
  iv: Uint8Array; // 12-byte AES-GCM nonce
  ct: Uint8Array; // AES-256-GCM ciphertext of the UTF-8 plaintext
  cachedAt: number; // epoch ms; TTL basis
}

// Import the raw 32-byte device key as a non-extractable AES-GCM key.
// Cached per userID for the module lifetime to avoid re-importing on
// every message.
const keyCache = new Map<string, Promise<CryptoKey>>();

function getAesKey(userID: string, rawKey: Uint8Array): Promise<CryptoKey> {
  let p = keyCache.get(userID);
  if (!p) {
    p = crypto.subtle.importKey(
      "raw",
      // copy to a clean ArrayBuffer backing (TS 5.6 BufferSource strictness;
      // importKey may also detach the buffer in some engines)
      rawKey.slice(),
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
    keyCache.set(userID, p);
  }
  return p;
}

function openDB(userID: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName(userID), DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE); // out-of-line keys (messageID)
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Lazily purge expired entries. Best-effort; errors swallowed.
async function purgeExpired(db: IDBDatabase): Promise<void> {
  try {
    const cutoff = Date.now() - TTL_MS;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) {
          resolve();
          return;
        }
        const entry = cursor.value as CacheEntry;
        if (!entry || typeof entry.cachedAt !== "number" || entry.cachedAt < cutoff) {
          try { cursor.delete(); } catch { /* ignore */ }
        }
        cursor.continue();
      };
      cursorReq.onerror = () => resolve(); // give up quietly
      tx.onerror = () => resolve();
    });
  } catch {
    /* best-effort */
  }
}

// Per-userID DB handle, opened once (with a purge), reused. On failure
// we store a rejected sentinel so callers fall through to live decrypt.
const dbCache = new Map<string, Promise<IDBDatabase | null>>();

function getDB(userID: string): Promise<IDBDatabase | null> {
  let p = dbCache.get(userID);
  if (!p) {
    p = (async () => {
      try {
        const db = await openDB(userID);
        await purgeExpired(db); // lazy eviction at open
        return db;
      } catch {
        return null; // cache disabled for this session
      }
    })();
    dbCache.set(userID, p);
  }
  return p;
}

/**
 * Look up cached plaintext for a message. Returns the UTF-8 string on a
 * fresh hit, or null on miss / expired / any failure (caller should then
 * attempt a live decrypt).
 */
export async function getCachedPlaintext(
  userID: string,
  rawKey: Uint8Array,
  messageID: string,
): Promise<string | null> {
  try {
    const db = await getDB(userID);
    if (!db) return null;

    const entry = await new Promise<CacheEntry | undefined>((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(messageID);
      req.onsuccess = () => resolve(req.result as CacheEntry | undefined);
      req.onerror = () => resolve(undefined);
    });
    if (!entry) return null;

    // Expired -> treat as miss (purge will clean it up later).
    if (typeof entry.cachedAt !== "number" || entry.cachedAt < Date.now() - TTL_MS) {
      return null;
    }
    if (!(entry.iv instanceof Uint8Array) || !(entry.ct instanceof Uint8Array)) {
      return null; // corrupt
    }

    const key = await getAesKey(userID, rawKey);
    const ptBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: entry.iv },
      key,
      entry.ct,
    );
    return new TextDecoder().decode(new Uint8Array(ptBuf));
  } catch {
    return null; // any failure == miss
  }
}

/**
 * Store plaintext for a message, encrypted at rest. Best-effort; silently
 * no-ops on any failure. Safe to call on every successful live decrypt.
 */
export async function putCachedPlaintext(
  userID: string,
  rawKey: Uint8Array,
  messageID: string,
  plaintext: string,
): Promise<void> {
  try {
    const db = await getDB(userID);
    if (!db) return;

    const key = await getAesKey(userID, rawKey);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ptBytes = new TextEncoder().encode(plaintext);
    const ctBuf = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      ptBytes,
    );
    const entry: CacheEntry = {
      iv,
      ct: new Uint8Array(ctBuf),
      cachedAt: Date.now(),
    };
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      const req = tx.objectStore(STORE).put(entry, messageID);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve(); // swallow
      tx.onerror = () => resolve();
    });
  } catch {
    /* best-effort */
  }
}


// Phase 11c-4 PR 2: derive the cache key for a message from its base64
// CIPHERTEXT. This is the shared correlation key between the sender
// (who caches at send time) and history (which returns the identical
// ciphertext bytes). SHA-256, hex-encoded. Deterministic and
// server-free. Falls back to the raw input on the (practically
// impossible) chance subtle.digest is unavailable, so the cache still
// functions rather than throwing.
export async function cacheKeyForCiphertext(b64Ciphertext: string): Promise<string> {
  try {
    const bytes = new TextEncoder().encode(b64Ciphertext);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const view = new Uint8Array(digest);
    let hex = "";
    for (let i = 0; i < view.length; i++) {
      hex += view[i].toString(16).padStart(2, "0");
    }
    return hex;
  } catch {
    // Degraded fallback: use the ciphertext string itself as the key.
    // Still correlates sender<->history (both have the same string);
    // only loses the fixed-length/opaque-key property.
    return b64Ciphertext;
  }
}
