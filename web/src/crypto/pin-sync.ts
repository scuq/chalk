// chalk-web -- 84-2: keeping the pin backup in step.
//
// Shaped after notify/rules-sync.ts, which does the same job for the
// notification rules, with one difference that runs through everything here:
// the rules are whole-blob last-write-wins, and pins must never be. A device
// whose IndexedDB was just wiped holds NO pins, and last-write-wins would have
// it upload that emptiness over the set every other device depends on. So both
// directions go through mergePins, and the union is what gets stored and what
// gets uploaded.
//
// The trigger side matters too. A "verified" tick is a deliberate gesture and
// could have been wired to its button, but TOFU pins are written by the crypto
// path with no gesture at all -- opening a channel pins every member it resolves.
// Those are the pins worth backing up, so the signal comes from the store
// itself (subscribeVerifications) and is debounced, because they arrive in
// bursts.

import {
  BLOB_BUDGET_BYTES,
  canonicalPins,
  fitPins,
  chooseServerPin,
  mergePins,
  openPinBlob,
  pinsAesKey,
  scalarFromX25519,
  sealPins,
  PINS_PREFS_KEY,
  type PackedServerPin,
} from "./pin-backup";
import type { VerificationRecord } from "./safety-number";

const UPLOAD_DEBOUNCE_MS = 3000;

export interface PinSyncTransport {
  send(patch: Record<string, unknown>): void;
}

/** The store, injected so the orchestrator is testable without IndexedDB. */
export interface PinStorage {
  list(): Promise<VerificationRecord[]>;
  save(record: VerificationRecord): Promise<void>;
  subscribe(fn: () => void): () => void;
  /** 83-6: the home-server pin, carried in the same blob. Optional so
   *  existing embeds/tests keep working; absent = peer pins only. */
  loadServerPin?(): Promise<PackedServerPin | null>;
  saveServerPin?(pin: PackedServerPin): Promise<void>;
}

export interface PinSyncStatus {
  /** Pins this device holds. */
  held: number;
  /** Of those, how many are in the backup -- fewer only when it overflowed. */
  backedUp: number;
  /** Peers restored from the backup this session. */
  restored: number;
  /** Peers where the backup and this device pin different keys. */
  conflicts: string[];
  /** When the backup last matched what this device holds, epoch ms. */
  syncedAt: number | null;
}

export class PinSync {
  private key: CryptoKey | null = null;
  private ownEd25519Pub: Uint8Array | null = null;
  private transport: PinSyncTransport | null = null;
  private storage: PinStorage | null = null;
  private onStatus: ((s: PinSyncStatus) => void) | null = null;
  private unsub: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Content of the blob we believe the server holds; see canonicalPins. */
  private lastJSON: string | null = null;
  private lastBlob: string | null = null;
  private status: PinSyncStatus = {
    held: 0,
    backedUp: 0,
    restored: 0,
    conflicts: [],
    syncedAt: null,
  };

  async start(
    x25519Private: CryptoKey,
    ownEd25519Pub: Uint8Array,
    transport: PinSyncTransport,
    storage: PinStorage,
    onStatus?: (s: PinSyncStatus) => void,
  ): Promise<void> {
    this.key = await pinsAesKey(await scalarFromX25519(x25519Private));
    this.ownEd25519Pub = ownEd25519Pub;
    this.transport = transport;
    this.storage = storage;
    this.onStatus = onStatus ?? null;
    this.unsub = storage.subscribe(() => this.schedule());
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.unsub?.();
    this.unsub = null;
    this.transport = null;
    this.storage = null;
    this.key = null;
  }

  /**
   * applyRemote takes the server's current blob, whenever prefs land (get ack,
   * set ack, or another device's change). undefined means the server has never
   * held one -- seed it from what this device knows.
   */
  async applyRemote(blob: string | undefined): Promise<void> {
    if (!this.key || !this.ownEd25519Pub || !this.storage) return;
    if (blob === undefined) {
      await this.push();
      return;
    }
    if (blob === this.lastBlob) return;
    this.lastBlob = blob;

    const opened = await openPinBlob(this.key, blob, this.ownEd25519Pub);
    const remote = opened?.records ?? null;
    if (!remote || !opened) {
      // Keep the local pins and leave the server's copy alone. An unreadable
      // blob is not a reason to destroy it -- it may be a newer format this
      // build does not know, and pins are not cheap to re-establish.
      console.warn("pin-sync: undecryptable pin backup ignored; keeping local pins");
      return;
    }

    const local = await this.storage.list();
    const result = mergePins(local, remote);
    for (const r of result.writes) await this.storage.save(r);

    // 83-6: merge the server pin the same directionless way. A restored
    // registration pin overrides a local TOFU (see chooseServerPin); the
    // next connect then compares the server against the anchor, not the
    // possibly-blind local adoption.
    if (this.storage.loadServerPin && this.storage.saveServerPin) {
      const localSrv = await this.storage.loadServerPin();
      const winner = chooseServerPin(localSrv, opened.serverPin);
      if (winner && JSON.stringify(winner) !== JSON.stringify(localSrv)) {
        await this.storage.saveServerPin(winner);
        console.info("pin-sync: restored the server identity pin from backup");
      }
    }

    // What the server holds, as content. Setting it here is what keeps a device
    // that learned nothing new from re-sealing the same set under a fresh nonce
    // and handing the other devices a "change" to answer.
    this.lastJSON = canonicalPins(remote) + (opened.serverPin ? "|" + JSON.stringify(opened.serverPin) : "");

    this.status = {
      ...this.status,
      restored: this.status.restored + result.restored.length,
      conflicts: result.conflicts,
    };
    if (result.restored.length > 0) {
      console.info(`pin-sync: restored ${result.restored.length} identity pin(s) from backup`);
    }
    for (const peer of result.conflicts) {
      // Worth a line in the console: it means two of this user's own devices
      // disagree about a peer's key, which is either a reinstall nobody has
      // compared yet or the thing pinning exists to catch.
      console.warn(`pin-sync: backup disagrees with this device about ${peer}'s key`);
    }

    // The merge is symmetric, so publishing the union is what makes the other
    // devices converge -- including the case where this device knew more.
    await this.publish(result.merged);
  }

  /** push uploads what this device holds, merged with what is already up there. */
  async push(): Promise<void> {
    if (!this.storage) return;
    await this.publish(await this.storage.list());
  }

  private async publish(records: VerificationRecord[]): Promise<void> {
    if (!this.key || !this.transport) return;
    const { kept, dropped } = fitPins(records, BLOB_BUDGET_BYTES);
    const json = canonicalPins(kept);
    this.status = {
      ...this.status,
      held: records.length,
      backedUp: kept.length,
      syncedAt: Date.now(),
    };
    this.onStatus?.(this.status);
    if (dropped.length > 0) {
      console.warn(
        `pin-sync: backup holds ${kept.length} of ${records.length} pins; ` +
          `${dropped.length} did not fit and are this device only`,
      );
    }
    const srv = (await this.storage?.loadServerPin?.()) ?? null;
    const jsonWithSrv = json + (srv ? "|" + JSON.stringify(srv) : "");
    if (jsonWithSrv === this.lastJSON) return;
    this.lastJSON = jsonWithSrv;
    const blob = await sealPins(this.key, kept, srv);
    this.lastBlob = blob;
    this.transport.send({ [PINS_PREFS_KEY]: blob });
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.push();
    }, UPLOAD_DEBOUNCE_MS);
  }
}
