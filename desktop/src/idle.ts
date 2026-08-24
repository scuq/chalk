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

import { ipcMain, powerMonitor, type BrowserWindow } from "electron";

export interface IdleState {
  idleMs: number;
  locked: boolean;
}

export const IDLE_CHANNEL = "chalk:idle";
export const IDLE_GET = "chalk:idle:get";

/** How often the clock is read while nothing else happens. Matches the
 * page's own EVALUATE_INTERVAL_MS; a finer tick buys nothing. */
const POLL_MS = 15_000;

/**
 * startIdlePublisher reads the OS clock on a timer and on lock/unlock, and
 * pushes to the window the caller returns (null while there is none). The
 * page can also pull the current state over IDLE_GET when it subscribes, so
 * it never waits a full tick for its opening value.
 */
export function startIdlePublisher(target: () => BrowserWindow | null): () => void {
  let locked = false;

  const read = (): IdleState => {
    // getSystemIdleState knows about the lock on the platforms that report
    // it; the events below keep `locked` current in between reads.
    const state = powerMonitor.getSystemIdleState(60);
    if (state === "locked") locked = true;
    return { idleMs: powerMonitor.getSystemIdleTime() * 1000, locked };
  };

  const publish = () => {
    const win = target();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(IDLE_CHANNEL, read());
  };

  const onLock = () => {
    locked = true;
    publish();
  };
  const onUnlock = () => {
    locked = false;
    publish();
  };
  // Waking from sleep: the idle clock may say hours; say so at once rather
  // than at the next tick.
  const onResume = () => publish();

  powerMonitor.on("lock-screen", onLock);
  powerMonitor.on("unlock-screen", onUnlock);
  powerMonitor.on("resume", onResume);
  const timer = setInterval(publish, POLL_MS);

  ipcMain.handle(IDLE_GET, (event) => {
    const win = target();
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return null;
    return read();
  });

  return () => {
    clearInterval(timer);
    powerMonitor.off("lock-screen", onLock);
    powerMonitor.off("unlock-screen", onUnlock);
    powerMonitor.off("resume", onResume);
    ipcMain.removeHandler(IDLE_GET);
  };
}
