// chalk-web -- 87-7: the wake set of the reminders.
//
// The reminders stay in the sealed prefs blob. For a push while chalk is
// closed, the server gets one wake record for each pending reminder: the
// random ID and the due time, and nothing else. This module builds that set
// from the local list. App.tsx sends it in a reminder_wakes_set frame.
import type { ReminderWake } from "../proto";
import type { Reminder } from "./reminders";

/**
 * wakeSet returns one wake record for each reminder of list that is not
 * fired, not done, and not yet due at nowMs. The open client fires a
 * reminder whose due time has passed. A wake record for it would only make
 * the server store and claim it again. The order is by ID, so two equal sets
 * give the same wakeKey.
 */
export function wakeSet(list: readonly Reminder[], nowMs: number): ReminderWake[] {
  return list
    .filter((r) => r.firedAt === null && r.doneAt === null && r.dueAt > nowMs)
    .map((r) => ({ id: r.id, due_at: r.dueAt }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** wakeKey returns a string that is equal for two equal wake sets. */
export function wakeKey(wakes: readonly ReminderWake[]): string {
  return wakes.map((w) => `${w.id}@${w.due_at}`).join(",");
}
