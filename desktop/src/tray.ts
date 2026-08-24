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
  /** 104-4: open the release page for a newer version. */
  update(url: string): void;
}

export interface TrayHandle {
  /** setUpdate adds (or removes, with null) the "Update to vX…" entry. */
  setUpdate(info: { version: string; url: string } | null): void;
  destroy(): void;
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
export function createTray(h: TrayHandlers, version: string): TrayHandle {
  const base = nativeImage.createFromPath(ICON);
  const size = traySize();
  const icon = base.isEmpty() ? base : base.resize({ width: size, height: size });
  const tray = new Tray(icon);

  const render = (update: { version: string; url: string } | null) => {
    tray.setToolTip(update ? `chalk ${version} — ${update.version} available` : `chalk ${version}`);
    const items: Electron.MenuItemConstructorOptions[] = [
      { label: "Open chalk", click: () => h.show() },
      { label: "Switch server…", click: () => h.pick() },
    ];
    if (update) {
      items.push({ type: "separator" });
      items.push({ label: `Update to ${update.version}…`, click: () => h.update(update.url) });
    }
    items.push({ type: "separator" });
    items.push({ label: "Quit chalk", click: () => h.quit() });
    tray.setContextMenu(Menu.buildFromTemplate(items));
  };
  render(null);

  // Left click opens on Windows and Linux; macOS opens the menu on any click
  // and ignores this, which matches how menu-bar items behave there.
  tray.on("click", () => h.show());
  tray.on("double-click", () => h.show());
  return {
    setUpdate: (info) => render(info),
    destroy: () => tray.destroy(),
  };
}
