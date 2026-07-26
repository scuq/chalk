// chalk-web -- microphone capture preferences.
//
// Phase 30 Addendum A3/A4 (the vv-5 audio engine).
//
// 44-4: split by what the setting is actually a property OF. Everything you
// tune -- gain, the transmit gate, the processing flags, the voice keys --
// describes how you want to sound and follows the account through the server's
// prefs blob, so a second machine is not a fresh calibration job. The chosen
// input device does not: a deviceId is a per-origin hash of a socket on ONE
// machine, and syncing it would mean a laptop telling a desktop to use a
// microphone it has never seen.
//
// localStorage remains the runtime source of truth for the whole object -- the
// live call, the hotkeys and the meter all read it, and it has to answer before
// the socket is up. The server half arrives via applyRemoteMicPrefs and leaves
// via the publisher App registers.
//
// The pure half (normalizeMicPrefs, micConstraints, syncedMicPrefs) is
// unit-tested; the localStorage wrappers around it are not, which is the
// convention the display and sound prefs already set.

import { useCallback, useEffect, useState } from "preact/hooks";
import { isTransmitMode, type GateConfig, type TransmitMode } from "./vad";

export interface MicPrefs {
  /** "" means the system default device, whatever it happens to be today. */
  deviceId: string;
  /** Post-capture gain, 1 = unity. Applied by the Web Audio graph, not the browser. */
  gain: number;
  echoCancellation: boolean;
  /** The browser's built-in suppressor (WebRTC NS3). */
  noiseSuppression: boolean;
  autoGainControl: boolean;

  // Transmit gate (Addendum A4). See vad.ts for what the modes mean.
  mode: TransmitMode;
  /** Speech-above threshold, 0..1. */
  vadOpen: number;
  /** Silence-below threshold, 0..1. Never above vadOpen. */
  vadClose: number;
  /** Keep transmitting this long after the reason to transmit goes away, ms. */
  holdMs: number;

  // Keybinds, as KeyboardEvent.code ("" = unassigned). They only fire while a
  // chalk tab has focus -- a web page cannot claim an OS-global hotkey.
  /** Hold key for push-to-talk / push-to-mute. */
  keyTalk: string;
  /** Toggles self-mute (broadcast to the roster, like the call panel button). */
  keyMute: string;
  /** Toggles deafen: silences everyone else, and yourself with them. */
  keyDeafen: string;
}

const STORAGE_KEY = "chalk.mic.v1";

// Clamp bounds rather than an enum. 2x is the ceiling because gain is applied
// before the encoder: beyond roughly 2x a normal speaking voice clips, and a
// clipped signal is unrecoverable at the far end where a quiet one is merely
// quiet. The slider is the wrong place to let someone destroy their own audio.
export const MIN_GAIN = 0;
export const MAX_GAIN = 2;

// Two seconds of hold is already an absurdly long tail; the useful range is
// 100-500 ms and the slider should spend its travel there.
export const MAX_HOLD_MS = 2000;

// A keybind is stored as a KeyboardEvent.code. The cap is a sanity bound on a
// hand-edited entry, not a real constraint -- the longest real code is about
// 20 characters ("MediaTrackPrevious").
const MAX_KEY_LEN = 32;

// Everything the browser offers is on out of the box, which is also what
// getUserMedia({audio: true}) did before this existed -- so an existing user's
// first call after upgrading sounds exactly like their last one before it.
//
// The transmit mode defaults to "continuous" for the same reason, even though
// the design doc makes VAD the default: an upgrade must not silently start
// gating people's microphones with thresholds nobody has calibrated. Being cut
// off mid-sentence by a setting you never chose is far worse than transmitting
// a bit of room tone, and the profile panel makes the better modes findable.
export const DEFAULT_MIC_PREFS: MicPrefs = {
  deviceId: "",
  gain: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  mode: "continuous",
  vadOpen: 0.2,
  vadClose: 0.08,
  holdMs: 300,
  keyTalk: "",
  keyMute: "",
  keyDeafen: "",
};

