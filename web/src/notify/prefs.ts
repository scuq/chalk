// chalk-web -- persistence for notification sound preferences.
//
// Same shape as display-prefs.ts, and for the same reasons: localStorage
// is user-editable and survives across versions, so normalize has to be
// total -- anything at all in, usable prefs out. A corrupt entry that
// threw here would take startup with it.
//
// The pure half (normalizeSoundPrefs) is unit-tested; the two-line
// localStorage wrappers around it are not, which is the convention the
// display prefs already set.

import { useCallback, useEffect, useState } from "preact/hooks";
import {
  DEFAULT_SOUND_PREFS,
  MACHINE_CATEGORIES,
  MAX_VOLUME,
  MIN_VOLUME,
  type MachineCategory,
  type SoundPrefs,
} from "./types";

// v2: the chat categories moved out to the rules engine (phase 50), so
// prefs now hold only master/volume/dnd plus the machine noises. v1 is
// still read as a fallback -- normalize simply ignores the chat keys --
// and left in place, both so a downgrade keeps working and because the
// rules store seeds its one-time migration from it.
const STORAGE_KEY = "chalk.notify.v2";
const V1_STORAGE_KEY = "chalk.notify.v1";

// normalizeSoundPrefs fills in every field from a possibly-partial,
// possibly-garbage stored value. An unknown category key is dropped
// rather than carried, so a downgrade can't resurrect a category this
// build doesn't know how to play -- and a v1 entry's chat categories are
// dropped the same way, which IS the v1 -> v2 migration.
export function normalizeSoundPrefs(raw: unknown): SoundPrefs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_SOUND_PREFS, categories: { ...DEFAULT_SOUND_PREFS.categories } };
  }
  const o = raw as Record<string, unknown>;

  const n = typeof o.volume === "number" ? o.volume : Number(o.volume);
  const volume = Number.isFinite(n)
    ? Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, n))
    : DEFAULT_SOUND_PREFS.volume;

  const rawCats =
    o.categories && typeof o.categories === "object" && !Array.isArray(o.categories)
      ? (o.categories as Record<string, unknown>)
      : {};
  const categories = {} as Record<MachineCategory, boolean>;
  for (const c of MACHINE_CATEGORIES) {
    categories[c] =
      typeof rawCats[c] === "boolean" ? (rawCats[c] as boolean) : DEFAULT_SOUND_PREFS.categories[c];
  }

  return {
    master: typeof o.master === "boolean" ? o.master : DEFAULT_SOUND_PREFS.master,
    volume,
    dnd: typeof o.dnd === "boolean" ? o.dnd : DEFAULT_SOUND_PREFS.dnd,
    categories,
  };
}

export function loadSoundPrefs(): SoundPrefs {
  try {
    const raw =
      window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(V1_STORAGE_KEY);
    if (!raw) return normalizeSoundPrefs(null);
    return normalizeSoundPrefs(JSON.parse(raw));
  } catch {
    // Private-browsing localStorage throws, and a corrupt entry throws in
    // JSON.parse. Neither is worth breaking startup over.
    return normalizeSoundPrefs(null);
  }
}

// Same-tab listeners. The `storage` event deliberately does not fire in
// the tab that wrote, so it alone would let the profile panel change a
// setting the frame handlers in this very tab never hear about -- the
// user toggles "mentions" and nothing happens until they reload. Every
// write goes through saveSoundPrefs, so notifying from here covers it.
const listeners = new Set<(prefs: SoundPrefs) => void>();

export function saveSoundPrefs(prefs: SoundPrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Same as above: the setting just won't survive a reload. Listeners
    // still fire, so it holds for this session.
  }
  for (const fn of listeners) fn(prefs);
}

// useSoundPrefs owns the setting for the profile panel. Nothing on the
// server knows about these, so -- like useDisplayPrefs -- the hook reads,
// persists, and follows other tabs on its own rather than being threaded
// through app state.
export function useSoundPrefs(): [
  SoundPrefs,
  (patch: Partial<SoundPrefs>) => void,
  (category: MachineCategory, on: boolean) => void,
] {
  const [prefs, setPrefs] = useState<SoundPrefs>(loadSoundPrefs);

  const update = useCallback((patch: Partial<SoundPrefs>) => {
    setPrefs((prev) => {
      const next = normalizeSoundPrefs({ ...prev, ...patch });
      saveSoundPrefs(next);
      return next;
    });
  }, []);

  const setCategory = useCallback((category: MachineCategory, on: boolean) => {
    setPrefs((prev) => {
      const next = normalizeSoundPrefs({
        ...prev,
        categories: { ...prev.categories, [category]: on },
      });
      saveSoundPrefs(next);
      return next;
    });
  }, []);

  // A second tab on the same device is the same device.
  useEffect(() => subscribeSoundPrefs(setPrefs), []);

  return [prefs, update, setCategory];
}

// subscribeSoundPrefs reports every change, whoever made it: this tab
// (via the listener set) or another one (via the storage event). Returns
// an unsubscribe. NotifySounds uses this so App.tsx's frame handlers see
// a profile toggle immediately.
export function subscribeSoundPrefs(onChange: (prefs: SoundPrefs) => void): () => void {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) onChange(loadSoundPrefs());
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}
