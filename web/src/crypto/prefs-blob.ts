// chalk-web -- sealed preference blobs.
//
// Some prefs are metadata the server must not hold in the clear: the
// notification rules name the people and channels you singled out (50-6), the
// per-peer audio list names the people you silenced (66-3). Both ride the
// ordinary prefs sync -- one flat key, server-opaque, prefs_changed fan-out
// included -- but only ever as AES-256-GCM ciphertext.
//
// The key is derived, not stored: HKDF-SHA256 over the identity's X25519
// private scalar. Every device that can read messages has the identity, so
// every device that should sync can derive the same key -- and nothing else
// can. Each blob passes its own salt/info pair, so the keys are independent of
// each other and of the ECDH uses of the same scalar.
//
// Extracted from notify/rules-sync.ts in 66-3, wire format unchanged: the
// plaintext object is each caller's own (version field included), so an
// existing sealed blob still opens.

const NONCE_BYTES = 12;

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(s: string): Uint8Array | null {
  try {
    const raw = atob(s);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** The raw 32-byte scalar out of the stored (extractable) X25519 key. */
export async function scalarFromX25519(x25519Private: CryptoKey): Promise<Uint8Array> {
  const jwk = await crypto.subtle.exportKey("jwk", x25519Private);
  if (!jwk.d) throw new Error("prefs-blob: X25519 private JWK has no scalar");
  // JWK uses base64url without padding.
  const b64 = jwk.d.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = b64decode(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  if (!bytes || bytes.length !== 32) throw new Error("prefs-blob: bad X25519 scalar");
  return bytes;
}

/** blobKey derives one blob's AES-256-GCM key. Distinct salt/info per blob. */
export async function blobKey(
  scalar: Uint8Array,
  salt: string,
  info: string,
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const root = await crypto.subtle.importKey("raw", scalar, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(salt), info: enc.encode(info) },
    root,
    256,
  );
  return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** blob = base64( nonce(12) || ciphertext ), plaintext = JSON of `value`. */
export async function sealJSON(key: CryptoKey, value: unknown): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext),
  );
  const out = new Uint8Array(NONCE_BYTES + ct.length);
  out.set(nonce);
  out.set(ct, NONCE_BYTES);
  return b64encode(out);
}

/** Total over garbage: bad base64, wrong key, tampering and unparseable
 * plaintext are all null, never a throw. Callers version-check the result. */
export async function openJSON(key: CryptoKey, blob: string): Promise<unknown | null> {
  const bytes = b64decode(blob);
  if (!bytes || bytes.length <= NONCE_BYTES) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, NONCE_BYTES) },
      key,
      bytes.slice(NONCE_BYTES),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  } catch {
    return null;
  }
}
