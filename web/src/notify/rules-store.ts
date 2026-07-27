// chalk-web -- persistence for the notification rules config.
//
// Same skeleton as prefs.ts: localStorage behind a total normalize, a
// same-tab listener set plus the cross-tab storage event, wrappers thin
// enough not to need tests. This key is the device-local copy; the sync
// slice will mirror it through the server as an encrypted blob, and
// this stays the cache that makes rules available at startup before
// identity unlock.
//
// First run: with nothing stored, the config is seeded from the v1
// sound prefs -- a chat category the user had switched off becomes a
// muted event type, which is the closest pre-rules equivalent. The seed
// is recomputed on every load rather than written back, so the old
// toggles keep working until the first real rules edit persists.

import {
  defaultRulesConfig,
  normalizeRulesConfig,
  type NotifyEventType,
  type RulesConfig,
} from "./rules";

const STORAGE_KEY = "chalk.notify.rules.v1";
// Read raw rather than through loadSoundPrefs: v2 prefs no longer carry
// the chat categories, and the seed needs the v1 entry as the user left it.
const V1_PREFS_KEY = "chalk.notify.v1";

// The event types that existed as v1 sound categories. presence and the
// machine noises stay device-local prefs and never become rules.
const V1_CHAT_TYPES: NotifyEventType[] = ["mention", "dm", "thread_reply", "message"];

export function seedRulesFromSoundCategories(
  categories: Partial<Record<string, boolean>>,
): RulesConfig {
  const config = defaultRulesConfig();
  for (const t of V1_CHAT_TYPES) {
    if (categories[t] === false) config.rules.defaults[t] = 0;
  }
  return config;
}

function v1SoundCategories(): Partial<Record<string, boolean>> {
  try {
    const raw = window.localStorage.getItem(V1_PREFS_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw) as Record<string, unknown> | null;
    const cats = o?.categories;
    if (cats && typeof cats === "object" && !Array.isArray(cats)) {
      return cats as Partial<Record<string, boolean>>;
    }
  } catch {
    // Corrupt v1 entry: seed from defaults instead.
  }
  return {};
}

export function loadRulesConfig(): RulesConfig {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeRulesConfig(JSON.parse(raw));
  } catch {
    // Corrupt entry or private-browsing localStorage; fall through to
    // the seed rather than break startup.
  }
  return seedRulesFromSoundCategories(v1SoundCategories());
}

const listeners = new Set<(config: RulesConfig) => void>();

export function saveRulesConfig(config: RulesConfig): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // The edit won't survive a reload, but listeners still fire, so it
    // holds for this session.
  }
  for (const fn of listeners) fn(config);
}

export function subscribeRulesConfig(onChange: (config: RulesConfig) => void): () => void {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) onChange(loadRulesConfig());
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}
