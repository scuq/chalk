// chalk-web -- cross-device sync of the per-peer local audio list, encrypted.
//
// "mute for me" is a decision about a person, not about the machine you made
// it on: silencing someone on the laptop and then hearing them again from the
// desktop is the list not working. So it follows the account -- but the list
// names who you have silenced and in which room, which is exactly the metadata
// user_preferences must not hold in the clear. It rides the prefs sync as an
// AES-256-GCM blob under an identity-derived key, the way the notification
// rules do (50-6); see crypto/prefs-blob.ts for the sealing and the reasoning.
//
// Conflict model: whole-blob last-write-wins, same as the rest of prefs. Two
// devices muting different people in the same minute means the later write
// wins outright rather than merging -- acceptable for a list that is edited by
// hand, one entry at a time, and never in bulk.
//
// An undecryptable blob is IGNORED rather than replaced with defaults: one
// corrupt write must not un-mute everyone you have ever silenced.

import { blobKey, openJSON, scalarFromX25519, sealJSON } from "../crypto/prefs-blob";
import {
  loadPeerAudioStore,
  normalizePeerAudioStore,
  savePeerAudioStore,
  subscribePeerAudioStore,
  type PeerAudioStore,
} from "./peer-audio-store";

const HKDF_SALT = "chalk-voice-peer-audio-salt-v1";
const HKDF_INFO = "chalk-voice-peer-audio-v1";
const VERSION = 1;

export const PEER_AUDIO_PREFS_KEY = "voice_peer_audio_enc";

// The server rejects a prefs patch over 8 KiB (prefsMaxBytes in ws.go). This
// list is the one blob here that grows with use, so it gets a ceiling of its
// own, under that cap with room for the patch envelope: roughly a hundred
// silenced people, which is far past what the feature is for. Over it, the
// list stays local and says so rather than the sync failing on the server
// with nothing to point at.
const MAX_BLOB_BYTES = 6 * 1024;

export function peerAudioAesKey(scalar: Uint8Array): Promise<CryptoKey> {
  return blobKey(scalar, HKDF_SALT, HKDF_INFO);
}

/** Plaintext = JSON {v, store}. */
export function sealPeerAudioStore(key: CryptoKey, store: PeerAudioStore): Promise<string> {
  return sealJSON(key, { v: VERSION, store });
}

/** Null on any failure -- bad base64, wrong key, tampering, unknown version. */
export async function openPeerAudioStore(
  key: CryptoKey,
  blob: string,
): Promise<PeerAudioStore | null> {
  const parsed = (await openJSON(key, blob)) as { v?: number; store?: unknown } | null;
  if (!parsed || parsed.v !== VERSION) return null;
  return normalizePeerAudioStore(parsed.store);
}

export interface PeerAudioSyncTransport {
  send(patch: Record<string, unknown>): void;
}

/**
 * One instance per session, owned by App. Watches the local store and pushes
 * edits up; applies server blobs down. The JSON-of-content guard breaks the
 * loop in both directions: applying a remote blob fires the store listeners,
 * but push() sees unchanged content and stays quiet; our own upload comes back
 * as a prefs echo, but the blob string matches and applyRemote stays quiet.
 *
 * The shape RulesSync established -- deliberately, so the two read the same.
 */
export class PeerAudioSync {
  private key: CryptoKey | null = null;
  private transport: PeerAudioSyncTransport | null = null;
  private lastJSON: string | null = null;
  private lastBlob: string | null = null;
  private unsub: (() => void) | null = null;

  async start(x25519Private: CryptoKey, transport: PeerAudioSyncTransport): Promise<void> {
    this.key = await peerAudioAesKey(await scalarFromX25519(x25519Private));
    this.transport = transport;
    this.unsub = subscribePeerAudioStore((store) => {
      void this.push(store);
    });
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
    this.transport = null;
    this.key = null;
  }

  /** Called with the server's current blob whenever prefs land (get ack, set
   * ack, or a change pushed from another device). undefined means the server
   * has never stored one -- seed it from local. */
  async applyRemote(blob: string | undefined): Promise<void> {
    if (!this.key) return;
    if (blob === undefined) {
      await this.push(loadPeerAudioStore());
      return;
    }
    if (blob === this.lastBlob) return;
    const store = await openPeerAudioStore(this.key, blob);
    if (!store) {
      console.warn("peer-audio-sync: undecryptable blob ignored; keeping the local list");
      return;
    }
    const json = JSON.stringify(store);
    this.lastBlob = blob;
    if (json === this.lastJSON) return;
    this.lastJSON = json;
    savePeerAudioStore(store);
  }

  private async push(store: PeerAudioStore): Promise<void> {
    if (!this.key || !this.transport) return;
    const json = JSON.stringify(store);
    if (json === this.lastJSON) return;
    this.lastJSON = json;
    const blob = await sealPeerAudioStore(this.key, store);
    if (blob.length > MAX_BLOB_BYTES) {
      console.warn(
        `peer-audio-sync: list too large to sync (${blob.length} B); it stays on this device`,
      );
      return;
    }
    this.lastBlob = blob;
    this.transport.send({ [PEER_AUDIO_PREFS_KEY]: blob });
  }
}
