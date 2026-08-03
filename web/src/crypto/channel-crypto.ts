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
  CURRENT_WRAP_SUITE,
  unwrapSpaceKeySigned,
  wrapSignerKey,
  encryptMessage,
  decryptMessage,
  WRAP_SUITE_X25519_AESGCM_ED25519,
  type WrappedKey,
  type WrapSlot,
  type WrapSigner,
} from "./spacekey";
import {
  publishChannelKey,
  fetchChannelKey,
  fetchChannelKeyRecipients,
  type ChannelKeyRecipients,
} from "./spacekey-sync";
import { fetchIdentity } from "./identity-sync";
import { fetchTrustedIdentity, resolveSigner } from "./trust";
import { loadSpaceKey, saveSpaceKey, channelHasSignedKey, type KeyProvenance } from "./idb";

export type { KeyProvenance };

/** The current channel key version. Bumped to a per-channel value in phase 25. */
export const CURRENT_KEY_VERSION = 1;

/**
 * Minimal identity this module needs: own user id, X25519 keypair for
 * wrapping, and (82-3) the Ed25519 pair used to sign wraps and to recognise
 * wraps produced by this user's other devices.
 */
export interface ChannelCryptoIdentity {
  userID: string;
  x25519Private: CryptoKey; // usable for deriveBits (unwrap)
  x25519Public: Uint8Array;
  ed25519Private: CryptoKey; // non-extractable, sign-only
  ed25519Public: Uint8Array;
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
// Phase 23f (fail-closed): a channel is either encrypted-and-usable ("ready")
// or you are blocked ("waiting") until your wrapped key arrives. There is no
// plaintext path -- the system never sends or shows cleartext.
export type ChannelKeyStatus = "ready" | "waiting";

/** What encryptForChannel hands back to the send path. */
export type EncryptResult =
  | { kind: "encrypted"; body: string; keyVersion: number } // body is base64
  | { kind: "waiting" };

/**
 * What encryptBytesForChannel hands back to the attachment upload path. Unlike
 * EncryptResult this carries raw ciphertext bytes (not base64): the attachment
 * blob is uploaded as an octet-stream, and enc_meta/enc_preview are base64'd by
 * the transport layer at the JSON boundary, not here.
 */
export type EncryptBytesResult =
  | { kind: "encrypted"; ciphertext: Uint8Array; keyVersion: number }
  | { kind: "waiting" };

// Exported since 61-1: search must recognize placeholder bodies so it can
// skip them (and deep search can count what this device couldn't decrypt)
// without retyping the strings and silently drifting.
export const PLACEHOLDER_NO_KEY = "[encrypted message \u2014 key not available yet]";
export const PLACEHOLDER_FAILED = "[could not decrypt this message]";
export const PLACEHOLDER_PLAINTEXT_BLOCKED = "[blocked: unencrypted message]";

/** A space key held in memory, together with how it came to be trusted. */
interface HeldKey {
  key: Uint8Array;
  prov: KeyProvenance;
}

// The two provenances that need no per-call detail. `UNSIGNED` marks a key
// opened from a suite-1 wrap -- legacy material only, since 82-5: every wrap
// this client produces is signed.
const SELF_MINTED: KeyProvenance = { kind: "self_minted" };
const UNSIGNED: KeyProvenance = { kind: "unsigned" };

/**
 * unattributed reports whether a provenance leaves the producer of the key
 * unknown. These are what the 82-5 ratchet withdraws once a channel has yielded
 * a signed wrap. Note `self_minted` is NOT one of them: our own material needs
 * no attribution, and treating it as a downgrade would break rotation.
 */
function unattributed(p: KeyProvenance): boolean {
  return p.kind === "unsigned" || p.kind === "legacy_cache";
}

/**
 * provenanceRank orders provenances by how strongly they attribute a key, for
 * the "same bytes, better story" upgrade in adopt(). Only the ORDER matters.
 */
function provenanceRank(p: KeyProvenance): number {
  switch (p.kind) {
    case "legacy_cache":
      return 0;
    case "unsigned":
      return 1;
    case "guest_link":
      return 2;
    case "signed":
      return p.trust === "pinned" ? 3 : 4; // manually_verified / self
    case "self_minted":
      return 5; // ours; nothing to trust
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export class ChannelCrypto {
  private readonly transport: CryptoTransport;
  private readonly identity: ChannelCryptoIdentity;
  // in-memory unwrapped keys, "channelID:version" -> key + provenance.
  //
  // 82-3: the value carries provenance so that adopting a key without saying
  // where it came from does not compile. That is the point: rotateChannelKey
  // used to write this map directly and bypass remember() entirely, and a
  // comment asking future edits not to do that again would not have held.
  private readonly keys = new Map<string, HeldKey>();
  // channels known to have a key (so a missing in-memory key => "waiting")
  private readonly encrypted = new Set<string>();
  // Phase 23g (deferred decrypt): channels whose ensureChannelKey has completed
  // at least once -- i.e. the key state is "settled" (we either hold it or we
  // genuinely don't yet). Used so a decrypt arriving DURING the channel-open
  // key fetch waits for it, while a decrypt on a settled keyless channel
  // returns the placeholder immediately (no artificial delay).
  private readonly settled = new Set<string>();
  // pending decrypts waiting for a channel's key to settle
  private readonly keyWaiters = new Map<string, Array<() => void>>();
  // safety-net cap on how long a decrypt waits for the key to settle. Normal
  // resolution is event-driven (ensureChannelKey settling), not this timeout.
  private readonly keyWaitMs: number;
  // Phase 25: the current key version per channel, as told to us by the server
  // (channels.current_key_version). New encryption uses this version; absence
  // defaults to CURRENT_KEY_VERSION (1). OLD messages still decrypt under the
  // version stamped on them (decryptForChannel), independent of this map.
  private readonly currentVersions = new Map<string, number>();
  // 82-5: channels this device has ever opened a SIGNED wrap for, memoized from
  // the key cache so the ratchet costs one read per channel per session.
  private readonly signedChannels = new Map<string, boolean>();
  // The identity every wrap this client produces is signed under.
  private readonly signer: WrapSigner;
  // 82-6: server policy from welcome.wrap_sig_required. When true, an unsigned
  // wrap is refused on the read path everywhere, not just on ratcheted
  // channels -- the soft window is over.
  private wrapSigRequired = false;

  constructor(
    transport: CryptoTransport,
    identity: ChannelCryptoIdentity,
    opts: { keyWaitMs?: number } = {},
  ) {
    this.transport = transport;
    this.identity = identity;
    this.keyWaitMs = opts.keyWaitMs ?? 8000;
    this.signer = {
      userID: identity.userID,
      ed25519Private: identity.ed25519Private,
      ed25519Public: identity.ed25519Public,
    };
  }

  /**
   * setWrapSigRequired records the server's enforcement policy
   * (welcome.wrap_sig_required). Latching -- once required, a later welcome
   * cannot relax it for this session: the flag arrives over the same channel
   * an attacker controls, so "the server says it's optional again" is exactly
   * the downgrade the flag exists to refuse.
   */
  setWrapSigRequired(required: boolean): void {
    if (required) this.wrapSigRequired = true;
  }

  // wake every decrypt waiting on this channel (key state just settled).
  private wakeKeyWaiters(channelID: string): void {
    const ws = this.keyWaiters.get(channelID);
    if (ws) {
      this.keyWaiters.delete(channelID);
      for (const w of ws) w();
    }
  }

  // resolve once the channel's key settles (ensureChannelKey completes or a key
  // is remembered), or after keyWaitMs as a safety net.
  private waitForKeySettled(channelID: string): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const fire = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      const arr = this.keyWaiters.get(channelID) ?? [];
      arr.push(fire);
      this.keyWaiters.set(channelID, arr);
      setTimeout(fire, this.keyWaitMs);
    });
  }

