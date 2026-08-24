// chalk-desktop -- the one window, and the small modal it borrows for the
// two choosers (server, share source).
//
// 104-1: both windows share dist/preload.js. The preload looks at the page's
// protocol: a file: page (the picker) gets the `chalkPicker` bridge, the
// server's page gets `chalkDesktop`. Neither window has node integration and
// both are sandboxed; every capability goes through contextBridge + ipcMain.

import { BrowserWindow, nativeImage } from "electron";
import { join } from "node:path";
import { DEFAULT_BOUNDS, type WindowBounds } from "./config";

export const PRELOAD = join(__dirname, "preload.js");
const PICKER_HTML = join(__dirname, "picker.html");
const ICON = join(__dirname, "assets", "icon.png");

export function createMainWindow(bounds: WindowBounds | undefined): BrowserWindow {
  const b = bounds ?? DEFAULT_BOUNDS;
  const win = new BrowserWindow({
    width: b.width,
    height: b.height,
    x: b.x,
    y: b.y,
    minWidth: 480,
    minHeight: 400,
    title: "chalk",
    // Windows/Linux draw the icon from here; macOS takes it from the bundle.
    icon: process.platform === "darwin" ? undefined : nativeImage.createFromPath(ICON),
    autoHideMenuBar: true,
    backgroundColor: "#111214",
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  return win;
}

export type PickerMode = "server" | "share";

/** loadPicker points a window at the picker page in the given mode. */
export function loadPicker(
  win: BrowserWindow,
  mode: PickerMode,
  params: Record<string, string> = {},
): Promise<void> {
  const query: Record<string, string> = { mode, ...params };
  return win.loadFile(PICKER_HTML, { query });
}

/**
 * createChooser opens the share-source chooser as a modal child of the main
 * window. Sized for a grid of thumbnails; closed by the choice or by the
 * user.
 */
export function createChooser(parent: BrowserWindow): BrowserWindow {
  const win = new BrowserWindow({
    parent,
    modal: true,
    width: 720,
    height: 520,
    minWidth: 480,
    minHeight: 360,
    title: "Share your screen",
    autoHideMenuBar: true,
    backgroundColor: "#111214",
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  return win;
}

/**
 * createChildWindow is for the page's own about:blank pop-ups (recovery
 * print, pop-out call). Same hardening as the main window; the page writes
 * into the window itself, so there is nothing to load.
 */
export function childWindowOptions(parent: BrowserWindow): Electron.BrowserWindowConstructorOptions {
  return {
    parent,
    width: 520,
    height: 680,
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}
