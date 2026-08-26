// chalk-desktop -- the system idle clock, for presence.
//
// 104-3: what a web page cannot see is input that happens outside it, and
// that is exactly what "away" is about (web/src/presence/idle.ts explains
// the three layers). A browser gets this only from Chromium's IdleDetector;
// the shell asks the OS directly and hands the page two raw facts:
//
//   idleMs   milliseconds since the last input to ANY application
//   locked   whether the screen is locked (Windows and macOS report it;
//            Linux does not through powerMonitor -- same honest gap as
//            planned phase 90's wlroots note)
//
// The page applies the threshold (presence/desktop-idle.ts, the same ten
// minutes system-idle.ts uses), so policy stays where it already lives and
// this file is a clock. Nothing here leaves the machine: the page turns it
// into the same presence_update it already sends.
//
// 104-5: `locked` is derived on every read (idle-clock.ts says why a latch
// stuck a sleeping Mac on away), and the shell logs each power event and
// each change in what the OS answers, so the next stuck dot is readable off
// stdout instead of guessed at.

import { ipcMain, powerMonitor, type BrowserWindow } from "electron";
import { formatReading, readIdle, readingChanged } from "./idle-clock";
import type { IdleClockDeps, IdleReading, IdleState } from "./idle-clock";

export type { IdleState } from "./idle-clock";

export const IDLE_CHANNEL = "chalk:idle";
export const IDLE_GET = "chalk:idle:get";

/** How often the clock is read while nothing else happens. Matches the
 * page's own EVALUATE_INTERVAL_MS; a finer tick buys nothing. */
const POLL_MS = 15_000;

const deps: IdleClockDeps = {
  idleSeconds: () => powerMonitor.getSystemIdleTime(),
  idleState: () => powerMonitor.getSystemIdleState(60),
};

/**
 * startIdlePublisher reads the OS clock on a timer and on lock/unlock/resume,
 * and pushes to the window the caller returns (null while there is none).
 * The page can also pull the current state over IDLE_GET when it subscribes,
 * so it never waits a full tick for its opening value.
 */
export function startIdlePublisher(target: () => BrowserWindow | null): () => void {
  // The shell's own lock edge; the only thing remembered between reads.
  let eventLocked = false;
  let last: IdleReading | null = null;

  const read = (why: string): IdleState => {
    const r = readIdle(deps, eventLocked);
    if (why !== "tick" || readingChanged(last, r)) {
      console.log(`chalk-desktop idle: ${formatReading(why, r)}`);
    }
    last = r;
    return { idleMs: r.idleMs, locked: r.locked };
  };

  const publish = (why: string) => {
    const win = target();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(IDLE_CHANNEL, read(why));
  };

  const onLock = () => {
    eventLocked = true;
    publish("lock-screen");
  };
  const onUnlock = () => {
    eventLocked = false;
    publish("unlock-screen");
  };
  // Waking from sleep: the idle clock may say hours; say so at once rather
  // than at the next tick.
  const onResume = () => publish("resume");
  // Logged only: what the OS answered on the way down is half of any
  // wake-up diagnosis.
  const onSuspend = () => read("suspend");
  const onTick = () => publish("tick");

  powerMonitor.on("lock-screen", onLock);
  powerMonitor.on("unlock-screen", onUnlock);
  powerMonitor.on("resume", onResume);
  powerMonitor.on("suspend", onSuspend);
  const timer = setInterval(onTick, POLL_MS);

  ipcMain.handle(IDLE_GET, (event) => {
    const win = target();
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return null;
    return read("get");
  });

  return () => {
    clearInterval(timer);
    powerMonitor.off("lock-screen", onLock);
    powerMonitor.off("unlock-screen", onUnlock);
    powerMonitor.off("resume", onResume);
    powerMonitor.off("suspend", onSuspend);
    ipcMain.removeHandler(IDLE_GET);
  };
}