  private memKey(channelID: string, v: number): string {
    return `${channelID}:${v}`;
  }

  /**
   * setCurrentKeyVersion records the channel's current key version (from the
   * server). Monotonic: never moves backwards (a stale channel snapshot can't
   * lower it). New sends encrypt under this version.
   */
  setCurrentKeyVersion(channelID: string, v: number): void {
    if (v < 1) return;
    const prev = this.currentVersions.get(channelID) ?? CURRENT_KEY_VERSION;
    if (v > prev) this.currentVersions.set(channelID, v);
    else if (!this.currentVersions.has(channelID)) this.currentVersions.set(channelID, prev);
  }

  /** currentVersion is the channel's current key version (defaults to 1). */
  currentVersion(channelID: string): number {
    return this.currentVersions.get(channelID) ?? CURRENT_KEY_VERSION;
  }

  /** hasKey reports whether we currently hold the channel's key in memory. */
  hasKey(channelID: string, v: number = CURRENT_KEY_VERSION): boolean {
    return this.keys.has(this.memKey(channelID, v));
  }

  /** isEncrypted reports whether a key is known to exist for the channel. */
  isEncrypted(channelID: string): boolean {
    return this.encrypted.has(channelID);
  }

  /**
   * keyRecipients returns the set of member ids that currently HAVE a wrapped
   * key for the channel (i.e. a wrap exists for them server-side). This is the
   * source of the per-member "has key" vs "waiting" status in the members
   * panel. Note: a wrap existing means the member CAN unwrap it -- it does not
   * prove they have actually unwrapped/read it, which is unknowable here.
   */
  async keyRecipients(channelID: string): Promise<Set<string>> {
    try {
      const have = await fetchChannelKeyRecipients(this.transport, channelID, this.currentVersion(channelID));
      return new Set(have.ids);
    } catch {
      return new Set();
    }
  }

