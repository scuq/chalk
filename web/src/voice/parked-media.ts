// 135-9: a capture kept open across a connection drop.
//
// When the WebSocket drops in a call, the session leaves the room and joins
// again once the socket is back. Closing the microphone and the camera in
// between made the rejoin call getUserMedia again, and on an installed iOS web
// app that call can show the permission prompt a second time. So the session
// parks the two chains of the dropped call here, and the next join adopts them.
//
// This module holds only the types and the two pure decisions, so node:test runs
// them with fakes. The session owns the timer and the call owns the hand-over.

/** PARK_MS is how long a parked capture can wait for a join, in milliseconds.
 * After that, canAdopt refuses it and the session closes it. While it waits,
 * the browser keeps its microphone indicator on. */
export const PARK_MS = 30_000;

/** ParkableChain is the part of a MicChain or a CameraChain that this module
 * needs. */
export interface ParkableChain {
  /** Reports whether the capture tracks are still live. */
  readonly captureLive: boolean;
  close(): void | Promise<void>;
}

/** A ParkedMedia is the capture of one dropped call. cameraChain is null if the
 * call had no camera. parkedAt is the time of the park, in milliseconds since
 * the epoch. */
export interface ParkedMedia<
  M extends ParkableChain = ParkableChain,
  C extends ParkableChain = ParkableChain,
> {
  micChain: M;
  cameraChain: C | null;
  parkedAt: number;
}

/** canAdopt reports whether a join can use the parked capture at time now.
 * It returns false if the capture is older than PARK_MS, if the microphone
 * is not live, or if wantVideo is true and the camera is missing or not live.
 * A camera that is not live does not matter when wantVideo is false. */
export function canAdopt(parked: ParkedMedia, wantVideo: boolean, now: number): boolean {
  if (now - parked.parkedAt > PARK_MS) return false;
  if (!parked.micChain.captureLive) return false;
  if (wantVideo && !parked.cameraChain?.captureLive) return false;
  return true;
}

/** closeParked closes the microphone chain and the camera chain, if any.
 * It does not wait for the chains to finish closing. */
export function closeParked(parked: ParkedMedia): void {
  void parked.micChain.close();
  void parked.cameraChain?.close();
}
