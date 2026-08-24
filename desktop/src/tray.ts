// chalk-desktop -- the tray icon.
//
// 104-2: closing the window hides it; the tray is how it comes back, and
// the only place "Quit" lives once the window is gone. The icon is the app
// icon resized at runtime -- no second asset to keep in step with the mark.
//
// Platform notes, recorded so nobody rediscovers them:
//   macOS   18 px in the menu bar. A colour icon, not a template image: the
//           chalk mark is a coloured plate and a template would render it as
//           a black blob.
//   Windows 16 px in the notification area. Windows may tuck it into the
//           overflow chevron until the user drags it out; that is the OS,
//           not us.
//   Linux   22 px via StatusNotifierItem. GNOME shows it only with an
//           AppIndicator extension installed; without one there is no tray
//           and closing the window still hides it -- the app comes back
//           through the launcher (single-instance focuses the running one)
//           or `chalk-desktop` again. KDE, XFCE, MATE show it natively.

import { Menu, nativeImage, Tray } from "electron";
import { join } from "node:path";

const ICON = join(__dirname, "assets", "icon.png");

export interface TrayHandlers {
  /** Show and focus the window (restoring it if minimised). */
  show(): void;
  /** Show the window on the server picker. */
  pick(): void;
  /** Really quit, bypassing close-to-tray. */
  quit(): void;
}

function traySize(): number {
  switch (process.platform) {
    case "darwin":
      return 18;
    case "win32":
      return 16;
    default:
      return 22;
  }
}

/**
 * createTray builds the icon and its menu. The caller must keep the returned
 * Tray referenced for the app's lifetime -- Electron drops a garbage-collected
 * Tray from the bar.
 */
export function createTray(h: TrayHandlers): Tray {
  const base = nativeImage.createFromPath(ICON);
  const size = traySize();
  const icon = base.isEmpty() ? base : base.resize({ width: size, height: size });
  const tray = new Tray(icon);
  tray.setToolTip("chalk");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open chalk", click: () => h.show() },
      { label: "Switch server…", click: () => h.pick() },
      { type: "separator" },
      { label: "Quit chalk", click: () => h.quit() },
    ]),
  );
  // Left click opens on Windows and Linux; macOS opens the menu on any click
  // and ignores this, which matches how menu-bar items behave there.
  tray.on("click", () => h.show());
  tray.on("double-click", () => h.show());
  return tray;
}