  /**
   * reshareKey wraps the channel key for every member who doesn't yet have a
   * wrap (the manual "re-share to all waiting members" action). Returns false
   * if we don't hold the key ourselves (nothing to share). Safe to call
   * repeatedly: members who already have a wrap are skipped.
   */
  async reshareKey(channelID: string, members: string[]): Promise<boolean> {
    const v = this.currentVersion(channelID);
    const sk = await this.getKey(channelID, v);
    if (!sk) return false;
    await this.rewrapForMissing(channelID, members, sk, v);
    return true;
  }

  /**
   * rotateChannelKey mints a NEW space key at newVersion and wraps it for every
   * current member (including ourselves), then caches it locally. This is the
   * client side of a manual, creator-only rotation (phase 25): after a member
   * is removed, rotating ensures the removed member -- who has no wrap at the
   * new version and is not in `members` -- cannot read anything sent under it.
   *
   * Caller contract:
   *   - newVersion MUST be exactly currentVersion(channelID) + 1 (monotonic);
   *     the server enforces this too.
   *   - `members` is the CURRENT membership (the removed member already gone).
   *   - only the channel creator should call this (race-free single minter),
   *     mirroring bootstrap; the server also restricts it to the creator.
   *
   * After this resolves, callers should advance the server's current_key_version
   * (so new sends use newVersion) and call setCurrentKeyVersion(newVersion).
   * Returns false if newVersion isn't a forward step.
   */
  async rotateChannelKey(
    channelID: string,
    members: string[],
    newVersion: number,
  ): Promise<boolean> {
    if (newVersion <= this.currentVersion(channelID)) return false;

    // fresh key material for the new version
    const sk = generateSpaceKey();

    // wrap for ourselves first so we hold the new version immediately
    const selfWrap = await wrapSpaceKey(
      sk,
      this.identity.x25519Public,
      { channelID, keyVersion: newVersion, recipientID: this.identity.userID },
      this.signer,
    );
    await publishChannelKey(this.transport, channelID, newVersion, this.identity.userID, selfWrap);
    // 82-3: goes through adopt() like every other adoption. It used to write
    // this.keys directly, which is how it escaped the module's one chokepoint.
    if (!(await this.adopt(channelID, newVersion, sk, SELF_MINTED))) return false;

    // wrap the new key for every other current member
    await this.rewrapForMissing(channelID, members, sk, newVersion);

    // adopt the new version locally (monotonic)
    this.setCurrentKeyVersion(channelID, newVersion);
    return true;
  }

  /**
   * wrapKeyForGuest seals the channel's CURRENT space key to a derived guest
   * identity and SIGNS it (82-7), returning the wrap plus everything the mint
   * frame and the link need. Returns null when we don't hold the key yet --
   * the mint UI must refuse rather than issue a link to a room the guest could
   * never decrypt (the ordering trap: ensureChannelKey is lazy and
   * creator-only).
   *
   * Replaces 80-12's exportKeyForMint, which handed the raw space key to a
   * component to wrap. Keeping the key inside this module is the point: the
   * signing identity is here, and a caller that receives plaintext key material
   * is a caller that can wrap it any way it likes -- including unsigned.
   */
  async wrapKeyForGuest(
    channelID: string,
    guestUserID: string,
    guestX25519Pub: Uint8Array,
  ): Promise<{ wrap: WrappedKey; version: number; ownerEd25519Pub: Uint8Array } | null> {
    const version = this.currentVersion(channelID);
    const key = await this.getKey(channelID, version);
    if (!key) return null;
    const wrap = await wrapSpaceKey(
      key,
      guestX25519Pub,
      { channelID, keyVersion: version, recipientID: guestUserID },
      this.signer,
    );
    return { wrap, version, ownerEd25519Pub: this.identity.ed25519Public };
  }

