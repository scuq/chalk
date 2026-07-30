// chalk-web -- which camera and which speakers this machine uses (44-9).
//
// Same reasoning as the mic's deviceId in mic-prefs.ts: a deviceId is a
// per-origin hash of a socket on ONE machine, so none of this can follow the
// account to another one. localStorage, never near the server.
//
// The mic's device stays in mic-prefs rather than moving here, because it is
// welded to the capture constraints and the recapture test that live there.
// Splitting it out would be a refactor of the synced/local prefs split for no
// user-visible gain -- so this module owns the two devices that had no home at
// all, plus the enumeration both pickers need.
//
// Output selection is the odd one: it is not a capture constraint but a
// property of each <audio> element (setSinkId), and only Chromium-family
// browsers implement it. canChooseOutput() is what the UI asks before offering
// a picker nothing can act on.
//
// The pure half (normalizeDevicePrefs, cameraConstraints) is unit-tested; the
// localStorage wrappers and the DOM helpers are not, which is the convention
// mic-prefs and net-prefs already set.

import { useCallback, useEffect, useState } from "preact/hooks";

export interface DevicePrefs {
  /** "" means the system default camera, whatever it happens to be today. */
  cameraId: string;
  /** "" means the system default output. Only meaningful where setSinkId is. */
  outputId: string;
  /**
   * 52-1: blur the room behind you. Per-machine like the devices above, and
   * for a related reason: what it costs to honour depends on this machine's
   * camera and CPU, so "on" on the desktop should not follow you to the phone.
   */
  backgroundBlur: boolean;
}

const STORAGE_KEY = "chalk.devices.v1";

export const DEFAULT_DEVICE_PREFS: DevicePrefs = {
  cameraId: "",
  outputId: "",
  backgroundBlur: false,
};

/** normalizeDevicePrefs fills every field from a possibly-garbage stored value.
 * Total by construction: a throw here would take every voice join down. */
export function normalizeDevicePrefs(raw: unknown): DevicePrefs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_DEVICE_PREFS };
  const o = raw as Record<string, unknown>;
  return {
    cameraId: typeof o.cameraId === "string" ? o.cameraId : DEFAULT_DEVICE_PREFS.cameraId,
    outputId: typeof o.outputId === "string" ? o.outputId : DEFAULT_DEVICE_PREFS.outputId,
    backgroundBlur:
      typeof o.backgroundBlur === "boolean"
        ? o.backgroundBlur
        : DEFAULT_DEVICE_PREFS.backgroundBlur,
  };
}

/**
 * cameraConstraints builds the video half of getUserMedia.
 *
 * `true` rather than an empty deviceId when nothing is chosen, and a plain
 * (non-`exact`) hint when something is: a camera that has since been unplugged
 * should fall back to whatever is there rather than fail the join. Losing your
 * good webcam shouldn't lock you out of the call.
 */
export function cameraConstraints(prefs: DevicePrefs): MediaTrackConstraints | boolean {
  return prefs.cameraId ? { deviceId: prefs.cameraId } : true;
}

export function loadDevicePrefs(): DevicePrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_DEVICE_PREFS };
    return normalizeDevicePrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_DEVICE_PREFS };
  }
}

// Same-tab listeners, for the same reason as mic-prefs: the `storage` event
// deliberately does not fire in the tab that wrote it, so it alone would let
// the settings dialog change the camera while the live call in that very tab
// never hears about it.
const listeners = new Set<(prefs: DevicePrefs) => void>();

export function saveDevicePrefs(prefs: DevicePrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // The choice just won't survive a reload; it holds for this session.
  }
  for (const fn of listeners) fn(prefs);
}

export function subscribeDevicePrefs(onChange: (prefs: DevicePrefs) => void): () => void {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) onChange(loadDevicePrefs());
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function useDevicePrefs(): [DevicePrefs, (patch: Partial<DevicePrefs>) => void] {
  const [prefs, setPrefs] = useState<DevicePrefs>(loadDevicePrefs);
  const update = useCallback((patch: Partial<DevicePrefs>) => {
    setPrefs((prev) => {
      const next = normalizeDevicePrefs({ ...prev, ...patch });
      saveDevicePrefs(next);
      return next;
    });
  }, []);
  useEffect(() => subscribeDevicePrefs(setPrefs), []);
  return [prefs, update];
}

// ---- output routing --------------------------------------------------------

/**
 * canChooseOutput reports whether picking an output device means anything here.
 * Firefox hides audiooutput from enumerateDevices and Safari has no setSinkId
 * at all; on those, playback follows the system default and a picker would be
 * a control that does nothing.
 */
export function canChooseOutput(): boolean {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}

type SinkCapable = HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };

/**
 * applySinkId routes one element to the chosen output. Best-effort by design:
 * a device that has been unplugged since it was chosen throws here, and the
 * right answer is to keep playing on the default rather than to go silent.
 */
export async function applySinkId(el: HTMLMediaElement | null, outputId: string): Promise<void> {
  const sinkable = el as SinkCapable | null;
  if (!sinkable?.setSinkId) return;
  try {
    await sinkable.setSinkId(outputId);
  } catch {
    /* Unplugged, or not permitted. Playback stays on the previous sink. */
  }
}

/** useAudioOutput is the read-only half, for the elements that only play. */
export function useAudioOutput(): string {
  const [id, setID] = useState(() => loadDevicePrefs().outputId);
  useEffect(() => subscribeDevicePrefs((p) => setID(p.outputId)), []);
  return id;
}

// ---- enumeration -----------------------------------------------------------

export interface MediaDeviceLists {
  audioinput: MediaDeviceInfo[];
  videoinput: MediaDeviceInfo[];
  audiooutput: MediaDeviceInfo[];
}

const NO_DEVICES: MediaDeviceLists = { audioinput: [], videoinput: [], audiooutput: [] };

/**
 * useMediaDevices lists what is plugged in, and keeps listing it: plugging a
 * headset in while the settings dialog is open should just work.
 *
 * Labels are empty until permission has been granted at least once, so an
 * un-permitted browser reports a set of anonymous entries -- which is why the
 * panel's hint points at the test button.
 */
export function useMediaDevices(): MediaDeviceLists {
  const [devices, setDevices] = useState<MediaDeviceLists>(NO_DEVICES);

  const refresh = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices({
        audioinput: all.filter((d) => d.kind === "audioinput"),
        videoinput: all.filter((d) => d.kind === "videoinput"),
        audiooutput: all.filter((d) => d.kind === "audiooutput"),
      });
    } catch {
      setDevices(NO_DEVICES);
    }
  }, []);

  useEffect(() => {
    if (!navigator.mediaDevices) return;
    void refresh();
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refresh);
  }, [refresh]);

  return devices;
}
