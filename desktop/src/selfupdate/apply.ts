// chalk-desktop -- the restart into a prepared version (105-2). The only
// file of the updater that touches Electron.
//
// Windows: retarget the Start-menu shortcut (create it if there is none --
// this is also what finally makes toasts say "chalk", the AppUserModelID
// rides on the shortcut), and the Desktop one if the user made one. Then
// release the single-instance lock, spawn the new exe detached, quit. The
// new process finds this one's directory older and removes it next start.
//
// Linux: same without the shortcut; --install-desktop-entry re-points the
// launcher entry to the new path when it exists.

import { app, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { installDesktopEntry } from "../linux-desktop";

export const APP_USER_MODEL_ID = "org.chalk.desktop";

function retargetShortcuts(exe: string, dir: string): void {
  const startMenu = join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "chalk.lnk");
  const desktop = join(app.getPath("desktop"), "chalk.lnk");
  const opts: Electron.ShortcutDetails = {
    target: exe,
    cwd: dir,
    appUserModelId: APP_USER_MODEL_ID,
    description: "chalk",
  };
  try {
    shell.writeShortcutLink(startMenu, existsSync(startMenu) ? "update" : "create", opts);
  } catch {
    // A locked-down profile; the new exe still starts from its own path.
  }
  if (existsSync(desktop)) {
    try {
      shell.writeShortcutLink(desktop, "update", opts);
    } catch {
      // same
    }
  }
}

/**
 * restartInto hands over to the prepared version. Returns only on failure
 * to spawn; on success the caller quits.
 */
export function restartInto(exe: string, dir: string, iconSource: string): boolean {
  if (process.platform === "win32") retargetShortcuts(exe, dir);
  if (process.platform === "linux") {
    const entry = join(process.env.XDG_DATA_HOME || join(app.getPath("home"), ".local", "share"), "applications", "chalk.desktop");
    if (existsSync(entry)) {
      try {
        installDesktopEntry(exe, iconSource);
      } catch {
        // Not fatal; the entry keeps pointing at the old path until re-run.
      }
    }
  }
  app.releaseSingleInstanceLock();
  try {
    const child = spawn(exe, [], { detached: true, stdio: "ignore", cwd: dir });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