  /**
   * openWrap is the single decision point for "may this wrap be opened, and on
   * what basis?" -- 82-4. Returns the key with the provenance that justified
   * it, or null to refuse.
   *
   * The governing rule, applied here and relied on by every caller:
   *
   *     An INVALID signature is always fatal.
   *     A MISSING signature is a legacy wrap, governed by the soft window.
   *
   * `candidates` are the user ids that could legitimately have signed -- the
   * channel's members. Membership is server-asserted, so this is not a
   * cryptographic guarantee; see the phase doc for exactly what that costs.
   *
   * `allowNetwork` is false on the unattended warm path, which sweeps dozens of
   * channels with no user gesture and must not turn into a burst of identity
   * fetches. There it can only accept signers this device has already pinned.
   */
  private async openWrap(
    wrap: WrappedKey,
    channelID: string,
    v: number,
    candidates: string[],
    allowNetwork: boolean,
  ): Promise<{ key: Uint8Array; prov: KeyProvenance } | null> {
    const slot: WrapSlot = { channelID, keyVersion: v, recipientID: this.identity.userID };

    if (wrap.suite !== WRAP_SUITE_X25519_AESGCM_ED25519) {
      // Legacy unsigned wrap. Accepting it is the soft window, and the 82-6
      // enforcement flag is what withdraws it: when the operator has flipped
      // CHALK_WRAP_SIG_REQUIRED, an unsigned wrap is refused here outright --
      // the caller reports "waiting" and the member recovers via a re-share,
      // which produces a signed wrap.
      if (this.wrapSigRequired) {
        console.error(
          "channel-crypto: refusing an unsigned wrap for",
          channelID,
          "-- this server requires signed key wraps.",
        );
        return null;
      }
      const key = await unwrapSpaceKey(wrap, this.identity.x25519Private, channelID, v, this.identity.userID);
      return key ? { key, prov: UNSIGNED } : null;
    }

    const signerPub = wrapSignerKey(wrap);
    if (!signerPub) return null;

    // Signed by us -- another of this user's devices. Identity is per-user, so
    // this is certainty rather than trust, and it needs no lookup at all. This
    // is the case that makes the bootstrap read-back exact.
    if (bytesEqual(signerPub, this.identity.ed25519Public)) {
      const key = await unwrapSpaceKeySigned(
        wrap,
        this.identity.x25519Private,
        slot,
        this.identity.userID,
        signerPub,
      );
      return key ? { key, prov: { kind: "signed", signerUserID: this.identity.userID, trust: "self" } } : null;
    }

    // Signed by someone else: only a peer this device has already pinned can
    // be resolved. Note the user id we verify with is OUR belief about whose
    // key this is, not a claim carried in the blob -- so a wrap signed while
    // claiming a different id fails verification rather than being accepted.
    let owner = await resolveSigner(signerPub, candidates);
    if (!owner && allowNetwork) {
      for (const id of candidates) {
        if (id === this.identity.userID) continue;
        await fetchTrustedIdentity(this.transport, id); // pins on first sight
      }
      owner = await resolveSigner(signerPub, candidates);
    }
    if (!owner) return null;

    const key = await unwrapSpaceKeySigned(
      wrap,
      this.identity.x25519Private,
      slot,
      owner.userID,
      signerPub,
    );
    return key ? { key, prov: { kind: "signed", signerUserID: owner.userID, trust: owner.pin } } : null;
  }

  /**
   * adopt is the ONLY way a key is taken into durable use, and the one place
   * the two standing rules of 82-5 are applied. Returns false when the material
   * was refused -- callers then report "waiting" rather than pretending to hold
   * a key.
   *
   * NEVER-REPLACE. A (channel, version) slot names one key for all time: every
   * holder wraps the same bytes, and genuinely new material gets a new version.
   * So a wrap that opens to DIFFERENT bytes than the slot already holds is not
   * a fresher answer, it is a second answer -- which only an attacker or a bug
   * produces. The held key stays.
   *
   * DOWNGRADE RATCHET. Once this device has opened a signed wrap for a channel,
   * an unsigned wrap for that channel is refused at ANY version, including
   * versions minted later. Per-CHANNEL rather than per-slot is the entire
   * point: never-replace already covers a slot that has been filled, so a server
   * stripping signatures would simply wait for a rotation and answer the fresh
   * slot in suite 1. Provenance is persisted precisely so this survives reload.
   */
  private async adopt(
    channelID: string,
    v: number,
    key: Uint8Array,
    prov: KeyProvenance,
  ): Promise<boolean> {
    const existing = await this.existingKey(channelID, v);
    if (existing) {
      if (!bytesEqual(existing.key, key)) {
        console.error(
          "channel-crypto: refusing a second, different key for",
          channelID,
          `v${v}`,
          "-- a filled key slot is never replaced.",
        );
        return false;
      }
      // Same bytes, so this is not an adoption at all. Keep the better-attested
      // account of where they came from: an existing channel's legacy key being
      // re-offered as signed is what arms the ratchet for it.
      const upgrade = provenanceRank(prov) > provenanceRank(existing.prov);
      const best = upgrade ? prov : existing.prov;
      if (upgrade) await saveSpaceKey(channelID, v, key, best);
      this.remember(channelID, v, key, best);
      if (best.kind === "signed") this.signedChannels.set(channelID, true);
      return true;
    }

    if (unattributed(prov) && (await this.channelIsSigned(channelID))) {
      console.error(
        "channel-crypto: refusing an unsigned key for",
        channelID,
        "-- this device has already accepted a signed one for this channel.",
      );
      return false;
    }

    await saveSpaceKey(channelID, v, key, prov);
    this.remember(channelID, v, key, prov);
    if (prov.kind === "signed") this.signedChannels.set(channelID, true);
    return true;
  }

