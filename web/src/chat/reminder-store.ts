// chalk-web -- 87-2: the local copy of the reminders.
//
// The skeleton is notify/rules-store.ts: localStorage behind a total read, a
// same-tab listener set, and the cross-tab storage event. RemindersSync mirrors
// this set through the server as a sealed blob (reminders-sync.ts).
//
// Two things differ from the other stores:
//
// - The key holds the user ID. No other localStorage store in chalk is per user.
//   The blob is sealed with the identity of one account. A store that two
//   accounts on one browser share would upload the reminders of the first account
//   into the prefs of the second.
// - The set holds message previews in plaintext. handleLogout in App.tsx calls
//   clearReminders. The sealed blob on the server restores the set at the next
//   login. A change that was not yet uploaded at logout is lost.

import { packReminder, unpackReminders, type Reminder } from "./reminders";

// The full key is this prefix and the user ID.
const KEY_PREFIX = "chalk.reminders.v1.";

type Listener = () => void;

// An in-memory copy for each user. A failed write keeps the set here for the page load.
const cache = new Map<string, Reminder[]>();
// The same-tab listeners, for each user.
const listeners = new Map<string, Set<Listener>>();

/** reminderStorageKey returns the localStorage key of one user. */
export function reminderStorageKey(userID: string): string {
  return KEY_PREFIX + userID;
}

// Reads the set from localStorage. It returns an empty set if the value is missing or is not valid.
function readStorage(userID: string): Reminder[] {
  try {
    const raw = window.localStorage.getItem(reminderStorageKey(userID));
    if (raw) return unpackReminders(JSON.parse(raw));
  } catch {
    return [];
  }
  return [];
}

/**
 * loadReminders returns a copy of the reminders of one user. A change to the
 * returned list does not change the store. The first call for a user reads
 * localStorage. A later call reads the in-memory copy, until a `storage` event
 * from another tab drops it.
 */
export function loadReminders(userID: string): Reminder[] {
  let list = cache.get(userID);
  if (!list) {
    list = readStorage(userID);
    cache.set(userID, list);
  }
  return [...list];
}

// Calls the listeners of one user. The loop runs over a copy, so a listener can unsubscribe.
function notify(userID: string): void {
  const set = listeners.get(userID);
  if (!set) return;
  for (const fn of [...set]) fn();
}

/**
 * saveReminders replaces the set of one user and calls the listeners of that
 * user. If the write to localStorage fails, the set stays in memory for this
 * page load and the listeners still run.
 */
export function saveReminders(userID: string, list: readonly Reminder[]): void {
  cache.set(userID, [...list]);
  try {
    window.localStorage.setItem(
      reminderStorageKey(userID),
      JSON.stringify(list.map(packReminder)),
    );
  } catch {
    // Private mode or a full quota. The in-memory copy holds the set for this page load.
  }
  notify(userID);
}

/**
 * clearReminders removes the set of one user from localStorage and from memory,
 * and calls the listeners. The logout calls it, because the set holds previews in
 * plaintext.
 */
export function clearReminders(userID: string): void {
  cache.set(userID, []);
  try {
    window.localStorage.removeItem(reminderStorageKey(userID));
  } catch {
    // The browser refuses storage access. The in-memory copy is already empty.
  }
  notify(userID);
}

/**
 * subscribeReminders calls onChange after each save or clear for one user, and
 * when another tab changes the stored set. It returns the function that removes
 * the subscription.
 */
export function subscribeReminders(userID: string, onChange: Listener): () => void {
  let set = listeners.get(userID);
  if (!set) {
    set = new Set();
    listeners.set(userID, set);
  }
  set.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== reminderStorageKey(userID)) return;
    // Another tab wrote. Drop the in-memory copy so that the next load reads
    // localStorage again.
    cache.delete(userID);
    onChange();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.get(userID)?.delete(onChange);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}
