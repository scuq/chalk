// 63-3: making a saved input-device choice survive contact with reality.
//
// A deviceId is a per-origin, per-machine hash -- and on some setups not even
// that stable: Brave regenerates them every session, and a device that is
// plugged in later (AirPods) has no id at all at capture time. chalk passes
// the id as a soft constraint so a missing device falls back to the default
// instead of failing the join -- the right call, but SILENT: on macOS the
// fallback is the internal mic, and the user's choice just stops mattering
// with no sign of why.
//
// The fix is to remember the device's LABEL next to its id. Labels are what
// the user actually chose ("scuq's AirPods Pro"), they are stable across
// sessions and browsers don't randomize them. At capture time the saved id
// is used when it still exists; otherwise a device with the same label is
// used under whatever id it carries today; otherwise the default -- and the
// caller can tell, and say so, instead of shrugging.

/** The two fields of MediaDeviceInfo that matter here. */
export interface DeviceRef {
  deviceId: string;
  label: string;
}

/**
 * resolveDeviceId maps a saved (id, label) pair onto the CURRENT device list.
 * Returns the id to capture with, or "" for "system default" -- either
 * because nothing was saved or because the saved device is not present.
 * Duplicate labels resolve to the first match, which is also what a user
 * staring at two identical entries in a dropdown would pick.
 */
export function resolveDeviceId(savedId: string, savedLabel: string, devices: DeviceRef[]): string {
  if (savedId && devices.some((d) => d.deviceId === savedId)) return savedId;
  if (savedLabel) {
    const byLabel = devices.find((d) => d.label === savedLabel);
    if (byLabel) return byLabel.deviceId;
  }
  return "";
}

/**
 * resolveMicPrefs returns prefs with deviceId mapped onto the current device
 * list (see resolveDeviceId), ready for micConstraints. Never persisted --
 * the stored pair stays as picked, so the label keeps re-resolving in every
 * future session. A copy is only made when the id actually changes.
 */
export async function resolveMicPrefs<P extends DeviceChoice>(prefs: P): Promise<P> {
  if (!prefs.deviceId && !prefs.deviceLabel) return prefs;
  const resolved = resolveDeviceId(prefs.deviceId, prefs.deviceLabel, await listAudioInputs());
  return resolved === prefs.deviceId ? prefs : { ...prefs, deviceId: resolved };
}

/** The saved half of a device choice; MicPrefs satisfies this. */
export interface DeviceChoice {
  deviceId: string;
  deviceLabel: string;
}

/** The current audio inputs, or [] where enumeration is unavailable/denied. */
export async function listAudioInputs(): Promise<DeviceRef[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === "audioinput");
  } catch {
    return [];
  }
}
