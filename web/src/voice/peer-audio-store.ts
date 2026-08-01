// chalk-web -- persistence for the per-peer local audio prefs ("mute for me").
//
// Receive-side only: local mute and 0..1 volume applied to OUR playback of a
// peer. Never touches the wire -- the peer's uplink and everyone else's ears
// are unchanged, and nothing is broadcast (unlike self-mute, which rides
// voice_state for the roster). Scoped per CHANNEL per USER (design A1: the
// driving case is "my partner sits beside me in this room" -- a room-scoped
// preference that must survive rejoins).
//
// 66-3: lifted out of session.ts so the list can be synced. localStorage stays
// the runtime source of truth -- the dock reads it while rendering and it has
// to answer before the socket is up -- and peer-audio-sync.ts mirrors it
// through the server as an encrypted blob. Hence the total normalizer: what
// comes back down is a decrypted blob written by another device, and it must
// not be able to put junk in front of the volume sliders.

export interface PeerAudioPref {
  /** Local mute (A1). Independent of volume so unmute restores the level. */
  muted: boolean;
  /** Playback volume 0..1 (A4 subset; HTMLMediaElement.volume ceiling). */
  volume: number;
}

/** channel -> user -> pref. */
export type PeerAudioStore = Record<string, Record<string, PeerAudioPref>>;

const STORAGE_KEY = "chalk-voice-peer-audio";

export function normalizePeerAudioPref(p: Partial<PeerAudioPref> | undefined): PeerAudioPref {
  const vol = typeof p?.volume === "number" && Number.isFinite(p.volume) ? p.volume : 1;
  return {
    muted: !!p?.muted,
    volume: Math.min(1, Math.max(0, vol)),
  };
}

/** A pref indistinguishable from never having touched that peer. Those rows
 * are dropped rather than stored, which is also what keeps the synced blob
 * from growing a row per person you have ever been in a room with. */
export function isDefaultPeerAudioPref(p: PeerAudioPref): boolean {
  return !p.muted && p.volume === 1;
}

/** normalizePeerAudioStore is total: anything that is not a channel map of
 * user maps comes back as {}, and every surviving row is defaulted. */
export function normalizePeerAudioStore(raw: unknown): PeerAudioStore {
  const out: PeerAudioStore = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [channelID, room] of Object.entries(raw as Record<string, unknown>)) {
    if (!room || typeof room !== "object" || Array.isArray(room)) continue;
    const kept: Record<string, PeerAudioPref> = {};
    for (const [userID, pref] of Object.entries(room as Record<string, unknown>)) {
      if (!pref || typeof pref !== "object" || Array.isArray(pref)) continue;
      const norm = normalizePeerAudioPref(pref as Partial<PeerAudioPref>);
      if (!isDefaultPeerAudioPref(norm)) kept[userID] = norm;
    }
    if (Object.keys(kept).length > 0) out[channelID] = kept;
  }
  return out;
}

export function loadPeerAudioStore(): PeerAudioStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizePeerAudioStore(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

const listeners = new Set<(store: PeerAudioStore) => void>();

export function savePeerAudioStore(store: PeerAudioStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // quota/private-mode: the list holds for this session only, and the
    // listeners below still fire, so the sync and the live call agree.
  }
  for (const fn of listeners) fn(store);
}

/** Every change, from this tab, another tab, or the sync applying a blob
 * another device wrote. */
export function subscribePeerAudioStore(onChange: (store: PeerAudioStore) => void): () => void {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) onChange(loadPeerAudioStore());
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}
