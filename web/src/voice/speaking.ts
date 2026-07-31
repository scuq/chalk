// 63-2: who is audible right now.
//
// The call layer samples each peer's inbound audio level a few times a
// second (RTCRtpReceiver.getSynchronizationSources -- a synchronous, passive
// read, so it never competes with media the way an extra getStats would).
// This tracker turns those raw samples into a stable "speaking" set: a tile
// lights the moment a loud-enough sample arrives and stays lit for a short
// hold window, so the dot doesn't strobe in the pauses between words. Pure
// module, testable without WebRTC.

/** Poll cadence for the sync-source reads. */
export const SPEAKING_POLL_MS = 250;

/** Inbound audioLevel (0..1) at or above this counts as sound, not noise. */
export const SPEAKING_LEVEL = 0.02;

/** How long a tile stays lit after the last loud sample. */
export const SPEAKING_HOLD_MS = 600;

export class SpeakingTracker {
  private lastLoud = new Map<string, number>();

  /** Feed one sample. `fresh` = the receiver actually played out new audio
   * since the previous poll (a frozen timestamp means DTX/silence, whose
   * stale level must not count). */
  sample(key: string, level: number, fresh: boolean, now: number): void {
    if (fresh && level >= SPEAKING_LEVEL) this.lastLoud.set(key, now);
  }

  /** Keys currently within the hold window, sorted for cheap comparison.
   * Expired entries are dropped so departed peers don't accumulate. */
  current(now: number): string[] {
    const out: string[] = [];
    for (const [key, t] of this.lastLoud) {
      if (now - t <= SPEAKING_HOLD_MS) out.push(key);
      else this.lastLoud.delete(key);
    }
    return out.sort();
  }
}