  // Whether this device has ever opened a signed wrap for the channel, from the
  // session memo or the persisted cache. A cache read failure cannot prove the
  // channel was ever signed, so it does not engage the ratchet -- and is not
  // memoized, so the next adoption asks again rather than inheriting the doubt.
  private async channelIsSigned(channelID: string): Promise<boolean> {
    const memo = this.signedChannels.get(channelID);
    if (memo !== undefined) return memo;
    let signed: boolean;
    try {
      signed = await channelHasSignedKey(channelID);
    } catch {
      return false;
    }
    this.signedChannels.set(channelID, signed);
    return signed;
  }

  // The key already recorded for a slot, from memory or the cache. Distinct
  // from getKey(): this must NOT populate memory, because it runs inside the
  // decision about whether the incoming material may be trusted at all.
  private async existingKey(channelID: string, v: number): Promise<HeldKey | null> {
    const held = this.heldKey(channelID, v);
    if (held) return held;
    const cached = await loadSpaceKey(channelID, v);
    return cached ? { key: cached.key, prov: cached.provenance } : null;
  }

  /**
   * remember is the ONLY way a key enters this module's memory. Provenance is a
   * required argument so that a caller must state what it is trusting.
   */
  private remember(channelID: string, v: number, key: Uint8Array, prov: KeyProvenance): void {
    this.keys.set(this.memKey(channelID, v), { key, prov });
    this.encrypted.add(channelID);
    this.wakeKeyWaiters(channelID); // a deferred decrypt can now proceed
  }

  // get the key from memory, then the idb cache (populating memory). The idb
  // record carries its own provenance forward rather than having one invented
  // for it here.
  private async getKey(channelID: string, v: number): Promise<Uint8Array | null> {
    const held = this.heldKey(channelID, v);
    if (held) return held.key;
    const cached = await loadSpaceKey(channelID, v);
    if (cached) {
      this.remember(channelID, v, cached.key, cached.provenance);
      return cached.key;
    }
    return null;
  }

  /** heldKey returns the in-memory entry (key + provenance) for a slot. */
  private heldKey(channelID: string, v: number): HeldKey | undefined {
    return this.keys.get(this.memKey(channelID, v));
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
    try {
      return await this.ensureChannelKeyInner(channelID, members, createdBy);
    } finally {
      // The key state is now settled (we hold it, or we genuinely don't yet).
      // Mark it and release any decrypts that were deferred waiting for it.
      this.settled.add(channelID);
      this.wakeKeyWaiters(channelID);
    }
  }

