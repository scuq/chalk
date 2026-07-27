// chalk-web -- cross-device sync of the notification rules, encrypted.
//
// The rules blob names people and channels the user has singled out --
// exactly the metadata user_preferences must not hand the server in the
// clear. So the blob rides the existing prefs sync (one flat key,
// `notify_rules_enc`, server-opaque, prefs_changed fan-out included) but
// only ever as AES-256-GCM ciphertext.
//
// The key is derived, not stored: HKDF-SHA256 over the identity's X25519
// private scalar with a dedicated salt/info pair. Every device that can
// read messages has the identity, so every device that should sync can
// derive the same key -- and nothing else can. Independent info string,
// so this derivation shares nothing with the ECDH uses of the scalar.
//
// Conflict model: whole-blob last-write-wins, same as the rest of prefs.
// On connect the server's copy is applied over the local cache (it is
// the shared latest); a server with no blob yet gets seeded from local.
// An undecryptable blob is IGNORED -- local rules keep working -- rather
// than replaced with defaults: one corrupt write must not eat a
// carefully built ruleset.

import { normalizeRulesConfig, type RulesConfig } from "./rules";
import { loadRulesConfig, saveRulesConfig, subscribeRulesConfig } from "./rules-store";

const HKDF_SALT = new TextEncoder().encode("chalk-notify-rules-salt-v1");
const HKDF_INFO = new TextEncoder().encode("chalk-notify-rules-v1");
const VERSION = 1;
const NONCE_BYTES = 12;

export const RULES_PREFS_KEY = "notify_rules_enc";

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

// The raw 32-byte scalar out of the stored (extractable) X25519 key.
export async function scalarFromX25519(x25519Private: CryptoKey): Promise<Uint8Array> {
  const jwk = await crypto.subtle.exportKey("jwk", x25519Private);
  if (!jwk.d) throw new Error("rules-sync: X25519 private JWK has no scalar");
  // JWK uses base64url without padding.
  const b64 = jwk.d.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = b64decode(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  if (!bytes || bytes.length !== 32) throw new Error("rules-sync: bad X25519 scalar");
  return bytes;
}

export async function rulesAesKey(scalar: Uint8Array): Promise<CryptoKey> {
  const root = await crypto.subtle.importKey("raw", scalar, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: HKDF_INFO },
    root,
    256,
  );
  return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

// blob = base64( nonce(12) || ciphertext ), plaintext = JSON {v, config}.
export async function sealRulesConfig(key: CryptoKey, config: RulesConfig): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify({ v: VERSION, config }));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext),
  );
  const out = new Uint8Array(NONCE_BYTES + ct.length);
  out.set(nonce);
  out.set(ct, NONCE_BYTES);
  return b64encode(out);
}

// Total over garbage: any failure -- bad base64, wrong key, tampering,
// unknown version -- is null, never a throw.
export async function openRulesConfig(key: CryptoKey, blob: string): Promise<RulesConfig | null> {
  const bytes = b64decode(blob);
  if (!bytes || bytes.length <= NONCE_BYTES) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, NONCE_BYTES) },
      key,
      bytes.slice(NONCE_BYTES),
    );
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as {
      v?: number;
      config?: unknown;
    };
    if (parsed?.v !== VERSION) return null;
    return normalizeRulesConfig(parsed.config);
  } catch {
    return null;
  }
}

// --- the orchestrator ---------------------------------------------------
//
// One instance per session, owned by App. Watches the local store and
// pushes edits up; applies server blobs down. The JSON-of-content guard
// breaks the loop both directions: applying a remote blob fires the
// store listeners, but push() sees unchanged content and stays quiet;
// our own upload comes back as a prefs echo, but the blob string matches
// and applyRemote stays quiet.

export interface RulesSyncTransport {
  send(patch: Record<string, unknown>): void;
}

export class RulesSync {
  private key: CryptoKey | null = null;
  private transport: RulesSyncTransport | null = null;
  private lastJSON: string | null = null;
  private lastBlob: string | null = null;
  private unsub: (() => void) | null = null;

  async start(x25519Private: CryptoKey, transport: RulesSyncTransport): Promise<void> {
    this.key = await rulesAesKey(await scalarFromX25519(x25519Private));
    this.transport = transport;
    this.unsub = subscribeRulesConfig((config) => {
      void this.push(config);
    });
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
    this.transport = null;
    this.key = null;
  }

  // Called with the server's current blob whenever prefs land (get ack,
  // set ack, or a change pushed from another device). undefined means
  // the server has never stored one -- seed it from local.
  async applyRemote(blob: string | undefined): Promise<void> {
    if (!this.key) return;
    if (blob === undefined) {
      await this.push(loadRulesConfig());
      return;
    }
    if (blob === this.lastBlob) return;
    const config = await openRulesConfig(this.key, blob);
    if (!config) {
      console.warn("rules-sync: undecryptable rules blob ignored; keeping local rules");
      return;
    }
    const json = JSON.stringify(config);
    this.lastBlob = blob;
    if (json === this.lastJSON) return;
    this.lastJSON = json;
    saveRulesConfig(config);
  }

  private async push(config: RulesConfig): Promise<void> {
    if (!this.key || !this.transport) return;
    const json = JSON.stringify(config);
    if (json === this.lastJSON) return;
    this.lastJSON = json;
    const blob = await sealRulesConfig(this.key, config);
    this.lastBlob = blob;
    this.transport.send({ [RULES_PREFS_KEY]: blob });
  }
}