function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function numOr(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function keyOr(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length <= MAX_KEY_LEN ? v : fallback;
}

// normalizeMicPrefs fills in every field from a possibly-partial,
// possibly-garbage stored value. Total by construction: this entry is
// user-editable and survives upgrades, and a throw here would take the profile
// panel and every voice join down with it.
export function normalizeMicPrefs(raw: unknown): MicPrefs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_MIC_PREFS };
  const o = raw as Record<string, unknown>;

  const vadOpen = numOr(o.vadOpen, DEFAULT_MIC_PREFS.vadOpen, 0, 1);
  // The silence floor can never sit above the speech threshold: that inverts
  // the hysteresis band and gives a gate that can open but never close.
  const vadClose = Math.min(vadOpen, numOr(o.vadClose, DEFAULT_MIC_PREFS.vadClose, 0, 1));

  return {
    // Not keyOr: a device id is a long opaque hash, well past the key cap.
    deviceId: typeof o.deviceId === "string" ? o.deviceId : DEFAULT_MIC_PREFS.deviceId,
    gain: numOr(o.gain, DEFAULT_MIC_PREFS.gain, MIN_GAIN, MAX_GAIN),
    echoCancellation: boolOr(o.echoCancellation, DEFAULT_MIC_PREFS.echoCancellation),
    noiseSuppression: boolOr(o.noiseSuppression, DEFAULT_MIC_PREFS.noiseSuppression),
    autoGainControl: boolOr(o.autoGainControl, DEFAULT_MIC_PREFS.autoGainControl),
    mode: isTransmitMode(o.mode) ? o.mode : DEFAULT_MIC_PREFS.mode,
    vadOpen,
    vadClose,
    holdMs: numOr(o.holdMs, DEFAULT_MIC_PREFS.holdMs, 0, MAX_HOLD_MS),
    keyTalk: keyOr(o.keyTalk, DEFAULT_MIC_PREFS.keyTalk),
    keyMute: keyOr(o.keyMute, DEFAULT_MIC_PREFS.keyMute),
    keyDeafen: keyOr(o.keyDeafen, DEFAULT_MIC_PREFS.keyDeafen),
  };
}

/**
 * micConstraints builds the getUserMedia audio constraints for these prefs.
 *
 * deviceId is omitted entirely when empty rather than sent as "": an exact
 * empty id matches no device and the capture fails outright, where omitting it
 * means "system default", which is what an empty pref means.
 *
 * The device is a plain (non-`exact`) hint on purpose. A saved device that has
 * since been unplugged should fall back to the default rather than fail the
 * join -- losing your good mic shouldn't lock you out of the call.
 *
 * This is also where the "never stack suppressors" rule from Addendum A2 will
 * live: when the RNNoise worklet lands, this must emit noiseSuppression:false
 * so NS3 and RNNoise don't fight and over-suppress. echoCancellation stays on
 * regardless -- RNNoise suppresses noise, it does not cancel echo.
 */
export function micConstraints(prefs: MicPrefs): MediaTrackConstraints {
  const c: MediaTrackConstraints = {
    echoCancellation: prefs.echoCancellation,
    noiseSuppression: prefs.noiseSuppression,
    autoGainControl: prefs.autoGainControl,
  };
  if (prefs.deviceId) c.deviceId = prefs.deviceId;
  return c;
}

/** gateConfig extracts just the transmit half, for the gate in mic-chain. */
export function gateConfig(prefs: MicPrefs): GateConfig {
  return {
    mode: prefs.mode,
    vadOpen: prefs.vadOpen,
    vadClose: prefs.vadClose,
    holdMs: prefs.holdMs,
  };
}

/**
 * SyncedMicPrefs (44-4): the fields that follow the account. Everything except
 * deviceId, which is meaningless on another machine.
 */
export type SyncedMicPrefs = Omit<MicPrefs, "deviceId">;

/** syncedMicPrefs extracts the account-scoped half, for sending to the server. */
export function syncedMicPrefs(prefs: MicPrefs): SyncedMicPrefs {
  const { deviceId: _local, ...synced } = prefs;
  return synced;
}

/**
 * sameSyncedMicPrefs compares the account-scoped half. Used to swallow the
 * echo of our own write coming back as a prefs ack -- without it, every change
 * would re-enter the store and re-notify the live call for no reason.
 */