  /**
   * warmChannelKey makes this client hold a channel's key if it already can,
   * for READING ONLY, and settles the channel either way.
   *
   * ensureChannelKey is the wrong tool for the thread inbox. It also bootstraps
   * (when we are the creator) and rewraps the key for every member who lacks one
   * -- a recipients probe plus an identity fetch plus a publish, per member, per
   * channel. Opening an inbox that spans forty channels would fire all of that
   * at once, to render forty one-line previews.
   *
   * What a preview needs is narrower: fetch our own wrap, unwrap it, remember
   * it, and -- the load-bearing part -- mark the channel SETTLED so
   * decryptForChannel stops taking the deferred-wait branch. Without the settle,
   * every preview from a channel we have not opened this session blocks for
   * keyWaitMs before showing a placeholder anyway.
   *
   * Deliberately does NOT report a ChannelKeyStatus: status gates the COMPOSER,
   * and warming a channel to read one line must never claim we are ready to
   * send in it.
   *
   * 82-4: `members` names who may legitimately have signed the wrap. An empty
   * list means only this user's own devices qualify -- correct-but-strict, so
   * callers that have the roster to hand should pass it.
   */
  async warmChannelKey(channelID: string, members: string[] = []): Promise<void> {
    try {
      const v = this.currentVersion(channelID);
      if (await this.getKey(channelID, v)) return;
      const wrap = await fetchChannelKey(this.transport, channelID, v);
      if (!wrap) {
        // No wrap for us. Someone else may deposit one later; key_available
        // re-runs the preview decrypt when they do.
        this.encrypted.add(channelID);
        return;
      }
      // 82-4: no network. A warm that cannot resolve the signer from existing
      // pins leaves the channel unwarmed (it already renders a placeholder);
      // the next deliberate open resolves it properly.
      const opened = await this.openWrap(wrap, channelID, v, members, false);
      if (!opened || !(await this.adopt(channelID, v, opened.key, opened.prov))) {
        this.encrypted.add(channelID);
        return;
      }
    } catch {
      // A warm is best-effort: a preview that cannot be decrypted renders a
      // placeholder, which is strictly better than a panel that never fills.
    } finally {
      // Settle even on failure, so a keyless channel produces an IMMEDIATE
      // placeholder instead of one 8-second stall per row.
      this.settled.add(channelID);
      this.wakeKeyWaiters(channelID);
    }
  }

  private async ensureChannelKeyInner(
    channelID: string,
    members: string[],
    createdBy: string,
  ): Promise<ChannelKeyStatus> {
    const v = this.currentVersion(channelID);

    // already hold it (memory or idb)?
    const have = await this.getKey(channelID, v);
    if (have) {
      await this.rewrapForMissing(channelID, members, have);
      return "ready";
    }

    // try to fetch + unwrap our own wrap
    const wrap = await fetchChannelKey(this.transport, channelID, v);
    if (wrap) {
      const opened = await this.openWrap(wrap, channelID, v, members, true);
      if (opened && (await this.adopt(channelID, v, opened.key, opened.prov))) {
        await this.rewrapForMissing(channelID, members, opened.key);
        return "ready";
      }
      // a wrap exists for us but won't open (corrupt / wrong identity) or was
      // refused: the channel is encrypted but we can't use it -> waiting.
      this.encrypted.add(channelID);
      return "waiting";
    }

    // no wrap for us. does any key exist at all?
    const recipients = await fetchChannelKeyRecipients(this.transport, channelID, v);
    if (recipients.ids.length > 0) {
      // key exists, just not wrapped for us yet -> a holder will wrap it.
      this.encrypted.add(channelID);
      return "waiting";
    }

    // no key anywhere. Bootstrap iff we are the channel creator (race-free).
    if (this.identity.userID === createdBy) {
      const sk = generateSpaceKey();
      const selfWrap = await wrapSpaceKey(
        sk,
        this.identity.x25519Public,
        { channelID, keyVersion: v, recipientID: this.identity.userID },
        this.signer,
      );
      await publishChannelKey(this.transport, channelID, v, this.identity.userID, selfWrap);

      // Read-back reconcile: if a concurrent bootstrap (our OTHER DEVICE) won
      // the upsert on our channel_keys row, adopt that key instead of ours so
      // both devices converge before wrapping for anyone else.
      //
      // 82-4: this is the audit's worst case (C-01). The creator used to adopt
      // whatever decrypted here and then hand it to the whole channel via
      // rewrapForMissing -- so one substituted frame compromised the channel
      // with the legitimate creator as the distributor.
      //
      // The fix is exact rather than heuristic. fetch_channel_key only ever
      // returns the CALLER's own row, and this branch is reached only when no
      // recipient holds a key at all, so the sole legitimate writer is another
      // device of this same user -- which signs with this same per-user
      // Ed25519 key. Anything else is an attack or a bug.
      let finalSk = sk;
      let finalProv: KeyProvenance = SELF_MINTED;
      const readback = await fetchChannelKey(this.transport, channelID, v);
      if (readback) {
        const rb = await this.openWrap(readback, channelID, v, [this.identity.userID], false);
        if (rb && rb.prov.kind === "signed" && rb.prov.trust === "self") {
          // Our other device. Adopting identical bytes is not an adoption at
          // all, so it keeps self-minted provenance.
          finalSk = rb.key;
          finalProv = bytesEqual(rb.key, sk) ? SELF_MINTED : rb.prov;
        } else if (rb && rb.prov.kind === "unsigned") {
          // Legacy: an older device of ours wrote an unsigned wrap. Byte-equal
          // means nothing was substituted; a DIFFERENT key from an unsigned
          // read-back is precisely the C-01 shape, so refuse it and keep ours.
          if (bytesEqual(rb.key, sk)) finalProv = SELF_MINTED;
        } else if (readback.suite === WRAP_SUITE_X25519_AESGCM_ED25519) {
          // A signature was offered and it is not ours. Fail loudly and do NOT
          // distribute: publishing nothing further is what stops the creator
          // becoming the attacker's delivery mechanism.
          console.error(
            "channel-crypto: bootstrap read-back for",
            channelID,
            "was signed by another identity -- refusing to adopt or redistribute it.",
          );
          this.encrypted.add(channelID);
          return "waiting";
        }
      }
      if (!(await this.adopt(channelID, v, finalSk, finalProv))) {
        this.encrypted.add(channelID);
        return "waiting";
      }
      await this.rewrapForMissing(channelID, members, finalSk);
      return "ready";
    }

    // Fail-closed: not the creator and no key yet. The channel is not usable
    // until its creator bootstraps and a holder wraps the key for us. Block
    // (never fall back to plaintext).
    return "waiting";
  }

