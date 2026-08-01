// chalk-web -- cross-device sync of the notification rules, encrypted.
//
// The rules blob names people and channels the user has singled out --
// exactly the metadata user_preferences must not hand the server in the
// clear. So the blob rides the existing prefs sync (one flat key,
// `notify_rules_enc`, server-opaque, prefs_changed fan-out included) but
// only ever as AES-256-GCM ciphertext.
//
// The sealing itself lives in crypto/prefs-blob.ts (66-3 extracted it, so
// the per-peer audio list could be sealed the same way); this module owns
// the rules' own salt, info, version and normalization.
//
// Conflict model: whole-blob last-write-wins, same as the rest of prefs.
// On connect the server's copy is applied over the local cache (it is
// the shared latest); a server with no blob yet gets seeded from local.
// An undecryptable blob is IGNORED -- local rules keep working -- rather
// than replaced with defaults: one corrupt write must not eat a
// carefully built ruleset.

import { normalizeRulesConfig, type RulesConfig } from "./rules";
import { loadRulesConfig, saveRulesConfig, subscribeRulesConfig } from "./rules-store";
import { blobKey, openJSON, scalarFromX25519, sealJSON } from "../crypto/prefs-blob";

const HKDF_SALT = "chalk-notify-rules-salt-v1";
const HKDF_INFO = "chalk-notify-rules-v1";
const VERSION = 1;

export const RULES_PREFS_KEY = "notify_rules_enc";

export { scalarFromX25519 };

export function rulesAesKey(scalar: Uint8Array): Promise<CryptoKey> {
  return blobKey(scalar, HKDF_SALT, HKDF_INFO);
}

// Plaintext = JSON {v, config}.
export function sealRulesConfig(key: CryptoKey, config: RulesConfig): Promise<string> {
  return sealJSON(key, { v: VERSION, config });
}

// Total over garbage: any failure -- bad base64, wrong key, tampering,
// unknown version -- is null, never a throw.
export async function openRulesConfig(key: CryptoKey, blob: string): Promise<RulesConfig | null> {
  const parsed = (await openJSON(key, blob)) as { v?: number; config?: unknown } | null;
  if (!parsed || parsed.v !== VERSION) return null;
  return normalizeRulesConfig(parsed.config);
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
