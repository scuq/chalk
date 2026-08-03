// countdown (80-14): the ephemeral-room timer's pure half.
//
// Rendering rules the components share:
//   * under an hour, the badge counts seconds ("42:05") and the App ticks
//     at 1 Hz -- ONE timer in App, never a setInterval per row, which would
//     re-render the whole roster every second for nothing.
//   * an hour and beyond coarsens to minutes/hours/days and the tick drops
//     to 60 s.
//   * urgency (the last five minutes) is a CLASS the components attach --
//     CSP is style-src 'self', so the countdown never drives an inline
//     style.

/** formatCountdown renders the time left as a compact badge label. */
export function formatCountdown(msLeft: number): string {
  if (msLeft <= 0) return "0:00";
  const secs = Math.ceil(msLeft / 1000);
  if (secs < 3600) {
    return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  }
  const hours = Math.floor(secs / 3600);
  if (hours < 48) {
    const mins = Math.floor((secs % 3600) / 60);
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

/** countdownTickMs picks the App timer cadence from the SOONEST expiry. */
export function countdownTickMs(msLeft: number): number {
  return msLeft <= 3_600_000 ? 1000 : 60_000;
}

/** countdownUrgent: the last five minutes get the warning class. */
export function countdownUrgent(msLeft: number): boolean {
  return msLeft <= 5 * 60_000;
}
