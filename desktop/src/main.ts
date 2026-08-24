// chalk-desktop -- the main process.
//
// 104-1: one window that shows one chalk server, plus the plumbing a
// browser would otherwise provide: where links go, which permissions the
// page gets, how screen sharing picks a source, and a picker for the server
// itself. Nothing of chalk is embedded here; the page is the server's own,
// same-origin, unchanged. See docs/phases/PHASE-104-DESKTOP.md.
//
// Later slices: 104-2 tray + close-to-tray, 104-3 system idle → presence,
// 104-4 packaging.

import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { join } from "node:path";
import { installDesktopEntry } from "./linux-desktop";
import {
  CHECK_EVERY_MS,
  FIRST_CHECK_MS,
  fetchLatestRelease,
  isDevBuild,
  isNewer,
  shouldAnnounce,
  type ReleaseInfo,
} from "./update";
import {
  forgetServer,
  hostLabel,
  loadConfig,
  normalizeServerURL,
  rememberServer,
  saveConfig,
  type DesktopConfig,
} from "./config";
import { classifyLink, originOf } from "./links";
import { originOfURL, permissionAllowed } from "./permissions";
import { startIdlePublisher } from "./idle";
import { installDisplayMediaHandler, shellSession, type ShareSource } from "./screenshare";
import { createTray, type TrayHandle } from "./tray";
import { childWindowOptions, createChooser, createMainWindow, loadPicker } from "./window";

// --- command line ---------------------------------------------------------

interface Args {
  server: string | null;
  insecure: boolean;
  devtools: boolean;
  version: boolean;
  installDesktopEntry: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    server: null,
    insecure: false,
    devtools: false,
    version: false,
    installDesktopEntry: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--server" && i + 1 < argv.length) out.server = argv[++i];
    else if (a.startsWith("--server=")) out.server = a.slice("--server=".length);
    else if (a === "--insecure") out.insecure = true;
    else if (a === "--devtools") out.devtools = true;
    else if (a === "--version" || a === "-v") out.version = true;
    else if (a === "--install-desktop-entry") out.installDesktopEntry = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(1));
const VERSION = app.getVersion();

// 104-4: the two flags that never open a window.
if (args.version) {
  process.stdout.write(`chalk-desktop ${VERSION} (electron ${process.versions.electron}, chromium ${process.versions.chrome})\n`);
  app.exit(0);
} else if (args.installDesktopEntry) {
  if (process.platform !== "linux") {
    process.stderr.write("--install-desktop-entry is for Linux; other platforms register the app themselves\n");
    app.exit(2);
  } else {
    try {
      const path = installDesktopEntry(process.execPath, join(__dirname, "assets", "icon.png"));
      process.stdout.write(`wrote ${path}\n`);
      app.exit(0);
    } catch (e) {
      process.stderr.write(`could not install the desktop entry: ${String(e)}\n`);
      app.exit(1);
    }
  }
}

// --- single instance ------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// 104-2: Windows attributes toasts and taskbar grouping to this id. It only
// says "chalk" once an installer has created a Start-menu shortcut carrying
// the same id (104-4); until then the toast header is Electron's.
if (process.platform === "win32") app.setAppUserModelId("org.chalk.desktop");

// --- state ----------------------------------------------------------------

const CONFIG_PATH = join(app.getPath("userData"), "desktop.json");

let cfg: DesktopConfig = loadConfig(CONFIG_PATH);
let win: BrowserWindow | null = null;
/** Origin of the server the main window currently shows; null on the picker. */
let serverOrigin: string | null = null;
/** What the main window's title bar says; re-applied whenever the page
 * tries to set its own (see wireNavigation). */
let windowTitle = "chalk";
/** 104-2: set by before-quit so the window's close handler lets it go. */
let quitting = false;
/** 104-2: held for the app's lifetime; a collected Tray vanishes. */
let tray: TrayHandle | null = null;
/** 104-4: the newer release, once a check has found one. */
let update: ReleaseInfo | null = null;

function closeToTray(): boolean {
  return cfg.closeToTray !== false;
}

/** showWindow brings the one window back from hidden or minimised. */
function showWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function persist(next: DesktopConfig): void {
  cfg = next;
  try {
    saveConfig(CONFIG_PATH, cfg);
  } catch (e) {
    console.error("chalk-desktop: could not save config:", e);
  }
}

// --- navigation -----------------------------------------------------------

function showPicker(error?: string): void {
  if (!win) return;
  serverOrigin = null;
  windowTitle = "chalk";
  win.setTitle(windowTitle);
  void loadPicker(win, "server", error ? { error } : {});
}

/** connect validates, remembers and loads a server. Returns an error text
 * for the picker, or null when the load was started. */
function connect(input: string): string | null {
  const url = normalizeServerURL(input, args.insecure);
  if (url === null) {
    return "That is not a server address chalk can open. Use https://host, or http://127.0.0.1:port for a local dev stack.";
  }
  if (!win) return null;
  persist(rememberServer(cfg, url));
  serverOrigin = originOf(url);
  windowTitle = `chalk — ${hostLabel(url)}`;
  win.setTitle(windowTitle);
  void win.loadURL(url);
  return null;
}