  /**
   * rewrapForMissing wraps the (already-held) space key for every member who
   * doesn't yet have a wrap -- and, since 82-6, RE-wraps every member whose
   * stored wrap sits on a lower suite than the one this client produces: the
   * self-healing sweep. Safe for any holder to run: all holders share the
   * same key, so concurrent rewraps converge on identical material, and the
   * server's guarded upsert only accepts the overwrite because it is a suite
   * upgrade.
   *
   * The sweep includes our OWN slot, which the missing-only pass never touches
   * (we obviously hold the key). Healing it is what arms the 82-5 ratchet on
   * this user's other devices: their next fetch opens a signed wrap instead of
   * the legacy one. A member whose suite the server did not report (pre-82-6
   * server) is left alone -- "unknown" must not be treated as "worse".
   */
  private async rewrapForMissing(
    channelID: string,
    members: string[],
    sk: Uint8Array,
    version?: number,
  ): Promise<void> {
    const v = version ?? this.currentVersion(channelID);
    let have: ChannelKeyRecipients;
    try {
      have = await fetchChannelKeyRecipients(this.transport, channelID, v);
    } catch {
      return; // best-effort; a later open retries
    }
    const held = new Set(have.ids);
    for (const m of members) {
      const suite = have.suites.get(m);
      if (held.has(m) && !(typeof suite === "number" && suite < CURRENT_WRAP_SUITE)) continue;
      try {
        // Our own slot needs no identity fetch; peers are resolved as before.
        const recipientPub =
          m === this.identity.userID
            ? this.identity.x25519Public
            : (await fetchIdentity(this.transport, m))?.x25519Public;
        if (!recipientPub) continue; // peer hasn't published an identity yet; rewrap later
        const wrap = await wrapSpaceKey(
          sk,
          recipientPub,
          { channelID, keyVersion: v, recipientID: m },
          this.signer,
        );
        await publishChannelKey(this.transport, channelID, v, m, wrap);
      } catch {
        // skip this member; a later open / channel event retries
      }
    }
  }

  /**
   * encryptForChannel prepares a message for sending. Returns an encrypted
   * base64 body (+ keyVersion) when we hold the key, or "waiting" when we don't
   * (App blocks the send). Fail-closed: there is no plaintext result.
   */
  async encryptForChannel(channelID: string, text: string): Promise<EncryptResult> {
    const v = this.currentVersion(channelID);
    const sk = await this.getKey(channelID, v);
    if (sk) {
      const ct = await encryptMessage(sk, channelID, v, new TextEncoder().encode(text));
      return { kind: "encrypted", body: bytesToBase64(ct), keyVersion: v };
    }
    // Fail-closed: without a usable key we never send. Block as "waiting"
    // whether or not a key is known to exist server-side.
    return { kind: "waiting" };
  }

