// chalk-web -- background effects for the published camera (52-1).
//
// There are two ways to blur someone's room, and they are not alternatives so
// much as a preference order:
//
//   native    -- the platform does it. Chrome exposes it as a track constraint
//                on hardware whose driver or OS already segments (Windows
//                Studio Effects, ChromeOS). Costs us no frames, no model and
//                no battery, and it happens BEFORE the frame reaches us.
//   processor -- we do it, in the camera graph's draw step, from a segmentation
//                mask we compute per frame. Works everywhere; costs real CPU.
//
// Native first whenever it exists: a blur that the OS applies for free beats
// one we spend a core on, and the user cannot tell them apart. This module is
// the decision plus the native half; the processor half is 52-2.
//
// Nothing here weakens E2E. Both paths run on the raw camera, on this device,
// long before SRTP.

/**
 * The non-standard slice of MediaTrackCapabilities we care about.
 *
 * `backgroundBlur` is a Chrome extension to the spec (no lib.dom type), and it
 * reports what the device can be SET to: [false] means "cannot", [true] means
 * "always on, cannot be turned off" (some vendor drivers), [false, true] means
 * "your choice".
 */
export interface BlurCapabilities {
  backgroundBlur?: boolean[];
}

/** How a want-blur preference should actually be satisfied. */
export type BlurPlan = "off" | "native" | "processor";

/**
 * nativeBlurCapable reports whether this track can be asked to blur itself.
 *
 * Includes the always-on case deliberately: a device that reports [true] is
 * already blurring, so treating it as capable keeps us from stacking our own
 * blur on top of the platform's.
 */
export function nativeBlurCapable(caps: BlurCapabilities | undefined): boolean {
  return caps?.backgroundBlur?.includes(true) === true;
}

/**
 * planBackgroundBlur is the whole precedence rule, in one testable place.
 *
 * Wanting blur that nothing on this machine can produce is "off" rather than an
 * error: the toggle is a preference, and a preference that cannot be honoured
 * here should still be remembered for the machine where it can.
 */
export function planBackgroundBlur(
  want: boolean,
  available: { native: boolean; processor: boolean },
): BlurPlan {
  if (!want) return "off";
  if (available.native) return "native";
  if (available.processor) return "processor";
  return "off";
}

/** The constraint shape, kept separate because it too is off-spec. */
interface BlurConstraints extends MediaTrackConstraints {
  backgroundBlur?: boolean;
}

/**
 * applyNativeBlur asks the track to blur (or stop blurring) itself, reporting
 * whether the platform took it.
 *
 * Never throws: applyConstraints rejects on a device that has since been
 * unplugged or a driver that changed its mind, and neither is a reason to
 * interrupt a call. A false return is the caller's cue to fall back to the
 * processor rather than to show an error.
 */
export async function applyNativeBlur(
  track: MediaStreamTrack | undefined,
  on: boolean,
): Promise<boolean> {
  if (!track) return false;
  if (!nativeBlurCapable(track.getCapabilities?.() as BlurCapabilities | undefined)) return false;
  try {
    await track.applyConstraints({ backgroundBlur: on } as BlurConstraints);
    return true;
  } catch {
    return false;
  }
}
