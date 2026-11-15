// chalk-web -- 87-1: the rules for message reminders.
//
// A reminder is a private record: "show me this message again at T". This file
// holds the rules only. It has no storage, no timer, and no UI. Each function
// that depends on the time takes the clock as a parameter, so a test can
// supply any time without fake timers.
//
// The whole set of reminders travels in one sealed prefs blob, in the same way
// as the identity pins (crypto/pin-backup.ts). The blob has a fixed size
// budget, so this file also holds the rule that makes a set fit (fitReminders).
// The design record is docs/phases/PHASE-87-REMINDERS.md.
import { BLOB_BUDGET_BYTES, sealedLength } from "../crypto/pin-backup";

/**
 * A Reminder is one private note on one message. All times are epoch
 * milliseconds.
 *
 * The fields `messageTS` and `seq` come from the message. The jump to the
 * message uses `seq` as the stop condition of its backfill crawl. A reminder
 * with `firedAt` set and `doneAt` null is fired and not done. The field
 * `updatedAt` orders two versions of one reminder in mergeReminders. The
 * `preview` is optional text from the message, clipped by clipPreview.
 */
export interface Reminder {
  id: string;
  channelID: string;
  messageID: string;
  messageTS: number;
  seq: number | null;
  dueAt: number;
  createdAt: number;
  updatedAt: number;
  firedAt: number | null;
  doneAt: number | null;
  preview?: string;
}

/**
 * A ReminderPreset names one way to choose a due time. dueAtFor turns it into
 * a time.
 */
export type ReminderPreset =
  | "this_evening"
  | "tomorrow_morning"
  | "tomorrow_evening"
  | "weekend"
  | "next_monday"
  | "custom";

/** Every preset, in the order of the table in the phase document. */
export const REMINDER_PRESETS: readonly ReminderPreset[] = [
  "this_evening",
  "tomorrow_morning",
  "tomorrow_evening",
  "weekend",
  "next_monday",
  "custom",
];

// 25 records of the largest shape always fit the blob budget with no preview.
// The test file asserts that. The point where a reminder is set must enforce
// this count, because fitReminders drops records without a message to the user.
/** The most reminders that a user can hold. */
export const REMINDER_MAX = 25;
/** The most code points that a preview holds, including the ellipsis. */
export const PREVIEW_MAX = 60;
/** The local hour of the "morning" presets. */
export const MORNING_HOUR = 9;
/** The local hour of the "evening" presets. */
export const EVENING_HOUR = 18;
/** The time that pruneReminders keeps a done reminder: seven days. */
export const DONE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** The version number that fitReminders writes in the `v` field of the blob. */
export const REMINDERS_VERSION = 1;

