// chalk-web -- persistence for the per-peer local audio prefs ("mute for me").
//
// Receive-side only: local mute and 0..1 volume applied to OUR playback of a
// peer -- since 96-3, one pair for their voice and one for the program audio
// riding their screen share. Never touches the wire -- the peer's uplink and everyone else's ears
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
  /** 96-3: local mute for this person's SHARED PROGRAM AUDIO (the tab or
   * system sound riding their screen share), separate from their voice.
   * Turning a game down to hear someone talk over it is the whole case. */
  screenMuted: boolean;
  /** 96-3: playback volume 0..1 for that shared program audio. */
  screenVolume: number;
}

/** channel -> user -> pref. */
export type PeerAudioStore = Record<string, Record<string, PeerAudioPref>>;

const STORAGE_KEY = "chalk-voice-peer-audio";

/** 0..1, defaulting to full volume for anything that is not a real number --
 * a NaN would silence someone permanently (element.volume = NaN throws). */
function clampVolume(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0, v));
}

export function normalizePeerAudioPref(p: Partial<PeerAudioPref> | undefined): PeerAudioPref {
  return {
    muted: !!p?.muted,
    volume: clampVolume(p?.volume),
    // 96-3: a row written before the split has neither field, and defaults
    // are exactly right for it -- the share played at full volume then.
    screenMuted: !!p?.screenMuted,
    screenVolume: clampVolume(p?.screenVolume),
  };
}

/** A pref indistinguishable from never having touched that peer. Those rows
 * are dropped rather than stored, which is also what keeps the synced blob
 * from growing a row per person you have ever been in a room with. */
export function isDefaultPeerAudioPref(p: PeerAudioPref): boolean {
  return !p.muted && p.volume === 1 && !p.screenMuted && p.screenVolume === 1;
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
