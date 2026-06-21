// chalk -- per-channel encryption orchestration.
//
// The stateful "brain" that sits between the App and the crypto/sync layers.
// App.tsx calls into this at three seams: on channel open (ensureChannelKey),
// on send (encryptForChannel), and on receive/history (decryptForChannel).
//
// Holds the unwrapped space keys in memory (mirroring the IndexedDB cache) so
// send/receive don't hit storage per message. All algorithm details live in
// spacekey.ts; this module only orchestrates fetch / unwrap / bootstrap /
// rewrap and the in-memory key map.
//
// KEY DISTRIBUTION (phase 23 design):
//   * key_version is fixed at 1 for now (rotation is phase 25).
//   * A channel with NO key is plaintext until its CREATOR bootstraps it.
//     Restricting bootstrap to the creator (created_by) makes it race-free:
//     two members opening at once can't mint two different keys. A read-back
//     reconcile covers the creator-on-two-devices case (last write wins on
//     the creator's own channel_keys row; both devices adopt it).
//   * Any key HOLDER auto-rewraps the (shared) key for members who lack it --
//     that's safe because they all hold the same key, so wraps converge.
//   * A member who joined an encrypted channel but hasn't been wrapped for yet
//     is "waiting": they can't send (App blocks it) until a holder wraps it.

import {
  generateSpaceKey,
  wrapSpaceKey,
  unwrapSpaceKey,
  encryptMessage,
  decryptMessage,
} from "./spacekey";
import {
  publishChannelKey,
  fetchChannelKey,
  fetchChannelKeyRecipients,
} from "./spacekey-sync";
import { fetchIdentity } from "./identity-sync";
import { loadSpaceKey, saveSpaceKey } from "./idb";

/** The current channel key version. Bumped to a per-channel value in phase 25. */
export const CURRENT_KEY_VERSION = 1;

/** Minimal identity this module needs: own user id + X25519 keypair. */
export interface ChannelCryptoIdentity {
  userID: string;
  x25519Private: CryptoKey; // usable for deriveBits (unwrap)
  x25519Public: Uint8Array;
}

/** request() surface (WSClient) used for the channel-key + identity frames. */
export interface CryptoTransport {
  request<P, R = unknown>(type: string, payload?: P): Promise<R>;
}

/**
 * The per-channel encryption status that gates the composer:
 *   ready     -- we hold the key; messages are encrypted.
 *   waiting   -- the channel is encrypted but our wrap hasn't arrived; the
 *                App blocks sending until a holder wraps the key for us.
 *   plaintext -- no key exists for this channel yet; sends go in the clear
 *                (legacy channels, until their creator bootstraps).
 */
export type ChannelKeyStatus = "ready" | "waiting" | "plaintext";

/** What encryptForChannel hands back to the send path. */
export type EncryptResult =
  | { kind: "encrypted"; body: string; keyVersion: number } // body is base64
  | { kind: "plaintext" }
  | { kind: "waiting" };

const PLACEHOLDER_NO_KEY = "[encrypted message \u2014 key not available yet]";
const PLACEHOLDER_FAILED = "[could not decrypt this message]";

export class ChannelCrypto {
  private readonly transport: CryptoTransport;
  private readonly identity: ChannelCryptoIdentity;
  // in-memory unwrapped keys, "channelID:version" -> 32 bytes
  private readonly keys = new Map<string, Uint8Array>();
  // channels known to have a key (so a missing in-memory key => "waiting")
  private readonly encrypted = new Set<string>();

  constructor(transport: CryptoTransport, identity: ChannelCryptoIdentity) {
    this.transport = transport;
    this.identity = identity;
  }

  private memKey(channelID: string, v: number): string {
    return `${channelID}:${v}`;
  }

  /** hasKey reports whether we currently hold the channel's key in memory. */
  hasKey(channelID: string, v: number = CURRENT_KEY_VERSION): boolean {
    return this.keys.has(this.memKey(channelID, v));
  }

  /** isEncrypted reports whether a key is known to exist for the channel. */
  isEncrypted(channelID: string): boolean {
    return this.encrypted.has(channelID);
  }

  private remember(channelID: string, v: number, key: Uint8Array): void {
    this.keys.set(this.memKey(channelID, v), key);
    this.encrypted.add(channelID);
  }

  // get the key from memory, then the idb cache (populating memory).
  private async getKey(channelID: string, v: number): Promise<Uint8Array | null> {
    const inMem = this.keys.get(this.memKey(channelID, v));
    if (inMem) return inMem;
    const cached = await loadSpaceKey(channelID, v);
    if (cached) {
      this.remember(channelID, v, cached);
      return cached;
    }
    return null;
  }

