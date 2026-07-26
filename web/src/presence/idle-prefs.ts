// chalk-web -- per-device away-detection preference.
//
// One knob: may chalk use the browser's system-wide idle detection. On by
// default, because the accurate signal is the one people want -- the setting
// exists to turn it off, not to discover it. Where the browser lacks the API
// the pref is inert and the toggle is not shown at all.
//
// The pref means "use it if the browser allows", never "we have permission".
// Those are separate facts -- the user's wish and the browser's grant -- and
// storing one as if it were the other is how a settings panel ends up lying.
// The grant lives with the browser (permissions.query); this file never mirrors
// it.
//
// localStorage rather than the profile, same shape as voice/net-prefs.ts: an
// idle-detection grant is per-origin-per-browser and cannot follow the account
// to a phone, so a synced value would claim something untrue on the other
// device.

import { useCallback, useEffect, useState } from "preact/hooks";

export interface IdlePrefs {
  systemIdle: boolean;
}

const STORAGE_KEY = "chalk.presence.idle.v1";

export const DEFAULT_IDLE_PREFS: IdlePrefs = {
  systemIdle: true,
};

/** normalizeIdlePrefs fills every field from a possibly-garbage stored value.
 * Total by construction: a throw here would take presence down. */
export function normalizeIdlePrefs(raw: unknown): IdlePrefs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_IDLE_PREFS };
  const o = raw as Record<string, unknown>;
  return {
    systemIdle:
      typeof o.systemIdle === "boolean" ? o.systemIdle : DEFAULT_IDLE_PREFS.systemIdle,
  };
}

export function loadIdlePrefs(): IdlePrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_IDLE_PREFS };
    return normalizeIdlePrefs(JSON.parse(raw));
  } catch {
    // Private-browsing localStorage throws, and a corrupt entry throws in
    // JSON.parse. Neither is worth failing presence over.
    return { ...DEFAULT_IDLE_PREFS };
  }
}

// Same-tab listeners, for the same reason as net-prefs.ts: the `storage` event
// deliberately does not fire in the tab that wrote, so it alone would let the
// settings panel flip the knob while this tab's watcher never hears about it.
const listeners = new Set<(prefs: IdlePrefs) => void>();

export function saveIdlePrefs(prefs: IdlePrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // The setting just won't survive a reload; listeners still fire, so it
    // holds for this session.
  }
  for (const fn of listeners) fn(prefs);
}

export function subscribeIdlePrefs(onChange: (prefs: IdlePrefs) => void): () => void {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) onChange(loadIdlePrefs());
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function useIdlePrefs(): [IdlePrefs, (patch: Partial<IdlePrefs>) => void] {
  const [prefs, setPrefs] = useState<IdlePrefs>(loadIdlePrefs);

  const update = useCallback((patch: Partial<IdlePrefs>) => {
    setPrefs((prev) => {
      const next = normalizeIdlePrefs({ ...prev, ...patch });
      saveIdlePrefs(next);
      return next;
    });
  }, []);

  useEffect(() => subscribeIdlePrefs(setPrefs), []);

  return [prefs, update];
}
