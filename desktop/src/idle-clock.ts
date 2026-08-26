// chalk-desktop -- 104-5: the idle clock's arithmetic, kept free of Electron
// so it can be tested.
//
// idle.ts used to remember "locked": one reading of getSystemIdleState() ==
// "locked" latched it, and only an unlock-screen event cleared it. Two things
// break that on macOS. Chromium's own "locked" (ui/base/idle/idle_mac.mm) is
// not a query but a pair of notification latches -- screensaverRunning ||
// screenLocked, set by com.apple.screensaver.didstart / screenIsLocked and
// cleared by didstop / screenIsUnlocked -- and a Mac that sleeps through the
// screensaver does not reliably post didstop on wake, so Chromium can answer
// "locked" for the rest of the process. And a screensaver without a password
// never produces unlock-screen at all, so a latch it set had nothing to clear
// it. Either way the page saw locked:true, which is rule 1 of decideIdle and
// beats every input: away until the app restarted.
//
// So nothing here is remembered across reads. `locked` is derived on every
// read from two live facts:
//
//   eventLocked   lock-screen set it, unlock-screen cleared it -- the shell's
//                 own edge, immediate on the platforms that emit it
//   osState       getSystemIdleState(), trusted only when the OS also reports
//                 no input for STALE_LOCK_MS: a screensaver or lock screen
//                 that saw input a moment ago is a stale latch, because input
//                 is exactly what ends a screensaver.

export type OSIdleState = "active" | "idle" | "locked" | "unknown";

export interface IdleClockDeps {
  /** powerMonitor.getSystemIdleTime, seconds since the last input anywhere. */
  idleSeconds(): number;
  /** powerMonitor.getSystemIdleState at some threshold; only "locked" matters. */
  idleState(): OSIdleState;
}

export interface IdleState {
  idleMs: number;
  locked: boolean;
}

/** One read, with the facts it was derived from, for the log. */
export interface IdleReading extends IdleState {
  osState: OSIdleState;
  eventLocked: boolean;
}

/**
 * How long input must have been absent before an OS-reported lock counts on
 * its own. Well under the page's ten-minute threshold, well over one poll
 * tick, and below the shortest screensaver delay macOS offers (one minute),
 * so a genuine screensaver always clears it.
 */
export const STALE_LOCK_MS = 30_000;

export function readIdle(deps: IdleClockDeps, eventLocked: boolean): IdleReading {
  const secs = deps.idleSeconds();
  const idleMs = Number.isFinite(secs) && secs > 0 ? secs * 1000 : 0;
  const osState = deps.idleState();
  const osLocked = osState === "locked" && idleMs >= STALE_LOCK_MS;
  return { idleMs, locked: eventLocked || osLocked, osState, eventLocked };
}

/** readingChanged says whether a tick is worth a log line: the raw OS state
 * or the derived verdict moved. idleMs alone moves every tick. */
export function readingChanged(prev: IdleReading | null, next: IdleReading): boolean {
  if (!prev) return true;
  return prev.osState !== next.osState || prev.locked !== next.locked || prev.eventLocked !== next.eventLocked;
}

/** formatReading is the log line's body: every input and the verdict, so a
 * stuck dot can be read off the shell's stdout. */
export function formatReading(why: string, r: IdleReading): string {
  return (
    `${why}: os=${r.osState} idle=${Math.round(r.idleMs / 1000)}s ` +
    `events=${r.eventLocked ? "locked" : "unlocked"} -> locked=${r.locked}`
  );
}