  /**
   * ensureChannelKey is called when a channel becomes active. It makes us hold
   * the channel's key if possible (fetch+unwrap our wrap, or bootstrap if we're
   * the creator and none exists), then auto-rewraps for any members who lack
   * it. Returns the status that gates the composer.
   */
  async ensureChannelKey(
    channelID: string,
    members: string[],
    createdBy: string,
  ): Promise<ChannelKeyStatus> {
    const v = CURRENT_KEY_VERSION;

    // already hold it (memory or idb)?
    const have = await this.getKey(channelID, v);
    if (have) {
      await this.rewrapForMissing(channelID, members, have);
      return "ready";
    }

    // try to fetch + unwrap our own wrap
    const wrap = await fetchChannelKey(this.transport, channelID, v);
    if (wrap) {
      const sk = await unwrapSpaceKey(wrap, this.identity.x25519Private, channelID, v, this.identity.userID);
      if (sk) {
        await saveSpaceKey(channelID, v, sk);
        this.remember(channelID, v, sk);
        await this.rewrapForMissing(channelID, members, sk);
        return "ready";
      }
      // a wrap exists for us but won't open (corrupt / wrong identity): the
      // channel is encrypted but we can't use it -> waiting.
      this.encrypted.add(channelID);
      return "waiting";
    }

    // no wrap for us. does any key exist at all?
    const recipients = await fetchChannelKeyRecipients(this.transport, channelID, v);
    if (recipients.length > 0) {
      // key exists, just not wrapped for us yet -> a holder will wrap it.
      this.encrypted.add(channelID);
      return "waiting";
    }

    // no key anywhere. Bootstrap iff we are the channel creator (race-free).
    if (this.identity.userID === createdBy) {
      const sk = generateSpaceKey();
      const selfWrap = await wrapSpaceKey(sk, this.identity.x25519Public, channelID, v, this.identity.userID);
      await publishChannelKey(this.transport, channelID, v, this.identity.userID, selfWrap);

      // read-back reconcile: if a concurrent bootstrap (our other device) won
      // the upsert on our channel_keys row, adopt that key instead of ours so
      // both devices converge before wrapping for anyone else.
      let finalSk = sk;
      const readback = await fetchChannelKey(this.transport, channelID, v);
      if (readback) {
        const rsk = await unwrapSpaceKey(readback, this.identity.x25519Private, channelID, v, this.identity.userID);
        if (rsk) finalSk = rsk;
      }
      await saveSpaceKey(channelID, v, finalSk);
      this.remember(channelID, v, finalSk);
      await this.rewrapForMissing(channelID, members, finalSk);
      return "ready";
    }

    // not the creator and no key yet: plaintext channel until the creator
    // bootstraps it.
    return "plaintext";
  }

  /**
   * rewrapForMissing wraps the (already-held) space key for every member who
   * doesn't yet have a wrap. Safe for any holder to run: all holders share the
   * same key, so concurrent rewraps converge on identical material.
   */
  private async rewrapForMissing(channelID: string, members: string[], sk: Uint8Array): Promise<void> {
    const v = CURRENT_KEY_VERSION;
    let have: Set<string>;
    try {
      have = new Set(await fetchChannelKeyRecipients(this.transport, channelID, v));
    } catch {
      return; // best-effort; a later open retries
    }
    for (const m of members) {
      if (m === this.identity.userID || have.has(m)) continue;
      try {
        const peer = await fetchIdentity(this.transport, m);
        if (!peer) continue; // peer hasn't published an identity yet; rewrap later
        const wrap = await wrapSpaceKey(sk, peer.x25519Public, channelID, v, m);
        await publishChannelKey(this.transport, channelID, v, m, wrap);
      } catch {
        // skip this member; a later open / channel event retries
      }
    }
  }

  /**
   * encryptForChannel prepares a message for sending. Returns an encrypted
   * base64 body (+ keyVersion) when we hold the key, "waiting" when the channel
   * is encrypted but our key hasn't arrived (App blocks the send), or
   * "plaintext" for a not-yet-encrypted channel.
   */
  async encryptForChannel(channelID: string, text: string): Promise<EncryptResult> {
    const v = CURRENT_KEY_VERSION;
    const sk = await this.getKey(channelID, v);
    if (sk) {
      const ct = await encryptMessage(sk, channelID, v, new TextEncoder().encode(text));
      return { kind: "encrypted", body: bytesToBase64(ct), keyVersion: v };
    }
    if (this.encrypted.has(channelID)) return { kind: "waiting" };
    return { kind: "plaintext" };
  }

  /**
   * decryptForChannel turns a received body into display text. A null/0
   * keyVersion is legacy plaintext (returned as-is). Otherwise it decrypts with
   * the channel key, returning a placeholder if the key isn't available yet or
   * the ciphertext won't open.
   */
  async decryptForChannel(channelID: string, keyVersion: number | undefined, body: string): Promise<string> {
    if (!keyVersion || keyVersion < 1) return body; // legacy plaintext
    const sk = await this.getKey(channelID, keyVersion);
    if (!sk) return PLACEHOLDER_NO_KEY;
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(body);
    } catch {
      return PLACEHOLDER_FAILED;
    }
    const pt = await decryptMessage(sk, channelID, keyVersion, bytes);
    return pt ? new TextDecoder().decode(pt) : PLACEHOLDER_FAILED;
  }
}

// ---- base64 (standard, matches Go base64.StdEncoding) ----

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