// Returns `hour`:00 local time, `addDays` calendar days after the day of nowMs.
// The date setter moves by calendar days, not by 24 hours. So a clock change
// for summer time still gives the correct wall time.
function atHour(nowMs: number, addDays: number, hour: number): number {
  const d = new Date(nowMs);
  d.setDate(d.getDate() + addDays);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

/**
 * dueAtFor returns the due time of a preset, in epoch milliseconds. All times
 * are in the local timezone of the browser.
 *
 * It returns null for a preset that is not available at nowMs:
 *
 *	- "this_evening" from 18:00 on
 *	- "custom" when customMs is missing, is not a finite number, or is not
 *	  later than nowMs
 *
 * The presets give these times:
 *
 *	- "this_evening": today at 18:00
 *	- "tomorrow_morning": tomorrow at 09:00
 *	- "tomorrow_evening": tomorrow at 18:00
 *	- "weekend": the next Saturday at 09:00. On a Saturday or a Sunday, the
 *	  Saturday after.
 *	- "next_monday": the first Monday after today, at 09:00
 *	- "custom": customMs
 */
export function dueAtFor(preset: ReminderPreset, nowMs: number, customMs?: number): number | null {
  const dow = new Date(nowMs).getDay();
  switch (preset) {
    case "this_evening": {
      const t = atHour(nowMs, 0, EVENING_HOUR);
      return t > nowMs ? t : null;
    }
    case "tomorrow_morning":
      return atHour(nowMs, 1, MORNING_HOUR);
    case "tomorrow_evening":
      return atHour(nowMs, 1, EVENING_HOUR);
    case "weekend": {
      // Days to the next Saturday. From Saturday that is a full week, not
      // zero, so the preset never fires within hours of being set.
      const days = dow === 6 ? 7 : dow === 0 ? 6 : 6 - dow;
      return atHour(nowMs, days, MORNING_HOUR);
    }
    case "next_monday": {
      // Days to the next Monday. From Monday that is a full week. The `|| 7`
      // covers that case, where the modulo gives zero.
      const days = (8 - dow) % 7 || 7;
      return atHour(nowMs, days, MORNING_HOUR);
    }
    case "custom":
      return customMs !== undefined && Number.isFinite(customMs) && customMs > nowMs
        ? customMs
        : null;
  }
}

/**
 * clipPreview returns the text of a message as one line of at most
 * PREVIEW_MAX code points. It collapses each run of whitespace to one space.
 * If it cuts the text, the last code point is an ellipsis.
 */
export function clipPreview(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  // Array.from splits by code point, so the cut never splits a surrogate pair.
  const points = Array.from(line);
  if (points.length <= PREVIEW_MAX) return line;
  return points.slice(0, PREVIEW_MAX - 1).join("") + "…";
}

// Picks one of two versions of one reminder. `a` is the version that the merge
// holds already, and `b` is the new one.
function winner(a: Reminder, b: Reminder): Reminder {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt > a.updatedAt ? b : a;
  // A tie. A done record wins, so a stale device cannot bring back a reminder
  // that the user dismissed.
  if ((b.doneAt !== null) !== (a.doneAt !== null)) return b.doneAt !== null ? b : a;
  // 87-5: firing does not change `updatedAt`, so a snooze or a done mark from
  // another device always wins over a fire that did not see it. Two devices can
  // fire one reminder. Fired wins over pending, and the earlier `firedAt` wins,
  // so both devices keep one record and do not upload in turn.
  if ((b.firedAt !== null) !== (a.firedAt !== null)) return b.firedAt !== null ? b : a;
  if (a.firedAt !== null && b.firedAt !== null && b.firedAt < a.firedAt) return b;
  return a;
}

// The order of a merged list: earliest due time first. The ID breaks a tie, so
// the order is the same on every device.
function byDueThenID(a: Reminder, b: Reminder): number {
  if (a.dueAt !== b.dueAt) return a.dueAt - b.dueAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * mergeReminders returns one record for each reminder ID in a and b, sorted
 * by due time. It does not change its arguments.
 *
 * For two records with one ID, the record with the higher `updatedAt` wins.
 * On a tie, these rules apply in order:
 *
 *   - A record with `doneAt` set wins.
 *   - A record with `firedAt` set wins over a pending record.
 *   - The record with the earlier `firedAt` wins.
 *
 * If the tie remains, the record from a wins.
 *
 * Both directions of the sync use this function and not last-write-wins. A
 * device with cleared storage holds nothing, and last-write-wins would let it
 * upload that empty set over the set of every other device.
 */
export function mergeReminders(a: readonly Reminder[], b: readonly Reminder[]): Reminder[] {
  const byID = new Map<string, Reminder>();
  for (const r of [...a, ...b]) {
    const prev = byID.get(r.id);
    byID.set(r.id, prev ? winner(prev, r) : r);
  }
  return [...byID.values()].sort(byDueThenID);
}

/**
 * A PackedReminder is the compact array form of a Reminder in the blob. The
 * fields have the order of the Reminder interface. The `preview` is present
 * only if the reminder has one.
 */
export type PackedReminder = [
  id: string,
  channelID: string,
  messageID: string,
  messageTS: number,
  seq: number | null,
  dueAt: number,
  createdAt: number,
  updatedAt: number,
  firedAt: number | null,
  doneAt: number | null,
  preview?: string,
];

/** packReminder returns the compact array form of r. */
export function packReminder(r: Reminder): PackedReminder {
  const row: PackedReminder = [
    r.id,
    r.channelID,
    r.messageID,
    r.messageTS,
    r.seq,
    r.dueAt,
    r.createdAt,
    r.updatedAt,
    r.firedAt,
    r.doneAt,
  ];
  if (r.preview !== undefined) row.push(r.preview);
  return row;
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNumOrNull(v: unknown): v is number | null {
  return v === null || isNum(v);
}

function isID(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

// Returns null for any row that is not a valid packed reminder. The input
// comes from a decrypted blob, so it can have any shape.
function unpackOne(row: unknown): Reminder | null {
  if (!Array.isArray(row) || row.length < 10 || row.length > 11) return null;
  const [id, channelID, messageID, messageTS, seq, dueAt, createdAt, updatedAt, firedAt, doneAt] =
    row;
  if (!isID(id) || !isID(channelID) || !isID(messageID)) return null;
  if (!isNum(messageTS) || !isNum(dueAt) || !isNum(createdAt) || !isNum(updatedAt)) return null;
  if (!isNumOrNull(seq) || !isNumOrNull(firedAt) || !isNumOrNull(doneAt)) return null;
  const r: Reminder = {
    id,
    channelID,
    messageID,
    messageTS,
    seq,
    dueAt,
    createdAt,
    updatedAt,
    firedAt,
    doneAt,
  };
  if (row.length === 11) {
    if (typeof row[10] !== "string") return null;
    // Clip again. The blob is not trusted to hold a preview of a valid length.
    r.preview = clipPreview(row[10]);
  }
  return r;
}

/**
 * unpackReminders returns the reminders in raw, sorted by due time. It never
 * throws. If raw is not an array, it returns an empty list. It skips each row
 * that is not a valid packed reminder. If two rows have one ID, it keeps one
 * as mergeReminders does.
 */
export function unpackReminders(raw: unknown): Reminder[] {
  if (!Array.isArray(raw)) return [];
  const out: Reminder[] = [];
  for (const row of raw) {
    const r = unpackOne(row);
    if (r) out.push(r);
  }
  // The merge with an empty list removes duplicate IDs and sorts the result.
  return mergeReminders(out, []);
}

/**
 * canonicalReminders returns a string for the content comparison of two sets.
 * The reminders are sorted by ID and packed with a constant field order. Two
 * sets with the same content give the same string.
 *
 * The comparison cannot use the ciphertext. Each seal uses a new nonce, so
 * sealing an unchanged set gives a different blob. Without a content
 * comparison, two devices that echo each other's blobs would upload forever.
 */
export function canonicalReminders(list: readonly Reminder[]): string {
  const sorted = [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify(sorted.map(packReminder));
}

const encoder = new TextEncoder();

// Reports whether the sealed blob of `list` is within `budget`. The size test
// uses the UTF-8 byte length, because a preview can hold non-ASCII text.
// sealedLength counts the base64 of the nonce, the ciphertext, and the tag.
function fits(list: readonly Reminder[], budget: number): boolean {
  const json = JSON.stringify({ v: REMINDERS_VERSION, reminders: list.map(packReminder) });
  return sealedLength(encoder.encode(json).length) <= budget;
}

// The group of a reminder in the keep order: 0 fired and not done, 1 pending,
// 2 done.
function keepGroup(r: Reminder): number {
  if (r.doneAt !== null) return 2;
  return r.firedAt !== null ? 0 : 1;
}

// The keep order of fitReminders, from the record to keep longest to the
// record to lose first:
//
//   * fired and not done, the latest `firedAt` first
//   * pending, the earliest due time first
//   * done, the latest `doneAt` first
//
// A fired reminder still waits for the user. A done reminder does not.
function byKeepOrder(a: Reminder, b: Reminder): number {
  const ga = keepGroup(a);
  const gb = keepGroup(b);
  if (ga !== gb) return ga - gb;
  if (ga === 0 && a.firedAt !== b.firedAt) return (b.firedAt ?? 0) - (a.firedAt ?? 0);
  if (ga === 2 && a.doneAt !== b.doneAt) return (b.doneAt ?? 0) - (a.doneAt ?? 0);
  return byDueThenID(a, b);
}

function withoutPreview(r: Reminder): Reminder {
  const { preview: _preview, ...rest } = r;
  return rest;
}

/**
 * A ReminderFit is the result of fitReminders.
 *
 * Both lists are in the keep order. The count `previewsStripped` includes
 * previews that fitReminders removed from records that it dropped later.
 * The records in `dropped` keep their previews.
 */
export interface ReminderFit {
  kept: Reminder[];
  dropped: Reminder[];
  previewsStripped: number;
}

/**
 * fitReminders makes a set of reminders fit one sealed blob of at most
 * `budget` bytes. The default is BLOB_BUDGET_BYTES. It does not change list.
 *
 * It sorts the set into the keep order. If the set does not fit, it deletes
 * previews one at a time, from the end of that order, until the set fits. If
 * no preview is left and the set is still too large, it drops records from the
 * end of the order.
 *
 * The result lists each dropped record, so the caller can tell the user.
 */
export function fitReminders(
  list: readonly Reminder[],
  budget: number = BLOB_BUDGET_BYTES,
): ReminderFit {
  const ordered = [...list].sort(byKeepOrder);
  const kept = [...ordered];
  let previewsStripped = 0;
  // The loop test runs the size check again after each deleted preview. A
  // record with no preview costs nothing to skip.
  for (let i = kept.length - 1; i >= 0 && !fits(kept, budget); i--) {
    if (kept[i].preview === undefined) continue;
    kept[i] = withoutPreview(kept[i]);
    previewsStripped++;
  }
  while (kept.length > 0 && !fits(kept, budget)) kept.pop();
  return { kept, dropped: ordered.slice(kept.length), previewsStripped };
}

/**
 * pruneReminders returns the reminders of list without each record whose
 * `doneAt` is older than DONE_KEEP_MS at nowMs. A record that is not done
 * stays.
 *
 * A pruned record leaves no tombstone. A device that was offline for more than
 * seven days can hold a stale pending copy of a pruned record. That copy
 * returns at the next merge, fires as overdue, and the user marks it done
 * again.
 */
export function pruneReminders(list: readonly Reminder[], nowMs: number): Reminder[] {
  return list.filter((r) => r.doneAt === null || nowMs - r.doneAt <= DONE_KEEP_MS);
}

// A pending reminder has not fired and is not done.
function isPending(r: Reminder): boolean {
  return r.firedAt === null && r.doneAt === null;
}

/**
 * dueNow returns the reminders of list that are pending and have a `dueAt` at
 * or before nowMs. The order of list stays.
 */
export function dueNow(list: readonly Reminder[], nowMs: number): Reminder[] {
  return list.filter((r) => isPending(r) && r.dueAt <= nowMs);
}

/**
 * fireDue sets `firedAt` to nowMs on each reminder that dueNow returns. It
 * returns the new list, or null if no reminder is due. It does not change
 * `updatedAt`, so a snooze or a done mark from another device wins the merge.
 * The list that it gets does not change.
 */
export function fireDue(list: readonly Reminder[], nowMs: number): Reminder[] | null {
  let any = false;
  const next = list.map((r) => {
    if (!isPending(r) || r.dueAt > nowMs) return r;
    any = true;
    return { ...r, firedAt: nowMs };
  });
  return any ? next : null;
}

/** SWEEP_MAX_MS is the longest time, in milliseconds, between two sweeps. */
export const SWEEP_MAX_MS = 60_000;

/**
 * nextSweepDelay returns the milliseconds to the next sweep: the time to the
 * earliest pending `dueAt`, at most SWEEP_MAX_MS. It returns null if no
 * reminder is pending.
 */
export function nextSweepDelay(list: readonly Reminder[], nowMs: number): number | null {
  let earliest: number | null = null;
  for (const r of list) {
    if (!isPending(r)) continue;
    if (earliest === null || r.dueAt < earliest) earliest = r.dueAt;
  }
  if (earliest === null) return null;
  return Math.min(Math.max(earliest - nowMs, 0), SWEEP_MAX_MS);
}

/**
 * pendingFor returns a map from message ID to the pending reminder of that
 * message, for the reminders of one channel. The gutter mark of a message row
 * uses it. If a message has more than one pending reminder, the map holds the
 * one with the earliest due time.
 */
export function pendingFor(list: readonly Reminder[], channelID: string): Map<string, Reminder> {
  const out = new Map<string, Reminder>();
  for (const r of list) {
    if (r.channelID !== channelID || !isPending(r)) continue;
    const prev = out.get(r.messageID);
    if (!prev || r.dueAt < prev.dueAt) out.set(r.messageID, r);
  }
  return out;
}

/** firedCount returns the number of reminders that are fired and not done. */
export function firedCount(list: readonly Reminder[]): number {
  return list.filter((r) => r.firedAt !== null && r.doneAt === null).length;
}

/**
 * activeCount returns the number of reminders that are not done. A done
 * reminder does not count toward REMINDER_MAX.
 */
export function activeCount(list: readonly Reminder[]): number {
  return list.filter((r) => r.doneAt === null).length;
}

/**
 * PRESET_LABELS holds the text that the reminder modal shows for each
 * ReminderPreset.
 */
export const PRESET_LABELS: Record<ReminderPreset, string> = {
  this_evening: "this evening",
  tomorrow_morning: "tomorrow morning",
  tomorrow_evening: "tomorrow evening",
  weekend: "this weekend",
  next_monday: "next monday",
  custom: "pick a time",
};

// bump returns the new `updatedAt` of r. It is the larger of nowMs and the old
// value plus 1, so the change wins mergeReminders also when the clock of this
// device runs behind the clock that wrote the old value.
function bump(r: Reminder, nowMs: number): number {
  return Math.max(nowMs, r.updatedAt + 1);
}

/**
 * retireForMessage takes away the reminders of one message. It returns a new
 * list, or null if nothing changed.
 *
 * The merge of the sync never deletes a record, so a reminder cannot leave the
 * set. Instead, retireForMessage marks each reminder of the message that is not
 * done as done (`doneAt` is nowMs) and raises `updatedAt` with bump. The prune
 * after DONE_KEEP_MS removes the record later.
 *
 * If dropPreview is true, retireForMessage also deletes the preview, and it
 * does this for a record that is already done. The list keeps a done record
 * with no preview, so the text of a deleted message does not stay in the set.
 */
export function retireForMessage(
  list: readonly Reminder[],
  channelID: string,
  messageID: string,
  nowMs: number,
  dropPreview: boolean,
): Reminder[] | null {
  let changed = false;
  const out = list.map((r) => {
    if (r.channelID !== channelID || r.messageID !== messageID) return r;
    const strip = dropPreview && r.preview !== undefined;
    if (r.doneAt !== null && !strip) return r;
    changed = true;
    const next: Reminder = strip ? withoutPreview(r) : { ...r };
    if (next.doneAt === null) next.doneAt = nowMs;
    next.updatedAt = bump(r, nowMs);
    return next;
  });
  return changed ? out : null;
}

/**
 * A NewReminder holds the fields that the caller gives to addReminder. The
 * caller reads them from the message. addReminder sets the other fields of a
 * Reminder.
 */
export interface NewReminder {
  id: string;
  channelID: string;
  messageID: string;
  messageTS: number;
  seq: number | null;
  dueAt: number;
  preview?: string;
}

/**
 * addReminder returns list with one new pending reminder made from fields. If
 * the set is full, it returns null.
 *
 * A second reminder on one message replaces the first. addReminder retires each
 * reminder of that message that is not done, and then adds the new one. The cap
 * counts the reminders that are not done, after this step. So a message that
 * already has a reminder can get a new one when the set holds REMINDER_MAX
 * reminders. If the set still holds REMINDER_MAX reminders that are not done,
 * addReminder returns null.
 *
 * The preview of the new record is clipped by clipPreview. An empty preview is
 * left out.
 */
export function addReminder(
  list: readonly Reminder[],
  fields: NewReminder,
  nowMs: number,
): Reminder[] | null {
  const base = retireForMessage(list, fields.channelID, fields.messageID, nowMs, false) ?? [
    ...list,
  ];
  if (activeCount(base) >= REMINDER_MAX) return null;
  const r: Reminder = {
    id: fields.id,
    channelID: fields.channelID,
    messageID: fields.messageID,
    messageTS: fields.messageTS,
    seq: fields.seq,
    dueAt: fields.dueAt,
    createdAt: nowMs,
    updatedAt: nowMs,
    firedAt: null,
    doneAt: null,
  };
  const preview = fields.preview === undefined ? "" : clipPreview(fields.preview);
  if (preview !== "") r.preview = preview;
  return [...base, r];
}

// pad2 writes n with two digits or more.
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * toLocalInput returns the value of an `<input type="datetime-local">` for the
 * time ms, in the local timezone of the browser. The value has the form
 * `2026-01-05T07:03`. It has no seconds.
 */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * fromLocalInput returns the epoch milliseconds for the value of an
 * `<input type="datetime-local">`, read in the local timezone of the browser.
 * The seconds in the value are optional. If the value has another form,
 * fromLocalInput returns null.
 */
export function fromLocalInput(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
  if (!m) return null;
  const ms = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? 0),
  ).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// panelRows returns the reminders that the Reminders panel lists. It drops each
// done reminder. The order is the keep order of fitReminders, so the first rows
// are the fired reminders, the latest fired first. The pending reminders follow,
// the earliest due time first. The result is a new array.
export function panelRows(list: readonly Reminder[]): Reminder[] {
  return list.filter((r) => r.doneAt === null).sort(byKeepOrder);
}

// markDone returns a copy of list in which the reminder with the given id has
// `doneAt` set to nowMs. It raises `updatedAt` with bump, so the change wins the
// merge on the other devices. It returns null if no reminder has that id or if
// that reminder is already done. The caller then has nothing to save.
export function markDone(list: readonly Reminder[], id: string, nowMs: number): Reminder[] | null {
  let changed = false;
  const out = list.map((r) => {
    if (r.id !== id || r.doneAt !== null) return r;
    changed = true;
    return { ...r, doneAt: nowMs, updatedAt: bump(r, nowMs) };
  });
  return changed ? out : null;
}

// snoozeReminder returns a copy of list in which the reminder with the given id
// has the new due time and `firedAt` null. A fired reminder is then pending
// again. It raises `updatedAt` with bump, so the change wins the merge on the
// other devices. It returns null if no reminder has that id or if that reminder
// is done. The caller must check the new due time: this function does not.
export function snoozeReminder(
  list: readonly Reminder[],
  id: string,
  dueAt: number,
  nowMs: number,
): Reminder[] | null {
  let changed = false;
  const out = list.map((r) => {
    if (r.id !== id || r.doneAt !== null) return r;
    changed = true;
    return { ...r, dueAt, firedAt: null, updatedAt: bump(r, nowMs) };
  });
  return changed ? out : null;
}
