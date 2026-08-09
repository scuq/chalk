// chalk -- 83-2: the replay guard.
//
// Every signed envelope is keyed by its replay triple (actor, writer_scope,
// client_msg_id), bound to the FIRST server row id it is seen under; the same
// triple under a different server row is a duplicate and renders once
// (PHASE-83-MSGSIG.md D.1). Under claim 1 the server does not replay -- this
// guard is what makes that trust *checkable*: a re-delivered or re-minted row
// carrying an already-seen envelope is dropped by the client no matter what
// the outer frame says.
//
// WHY SERIALIZED. History decryption fans out (Promise.all over a page), so
// two rows carrying the same triple can be checked concurrently; a naive
// read-then-write would let both read "unseen" and both render. Every
// check-and-bind therefore runs on one promise chain -- envelope volume is
// UI-scale, so a single queue costs nothing and buys the invariant "exactly
// one row per triple ever binds".
//
// WHO GETS BOUND. The caller must only bind SIGNATURE-VALID envelopes
// (verified / verified-former-identity / mismatch). Binding a forged envelope
// would let any space-key holder squat a victim's triple before the victim's
// real message arrives, converting a failed forgery into denial of rendering.
// An unpinned envelope is not bound either -- no belief, no binding; it may
// bind later once a pin exists and the row is seen again.

import { loadReplayRecord, saveReplayRecord, type ReplayRecord } from "./idb";

export type ReplayVerdict =
  | "first" // triple unseen; now bound to this server id
  | "same" // triple already bound to THIS server id (history refetch)
  | "duplicate"; // triple bound to a DIFFERENT server id: render once, drop this

/** Storage surface, injectable for tests. Defaults to the IndexedDB store. */
export interface ReplayStorage {
  load(triple: string): Promise<ReplayRecord | null>;
  save(record: ReplayRecord): Promise<void>;
}

const idbStorage: ReplayStorage = { load: loadReplayRecord, save: saveReplayRecord };

/**
 * ReplayGuard is the serialized check-and-bind. One instance per crypto
 * brain (ChannelCrypto owns one); the in-memory map short-circuits repeat
 * checks so a scroll through history costs one IndexedDB read per triple,
 * not per row.
 */
export class ReplayGuard {
  private storage: ReplayStorage;
  private cache = new Map<string, string>(); // triple -> bound serverID
  private chain: Promise<unknown> = Promise.resolve();

  constructor(storage: ReplayStorage = idbStorage) {
    this.storage = storage;
  }

  /**
   * bind checks the triple against its first-seen binding, writing the
   * binding if none exists. Serialized: concurrent calls for the same triple
   * resolve in call order, so exactly one caller ever gets "first".
   *
   * Storage failures fail OPEN ("first" without persistence): the guard is a
   * replay detector, and refusing to render every message because IndexedDB
   * is unavailable would turn it into a self-inflicted outage.
   */
  bind(triple: string, serverID: string, channelID: string): Promise<ReplayVerdict> {
    const run = this.chain.then(() => this.bindLocked(triple, serverID, channelID));
    // The chain must survive a rejected run (it cannot happen -- bindLocked
    // catches -- but a broken chain would silently unserialize everything).
    this.chain = run.catch(() => {});
    return run;
  }

  private async bindLocked(triple: string, serverID: string, channelID: string): Promise<ReplayVerdict> {
    const cached = this.cache.get(triple);
    if (cached !== undefined) return cached === serverID ? "same" : "duplicate";
    let stored: ReplayRecord | null = null;
    try {
      stored = await this.storage.load(triple);
    } catch {
      stored = null; // fail open, see above
    }
    if (stored) {
      this.cache.set(triple, stored.serverID);
      return stored.serverID === serverID ? "same" : "duplicate";
    }
    this.cache.set(triple, serverID);
    try {
      await this.storage.save({ triple, serverID, channelID, firstSeenAt: Date.now() });
    } catch {
      // fail open: bound in memory for this session at least
    }
    return "first";
  }
}
