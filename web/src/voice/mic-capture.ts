// 122-1: capturing the microphone the user chose, and knowing that we did.
//
// Every mic capture in chalk (the join, the mid-call swap, the settings
// dialog's meter) goes through captureMic. Before this module each site called
// getUserMedia itself with the device id as a plain hint, and nothing checked
// which device the returned track was on. Chromium honours a hint only for a
// device in its capture capability list; a device it has enumerated but cannot
// describe yet -- a headset that just paired, an input the audio service has
// not caught up with -- is missing from that list, and getUserMedia then
// succeeds on the DEFAULT device with no error. On the desktop app that read
// as: pick the new mic in the dropdown, nothing happens, rejoin (macOS) or
// restart the app (Windows).
//
// captureMic does three things about it:
//   1. the id is exact (micConstraints), so a device the browser cannot open
//      fails instead of silently becoming the default;
//   2. the track that comes back is checked against the request
//      (captureLanded) -- belt and braces for engines that ignore exact;
//   3. a failure is retried a few times with the device list re-read in
//      between, because the usual cause is a device that needs a second or two
//      more to settle. Only then is it reported, or (on a join) replaced by the
//      default WITH a notice.
//
// The browser calls are injected so the loop runs under node:test with fakes.

import { micConstraints, type MicPrefs } from "./mic-prefs";
import { listAudioInputs, resolveDeviceId, type DeviceRef } from "./device-resolve";

/** The browser surface captureMic needs. browserCaptureDeps is the real one. */
export interface CaptureDeps {
  gum: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  enumerate: () => Promise<DeviceRef[]>;
  sleep: (ms: number) => Promise<void>;
}

export const browserCaptureDeps: CaptureDeps = {
  gum: (c) => navigator.mediaDevices.getUserMedia(c),
  enumerate: listAudioInputs,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface CaptureOptions {
  /**
   * What to do when the chosen device still cannot be opened after the last
   * try. A join wants the default (a call on the wrong mic beats no call);
   * a mid-call swap wants the error (the old mic is still there to keep).
   */
  fallbackToDefault: boolean;
  /** Passed through unchanged, so a join keeps its ONE getUserMedia for the
   * mic and the camera (one permission prompt on a first join). */
  video?: MediaStreamConstraints["video"];
  /** Captures of the chosen device before giving up. Default 4. */
  attempts?: number;
  /** Pause between tries. Default 600 ms: a headset that re-registers
   * itself takes one to two seconds to settle. */
  delayMs?: number;
}

export interface CaptureOutcome {
  stream: MediaStream;
  /** The device id asked for on the last try, after resolution. "" is the
   * system default -- nothing was saved, or the saved device is absent. */
  requested: string;
  /** What the track's getSettings() reports, or null when the engine says
   * nothing. Diagnostics only; captureLanded is what decided. */
  landed: string | null;
  /** Captures of the chosen device that were made, successful or not. */
  attempts: number;
  /** True when the chosen device never opened and the default was captured
   * in its place. Only possible with fallbackToDefault. */
  fellBack: boolean;
}

const DEFAULT_ATTEMPTS = 4;
const DEFAULT_DELAY_MS = 600;

/**
 * captureLanded reports whether a captured track is on the device that was
 * asked for. An empty request (system default) always lands. Otherwise the
 * track's settings id must match, or -- for Brave, whose ids differ between
 * enumeration and settings, and for engines that leave deviceId out of
 * settings -- its label must match the saved one. With neither available
 * there is nothing to check against, and the capture is taken at its word.
 */
export function captureLanded(
  track: { getSettings(): MediaTrackSettings; label: string },
  requestedId: string,
  requestedLabel: string,
): boolean {
  if (!requestedId) return true;
  const id = track.getSettings().deviceId ?? "";
  if (id && id === requestedId) return true;
  if (requestedLabel && track.label) return track.label === requestedLabel;
  return !id;
}

/** retryable reports whether a getUserMedia failure is worth another try. */
function retryable(err: unknown, withVideo: boolean): boolean {
  switch ((err as DOMException)?.name ?? "") {
    case "OverconstrainedError":
      // Ours: the exact mic id. The camera id is a plain hint and never
      // raises this, so it is unambiguous even in a combined request.
      return true;
    case "NotFoundError":
    case "NotReadableError":
    case "TrackStartError":
      // In a combined request these can be the camera's. The join's
      // audio-only tier retries them without the ambiguity, so give up here
      // at once instead of spending the retry budget on the wrong device.
      return !withVideo;
    default:
      // A denial or a security error will not change in 600 ms.
      return false;
  }
}

function landedId(stream: MediaStream): string | null {
  const t = stream.getAudioTracks()[0];
  if (!t) return null;
  return t.getSettings().deviceId ?? null;
}

function stopAll(stream: MediaStream): void {
  for (const t of stream.getTracks()) t.stop();
}

/**
 * captureMic captures the mic that `prefs` names, or the default when it
 * names none, re-resolving the saved (id, label) pair against the device list
 * before every try. Throws whatever getUserMedia threw last; a request the
 * chosen device kept answering with another device throws an
 * OverconstrainedError of our own so the caller's phrasing is the same.
 */
export async function captureMic(
  prefs: MicPrefs,
  deps: CaptureDeps,
  opts: CaptureOptions,
): Promise<CaptureOutcome> {
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS);
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const withVideo = opts.video !== undefined && opts.video !== false;
  const request = (audio: MediaTrackConstraints): MediaStreamConstraints =>
    withVideo ? { audio, video: opts.video } : { audio };

  let lastErr: unknown = null;
  let tries = 0;
  let requested = "";
  for (let i = 0; i < attempts; i++) {
    // Re-read the list every time: the device that was not there a moment
    // ago is the device this loop exists for.
    requested = resolveDeviceId(prefs.deviceId, prefs.deviceLabel, await deps.enumerate());
    if (requested === "") {
      // Nothing to insist on. One plain capture, and no retry: a missing
      // device is the devicechange watch's business, not this loop's.
      const stream = await deps.gum(request(micConstraints({ ...prefs, deviceId: "" })));
      return { stream, requested, landed: landedId(stream), attempts: tries + 1, fellBack: false };
    }
    tries++;
    let stream: MediaStream;
    try {
      stream = await deps.gum(request(micConstraints({ ...prefs, deviceId: requested })));
    } catch (err) {
      if (!retryable(err, withVideo)) throw err;
      lastErr = err;
      if (i < attempts - 1) await deps.sleep(delayMs);
      continue;
    }
    const track = stream.getAudioTracks()[0];
    if (track && captureLanded(track, requested, prefs.deviceLabel)) {
      return { stream, requested, landed: landedId(stream), attempts: tries, fellBack: false };
    }
    // The engine gave us a different device without complaint. Not ours to
    // keep: release it and ask again.
    stopAll(stream);
    lastErr = new DOMException(
      `microphone ${requested} answered with another device`,
      "OverconstrainedError",
    );
    if (i < attempts - 1) await deps.sleep(delayMs);
  }

  if (!opts.fallbackToDefault) throw lastErr;
  const stream = await deps.gum(request(micConstraints({ ...prefs, deviceId: "" })));
  return { stream, requested, landed: landedId(stream), attempts: tries, fellBack: true };
}