  /**
   * decryptForChannel turns a received body into display text. A null/0
   * keyVersion is legacy plaintext (returned as-is). Otherwise it decrypts with
   * the channel key, returning a placeholder if the key isn't available yet or
   * the ciphertext won't open.
   */
  async decryptForChannel(channelID: string, keyVersion: number | undefined, body: string): Promise<string> {
    // Fail-closed: a message without a key version is unencrypted and must
    // never be displayed as cleartext. (With a fresh DB this should not occur;
    // the server also rejects such sends.)
    if (!keyVersion || keyVersion < 1) return PLACEHOLDER_PLAINTEXT_BLOCKED;
    let sk = await this.getKey(channelID, keyVersion);
    if (!sk && !this.settled.has(channelID)) {
      // Phase 23g: the key may be in-flight (ensureChannelKey running on
      // channel open). Defer briefly until it settles, then retry once --
      // this avoids a placeholder flash for messages that arrive just before
      // the key. A settled keyless channel skips the wait (immediate
      // placeholder); the re-fetch backstop handles keys that arrive later.
      await this.waitForKeySettled(channelID);
      sk = await this.getKey(channelID, keyVersion);
    }
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

  // ---- structured payloads (37-5) ---------------------------------------

  /**
   * sealJSONForChannel encrypts a JSON-serializable value under the channel's
   * current key, returning the same base64 body + key version a message send
   * carries. Used for reaction sets, which are a small JSON array of emoji
   * rather than display text.
   */
  async sealJSONForChannel(channelID: string, value: unknown): Promise<EncryptResult> {
    return this.encryptForChannel(channelID, JSON.stringify(value));
  }

  /**
   * openJSONForChannel is the inverse. Unlike decryptForChannel it returns
   * NULL rather than a human-readable placeholder when the key is missing or
   * the body won't open -- a placeholder string is meaningful to a message
   * renderer but would be a parse error here, and "we can't read this" is
   * better rendered as "no reactions from this person" than as a broken chip.
   */
  async openJSONForChannel<T>(
    channelID: string,
    keyVersion: number | undefined,
    body: string,
  ): Promise<T | null> {
    if (!keyVersion || keyVersion < 1 || !body) return null;
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(body);
    } catch {
      return null;
    }
    const pt = await this.decryptBytesForChannel(channelID, keyVersion, bytes);
    if (!pt) return null;
    try {
      return JSON.parse(new TextDecoder().decode(pt)) as T;
    } catch {
      return null;
    }
  }

  // ---- attachment bytes (att-2) ----------------------------------------

  /**
   * encryptBytesForChannel encrypts an arbitrary byte blob (an attachment's
   * full bytes, its preview, or its enc_meta JSON) under the channel's current
   * key version. Returns the raw ciphertext (self-describing suite||nonce||ct||
   * tag, identical framing to a message body) or "waiting" when we hold no
   * usable key -- the caller blocks the upload, never sending plaintext. The
   * version is returned so every blob of one attachment is stamped under the
   * SAME version even if a rotation lands mid-send.
   */
  async encryptBytesForChannel(channelID: string, bytes: Uint8Array): Promise<EncryptBytesResult> {
    const v = this.currentVersion(channelID);
    const sk = await this.getKey(channelID, v);
    if (!sk) return { kind: "waiting" };
    const ct = await encryptMessage(sk, channelID, v, bytes);
    return { kind: "encrypted", ciphertext: ct, keyVersion: v };
  }

  /**
   * encryptBytesAtVersion encrypts under a SPECIFIC version (the one a prior
   * blob of the same attachment was stamped with), so the preview and enc_meta
   * never diverge from the full blob's version. Returns null only when the key
   * for that version isn't available (which, mid-send, should not happen).
   */
  async encryptBytesAtVersion(
    channelID: string,
    keyVersion: number,
    bytes: Uint8Array,
  ): Promise<Uint8Array | null> {
    const sk = await this.getKey(channelID, keyVersion);
    if (!sk) return null;
    return encryptMessage(sk, channelID, keyVersion, bytes);
  }

  /**
   * decryptBytesForChannel turns an attachment ciphertext (full blob, preview,
   * or enc_meta) back into plaintext bytes under the stamped key version, or
   * null if the key isn't available yet or the blob won't open. Fail-closed:
   * the caller shows a locked placeholder, never raw bytes. Mirrors the
   * deferred-key wait of decryptForChannel so a blob fetched during channel
   * open doesn't spuriously fail before the key settles.
   */
  async decryptBytesForChannel(
    channelID: string,
    keyVersion: number,
    ciphertext: Uint8Array,
  ): Promise<Uint8Array | null> {
    if (!keyVersion || keyVersion < 1) return null;
    let sk = await this.getKey(channelID, keyVersion);
    if (!sk && !this.settled.has(channelID)) {
      await this.waitForKeySettled(channelID);
      sk = await this.getKey(channelID, keyVersion);
    }
    if (!sk) return null;
    return decryptMessage(sk, channelID, keyVersion, ciphertext);
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
