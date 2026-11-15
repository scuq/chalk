// chalk-web -- 87-2: keeping the reminders in step across devices.
//
// The whole set of reminders travels in one sealed prefs blob, under the key
// `reminders_enc`. This file seals and opens that blob, and RemindersSync keeps
// it equal to the local set. It follows crypto/pin-sync.ts. Both directions go
// through mergeReminders, so a device with an empty local set never deletes
// anything on the server. The notification rules sync is different: it
// overwrites.
//
// Two differences from pin-sync.ts:
//
// - The transport reports if a send went out. When the socket is closed, the
//   sync retries after RETRY_MS. In pin-sync.ts that send is lost until the
//   content changes.
// - The App effect stops the sync when the account changes and starts a new one
//   with the new identity. The three older syncs keep their first instance.
//
// The timer and the sweep that fire a reminder are slice 87-5. They are not in
// this file. The design record is docs/phases/PHASE-87-REMINDERS.md.

import { blobKey, openJSON, scalarFromX25519, sealJSON } from "../crypto/prefs-blob";
import {
  REMINDERS_VERSION,
  canonicalReminders,
  fitReminders,
  mergeReminders,
  packReminder,
  pruneReminders,
  unpackReminders,
  type Reminder,
} from "./reminders";

// The HKDF salt and info give a key that is independent of every other use of the
// identity scalar.
const HKDF_SALT = "chalk-reminders-salt-v1";
const HKDF_INFO = "chalk-reminders-v1";

/** The key of the sealed reminders blob in the user prefs. */
export const REMINDERS_PREFS_KEY = "reminders_enc";

/** The time in milliseconds that a local change waits before the upload. */
export const UPLOAD_DEBOUNCE_MS = 3000;
/** The time in milliseconds before a retry, after a send on a closed socket. */
export const RETRY_MS = 15000;

/**
 * remindersAesKey derives the AES-256-GCM key of the reminders blob from the
 * raw X25519 private scalar. Every device of one identity derives the same key.
 */
export function remindersAesKey(scalar: Uint8Array): Promise<CryptoKey> {
  return blobKey(scalar, HKDF_SALT, HKDF_INFO);
}

/**
 * sealReminders returns the blob for a set of reminders, as base64 ciphertext.
 * It writes the version `REMINDERS_VERSION` inside the sealed value. It does not
 * fit the set to the size budget. fitReminders does that, before the seal.
 */
export function sealReminders(key: CryptoKey, list: readonly Reminder[]): Promise<string> {
  return sealJSON(key, { v: REMINDERS_VERSION, reminders: list.map(packReminder) });
}

/**
 * openReminders returns the reminders in a blob, or null. It returns null if
 * the blob does not decrypt, if the version is not `REMINDERS_VERSION`, or if
 * the value has the wrong shape. It never throws. A row that is not valid is
 * skipped by unpackReminders and the other rows stay. The pin backup is
 * stricter: one bad row rejects the whole blob.
 */
export async function openReminders(key: CryptoKey, blob: string): Promise<Reminder[] | null> {
  const value = await openJSON(key, blob);
  if (!value || typeof value !== "object") return null;
  const parsed = value as { v?: unknown; reminders?: unknown };
  if (parsed.v !== REMINDERS_VERSION || !Array.isArray(parsed.reminders)) return null;
  return unpackReminders(parsed.reminders);
}

/** The way out for a prefs patch, injected so that a test needs no socket. */
export interface RemindersSyncTransport {
  /**
   * send reports whether the patch went out. It reports false when the socket
   * is closed. RemindersSync then restores its record of the server content and
   * tries again after RETRY_MS.
   */
  send(patch: Record<string, unknown>): boolean;
}

/** The local set of reminders for one user, injected so that a test needs no localStorage. */
export interface RemindersStorage {
  list(): Reminder[];
  save(list: Reminder[]): void;
  subscribe(onChange: () => void): () => void;
}

/**
 * A RemindersSync keeps the sealed reminders blob and the local set equal. One
 * instance serves one identity. Call start once, applyRemote when the prefs
 * change, and stop at the end.
 */
export class RemindersSync {
  private key: CryptoKey | null = null;
  private transport: RemindersSyncTransport | null = null;
  private storage: RemindersStorage | null = null;
  private now: () => number = Date.now;
  private unsub: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // The content that the server holds, in canonical form. This guard stops a
  // device that learned nothing new from sealing the same set again under a new
  // nonce. The other devices would take that blob as a change and answer it.
  private lastJSON: string | null = null;
  // The exact ciphertext that this device last saw or sent. This guard stops the
  // echo of our own upload from starting a new round.
  private lastBlob: string | null = null;