function wireNavigation(w: BrowserWindow): void {
  const wc = w.webContents;

  // A link in the page itself. Same origin is the SPA doing its job; a
  // foreign origin is a pasted link and belongs to the system browser.
  wc.on("will-navigate", (event, url) => {
    switch (classifyLink(url, serverOrigin)) {
      case "in-app":
        return;
      case "external":
        event.preventDefault();
        void shell.openExternal(url);
        return;
      default:
        event.preventDefault();
    }
  });

  // window.open / target=_blank.
  wc.setWindowOpenHandler(({ url }) => {
    switch (classifyLink(url, serverOrigin)) {
      case "child":
        return { action: "allow", overrideBrowserWindowOptions: childWindowOptions(w) };
      case "in-app":
        // A same-origin target=_blank (a join link someone pasted into the
        // chat, say) is better in the window we have than in a second one.
        void wc.loadURL(url);
        return { action: "deny" };
      case "external":
        void shell.openExternal(url);
        return { action: "deny" };
      default:
        return { action: "deny" };
    }
  });

  // A server that does not answer is a picker with a message, not a
  // Chromium error page the user cannot get out of.
  wc.on("did-fail-load", (_event, code, description, validatedURL, isMainFrame) => {
    // -3 is ERR_ABORTED: a navigation we replaced ourselves.
    if (!isMainFrame || code === -3 || serverOrigin === null) return;
    showPicker(`Could not reach ${hostLabel(validatedURL)} (${description || code}).`);
  });

  // The page sets document.title itself (unread counts, notify/title.ts) and
  // Chromium sets one from the URL before the page does; both would replace
  // ours. Keep the host visible whatever the document says.
  wc.on("page-title-updated", (event) => {
    event.preventDefault();
    w.setTitle(windowTitle);
  });
  wc.on("did-finish-load", () => w.setTitle(windowTitle));

  // Persist geometry on the way out. Cheap enough to do on every change.
  const saveBounds = () => {
    if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    persist({ ...cfg, bounds: win.getNormalBounds() });
  };
  w.on("resize", saveBounds);
  w.on("move", saveBounds);
}

// --- permissions + screen share -----------------------------------------

function wireSession(): void {
  const ses = shellSession();

  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(permissionAllowed(permission, originOfURL(details.requestingUrl), serverOrigin));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return permissionAllowed(permission, originOfURL(requestingOrigin), serverOrigin);
  });

  installDisplayMediaHandler(ses, chooseShareSource);
}

let pendingSources: ShareSource[] | null = null;

/** chooseShareSource opens the chooser and resolves with the chosen id. */
function chooseShareSource(sources: ShareSource[]): Promise<string | null> {
  return new Promise((resolve) => {
    if (!win) {
      resolve(null);
      return;
    }
    pendingSources = sources;
    const chooser = createChooser(win);
    let done = false;
    const finish = (id: string | null) => {
      if (done) return;
      done = true;
      pendingSources = null;
      ipcMain.removeListener("picker:choose", onChoose);
      resolve(id);
      if (!chooser.isDestroyed()) chooser.close();
    };
    const onChoose = (event: Electron.IpcMainEvent, id: unknown) => {
      if (event.sender !== chooser.webContents) return;
      finish(typeof id === "string" ? id : null);
    };
    ipcMain.on("picker:choose", onChoose);
    chooser.on("closed", () => finish(null));
    void loadPicker(chooser, "share");
  });
}

// --- picker IPC -----------------------------------------------------------

function isPickerSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  // Only the shell's own file: pages may drive the picker API. The preload
  // already withholds the bridge from remote pages; this is the second lock.
  return event.senderFrame?.url.startsWith("file:") === true;
}

function wireIPC(): void {
  ipcMain.handle("picker:servers", (event) => {
    if (!isPickerSender(event)) return { servers: [], last: null };
    return { servers: cfg.servers, last: cfg.last ?? null };
  });
  ipcMain.handle("picker:connect", (event, url: unknown) => {
    if (!isPickerSender(event) || typeof url !== "string") return "Refused.";
    return connect(url);
  });
  ipcMain.handle("picker:forget", (event, url: unknown) => {
    if (!isPickerSender(event) || typeof url !== "string") return;
    persist(forgetServer(cfg, url));
  });
  ipcMain.handle("picker:sources", (event) => {
    if (!isPickerSender(event)) return [];
    return pendingSources ?? [];
  });
}

// --- updates (104-4) -------------------------------------------------------

function openUpdate(url: string): void {
  void shell.openExternal(url);
}