export function sameSyncedMicPrefs(a: MicPrefs, b: MicPrefs): boolean {
  const ka = Object.keys(syncedMicPrefs(a)) as (keyof SyncedMicPrefs)[];
  return ka.every((k) => a[k] === b[k]);
}

/**
 * needsRecapture reports whether moving from `a` to `b` requires a new
 * getUserMedia. Gain alone is a graph parameter and applies instantly; the
 * device and the three processing flags are properties of the capture itself.
 */
export function needsRecapture(a: MicPrefs, b: MicPrefs): boolean {
  return (
    a.deviceId !== b.deviceId ||
    a.echoCancellation !== b.echoCancellation ||
    a.noiseSuppression !== b.noiseSuppression ||
    a.autoGainControl !== b.autoGainControl
  );
}

export function loadMicPrefs(): MicPrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_MIC_PREFS };
    return normalizeMicPrefs(JSON.parse(raw));
  } catch {
    // Private-browsing localStorage throws, and a corrupt entry throws in
    // JSON.parse. Neither is worth failing a call over.
    return { ...DEFAULT_MIC_PREFS };
  }
}

// Same-tab listeners, for the same reason as notify/prefs.ts: the `storage`
// event deliberately does not fire in the tab that wrote, so it alone would let
// the settings dialog change the gain while the live call in that very tab
// never hears about it.
const listeners = new Set<(prefs: MicPrefs) => void>();

export function saveMicPrefs(prefs: MicPrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // The setting just won't survive a reload. Listeners still fire, so it
    // holds for this session -- including for the call that's running now.
  }
  for (const fn of listeners) fn(prefs);
}

// 44-4: the upload half. App registers a publisher once the socket is up; the
// module stays ignorant of frames and of the WS client, which is what keeps it
// usable from the unit tests and from hotkeys.ts.
let publish: ((synced: SyncedMicPrefs) => void) | null = null;

/** setMicPrefsPublisher installs (or clears, with null) the server sink. */
export function setMicPrefsPublisher(fn: ((synced: SyncedMicPrefs) => void) | null): void {
  publish = fn;
}

/**
 * applyRemoteMicPrefs folds the account-scoped half of the server's prefs into
 * the local store. Called when prefs arrive -- on connect, and again whenever
 * another device changes them.
 *
 * It deliberately does NOT publish: this is the download direction, and echoing
 * it back would be a write loop between two tabs. Unchanged values are dropped
 * on the floor so the ack of our own write doesn't churn the live call.
 */
export function applyRemoteMicPrefs(remote: Partial<SyncedMicPrefs>): void {
  const current = loadMicPrefs();
  // deviceId is stripped rather than defaulted: a remote object that somehow
  // carries one must not move this machine's microphone.
  const { deviceId: _ignored, ...rest } = remote as Partial<MicPrefs>;
  const next = normalizeMicPrefs({ ...current, ...rest });
  if (sameSyncedMicPrefs(current, next)) return;
  saveMicPrefs(next);
}

/** subscribeMicPrefs reports every change, from this tab or another one. */
export function subscribeMicPrefs(onChange: (prefs: MicPrefs) => void): () => void {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) onChange(loadMicPrefs());
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function useMicPrefs(): [MicPrefs, (patch: Partial<MicPrefs>) => void] {
  const [prefs, setPrefs] = useState<MicPrefs>(loadMicPrefs);

  const update = useCallback((patch: Partial<MicPrefs>) => {
    setPrefs((prev) => {
      const next = normalizeMicPrefs({ ...prev, ...patch });
      saveMicPrefs(next);
      // 44-4: only a deliberate edit uploads. Publishing from the load path
      // would let a machine that has never opened the dialog overwrite the
      // account's tuning with this module's defaults.
      if (publish && !sameSyncedMicPrefs(prev, next)) publish(syncedMicPrefs(next));
      return next;
    });
  }, []);

  // Another tab on the same machine, or another machine via the server.
  useEffect(() => subscribeMicPrefs(setPrefs), []);

  return [prefs, update];
}