  /**
   * start derives the key and subscribes to the local set. It does not read the
   * server. The caller passes the first blob to applyRemote. The `now`
   * parameter is the clock for the prune rule.
   */
  async start(
    x25519Private: CryptoKey,
    transport: RemindersSyncTransport,
    storage: RemindersStorage,
    now: () => number = Date.now,
  ): Promise<void> {
    this.key = await remindersAesKey(await scalarFromX25519(x25519Private));
    this.transport = transport;
    this.storage = storage;
    this.now = now;
    this.unsub = storage.subscribe(() => this.schedule(UPLOAD_DEBOUNCE_MS));
  }

  /** stop cancels the pending upload and drops every reference. */
  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.unsub?.();
    this.unsub = null;
    this.transport = null;
    this.storage = null;
    this.key = null;
  }

  /**
   * applyRemote takes the blob that the server holds now, when the prefs land.
   * The value undefined means that the server holds none, and the local set
   * seeds it. If the blob does not decrypt, applyRemote keeps the local set and
   * sends nothing. A later local change publishes over that blob.
   */
  async applyRemote(blob: string | undefined): Promise<void> {
    const key = this.key;
    const storage = this.storage;
    if (!key || !storage) return;
    if (blob === undefined) {
      await this.push();
      return;
    }
    // Our own upload comes back through the prefs. Do nothing for it.
    if (blob === this.lastBlob) return;
    this.lastBlob = blob;

    const remote = await openReminders(key, blob);
    // stop() can run during the decrypt, and the account can change. Do not
    // write into a store that this sync no longer serves.
    if (this.storage !== storage) return;
    if (!remote) {
      // Leave the server copy alone. The blob can be in a newer format that this
      // build does not know, and a reminder is costly to set again.
      console.warn("reminders-sync: undecryptable reminders blob ignored; keeping local reminders");
      return;
    }
    // Set before the merge, so that a device that learned nothing new does not
    // publish the same content again.
    this.lastJSON = canonicalReminders(remote);

    // The merge is symmetric. Publishing the union is what makes the other
    // devices converge, also when this device knew more.
    const local = storage.list();
    const merged = pruneReminders(mergeReminders(local, remote), this.now());
    if (canonicalReminders(merged) !== canonicalReminders(local)) storage.save(merged);
    await this.publish(merged);
  }

  /**
   * push uploads the local set, after it removes the done reminders that are
   * older than `DONE_KEEP_MS`. It saves the pruned set locally, and sends
   * nothing if the content equals what the server holds.
   */
  async push(): Promise<void> {
    const storage = this.storage;
    if (!storage) return;
    const local = storage.list();
    // The local set gets the prune too, not only the blob. Otherwise the next
    // merge brings the old record back from the local side.
    const pruned = pruneReminders(local, this.now());
    if (pruned.length !== local.length) storage.save(pruned);
    await this.publish(pruned);
  }

  // Seals the set and sends it, if the content differs from what the server holds.
  private async publish(records: readonly Reminder[]): Promise<void> {
    const key = this.key;
    if (!key || !this.transport) return;
    // The blob has a size budget. fitReminders can strip previews and drop
    // records. A dropped record stays on this device.
    const fit = fitReminders(records);
    if (fit.dropped.length > 0) {
      console.warn(
        `reminders-sync: ${fit.dropped.length} reminders did not fit and are on this device only`,
      );
    }
    const json = canonicalReminders(fit.kept);
    if (json === this.lastJSON) return;
    // Set before the awaits, so that two calls at the same time do not both send.
    const prevJSON = this.lastJSON;
    this.lastJSON = json;
    const blob = await sealReminders(key, fit.kept);
    const transport = this.transport;
    // stop() can run during the seal.
    if (!transport) return;
    if (!transport.send({ [REMINDERS_PREFS_KEY]: blob })) {
      // The server did not get the blob. Go back to the old content, or the
      // retry would take the set for sent. Do not undo a newer value that a
      // call at the same time set.
      if (this.lastJSON === json) this.lastJSON = prevJSON;
      this.schedule(RETRY_MS);
      return;
    }
    this.lastBlob = blob;
  }

  // Starts or restarts the timer for one push. A burst of changes gives one upload.
  private schedule(delayMs: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.push();
    }, delayMs);
  }
}