function showAbout(): void {
  void dialog.showMessageBox({
    type: "info",
    title: "About chalk",
    message: `chalk ${VERSION}`,
    detail: `Electron ${process.versions.electron}, Chromium ${process.versions.chrome}\n${
      update ? `Update available: ${update.version}` : "This is the latest release chalk knows about."
    }`,
    buttons: update ? ["Download update", "Close"] : ["Close"],
    defaultId: 0,
  }).then((r) => {
    if (update && r.response === 0) openUpdate(update.url);
  });
}

function announceUpdate(info: ReleaseInfo): void {
  update = info;
  tray?.setUpdate(info);
  buildMenu();
  if (!shouldAnnounce(cfg.notifiedVersion, info.version)) return;
  persist({ ...cfg, notifiedVersion: info.version });
  const opts: Electron.MessageBoxOptions = {
    type: "info",
    title: "chalk update",
    message: `chalk ${info.version} is available`,
    detail: `You have ${VERSION}. Download opens the release page in your browser; the tray and the chalk menu keep the link until you do.`,
    buttons: ["Download", "Later"],
    defaultId: 0,
    cancelId: 1,
  };
  const p = win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
  void p.then((r) => {
    if (r.response === 0) openUpdate(info.url);
  });
}

function startUpdateChecks(): void {
  if (cfg.checkUpdates === false || isDevBuild(VERSION)) return;
  const check = async () => {
    const latest = await fetchLatestRelease(fetch, `chalk-desktop/${VERSION}`);
    if (latest && isNewer(VERSION, latest.version) && update?.version !== latest.version) {
      announceUpdate(latest);
    }
  };
  setTimeout(() => void check(), FIRST_CHECK_MS);
  setInterval(() => void check(), CHECK_EVERY_MS);
}

// --- menu -----------------------------------------------------------------

function buildMenu(): void {
  const switchServer: MenuItemConstructorOptions = {
    label: "Switch server…",
    accelerator: "CmdOrCtrl+Shift+S",
    click: () => showPicker(),
  };
  const updateItems: MenuItemConstructorOptions[] = update
    ? [{ label: `Update to ${update.version}…`, click: () => openUpdate(update!.url) }, { type: "separator" }]
    : [];
  const template: MenuItemConstructorOptions[] = [];
  if (process.platform === "darwin") {
    template.push({
      label: app.name,
      submenu: [
        { label: "About chalk", click: showAbout },
        { type: "separator" },
        ...updateItems,
        switchServer,
        { type: "separator" },
        { role: "quit" },
      ],
    });
  } else {
    template.push({
      label: "chalk",
      submenu: [
        ...updateItems,
        switchServer,
        { type: "separator" },
        { label: "About chalk", click: showAbout },
        { role: "quit" },
      ],
    });
  }
  template.push({ role: "editMenu" });
  template.push({
    label: "View",
    submenu: [
      { role: "reload" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
      ...(args.devtools ? [{ role: "toggleDevTools" } as MenuItemConstructorOptions] : []),
    ],
  });
  template.push({ role: "windowMenu" });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- lifecycle ------------------------------------------------------------

app.on("second-instance", () => showWindow());

// macOS dock click with the window hidden.
app.on("activate", () => showWindow());

app.on("before-quit", () => {
  quitting = true;
  tray?.destroy();
  tray = null;
});

app.on("window-all-closed", () => {
  // With close-to-tray on, the window is hidden rather than closed, so this
  // only fires on a real quit (or with closeToTray: false), and then the app
  // ends on every platform, macOS included -- a dock icon with no window and
  // no tray would be a chalk that is silently still connected.
  app.quit();
});

app.on("web-contents-created", (_event, contents) => {
  // Pop-ups (child windows) get the same link policy as the main window.
  contents.on("will-navigate", (event, url) => {
    if (contents === win?.webContents) return;
    if (classifyLink(url, serverOrigin) === "in-app") return;
    event.preventDefault();
  });
});

void app.whenReady().then(() => {
  buildMenu();
  wireSession();
  wireIPC();
  win = createMainWindow(cfg.bounds, VERSION);
  wireNavigation(win);
  // 104-2: the close button hides; the page stays connected, keeps its keys
  // warm and keeps delivering notifications. Quit is the tray's, the menu's
  // and Cmd/Ctrl+Q's -- all of which set `quitting` first.
  win.on("close", (event) => {
    if (quitting || !closeToTray()) return;
    event.preventDefault();
    win?.hide();
  });
  win.on("closed", () => {
    win = null;
  });
  tray = createTray(
    {
      show: showWindow,
      pick: () => {
        showWindow();
        showPicker();
      },
      quit: () => app.quit(),
      update: openUpdate,
    },
    VERSION,
  );
  // 104-3: the OS idle clock for presence, pushed to whatever the window
  // shows; only the server page has the bridge to hear it.
  const stopIdle = startIdlePublisher(() => win);
  app.on("will-quit", stopIdle);
  startUpdateChecks();
  if (args.devtools) win.webContents.openDevTools({ mode: "detach" });

  const first = args.server ?? cfg.last ?? null;
  if (first === null) {
    showPicker();
  } else {
    const err = connect(first);
    if (err !== null) showPicker(err);
  }
});
