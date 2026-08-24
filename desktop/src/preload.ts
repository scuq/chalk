// chalk-desktop -- the preload, shared by every window.
//
// 104-1: two bridges, and a page only ever sees one:
//
//   chalkPicker   for the shell's own file: pages (src/picker/). Server
//                 list, connect/forget, share-source list and choice.
//   chalkDesktop  for the chalk server's page. Today it only says which
//                 shell this is; 104-3 adds the system-idle feed.
//
// The split is by protocol, decided here before any page script runs: a
// remote page must never be able to reach the picker's IPC, and the picker
// has no use for the page bridge. Sandboxed, so only `electron` is
// requirable.

import { contextBridge, ipcRenderer } from "electron";
import type { ShareSource } from "./screenshare";
import type { ServerEntry } from "./config";

export interface PickerBridge {
  servers(): Promise<{ servers: ServerEntry[]; last: string | null }>;
  connect(url: string): Promise<string | null>;
  forget(url: string): Promise<void>;
  sources(): Promise<ShareSource[]>;
  choose(id: string | null): void;
}

export interface DesktopIdleState {
  idleMs: number;
  locked: boolean;
}

export interface DesktopBridge {
  /** "chalk-desktop/<version>" -- lets the page know the shell is present. */
  shell: string;
  platform: NodeJS.Platform;
  /** 104-3: the OS idle clock (src/idle.ts). The page applies the threshold. */
  idle: {
    /** The current state, or null while the shell has no answer. */
    get(): Promise<DesktopIdleState | null>;
    /** Pushed every 15 s and immediately on lock/unlock/resume. Returns the
     * unsubscribe function. */
    subscribe(cb: (state: DesktopIdleState) => void): () => void;
  };
}

if (location.protocol === "file:") {
  const bridge: PickerBridge = {
    servers: () => ipcRenderer.invoke("picker:servers"),
    connect: (url) => ipcRenderer.invoke("picker:connect", url),
    forget: (url) => ipcRenderer.invoke("picker:forget", url),
    sources: () => ipcRenderer.invoke("picker:sources"),
    choose: (id) => ipcRenderer.send("picker:choose", id),
  };
  contextBridge.exposeInMainWorld("chalkPicker", bridge);
} else {
  const versionArg = process.argv.find((a) => a.startsWith("--chalk-desktop-version="));
  const bridge: DesktopBridge = {
    shell: `chalk-desktop/${versionArg ? versionArg.slice("--chalk-desktop-version=".length) : "dev"}`,
    platform: process.platform,
    idle: {
      get: () => ipcRenderer.invoke("chalk:idle:get"),
      subscribe: (cb) => {
        // Only the two fields cross the bridge: the event object stays here.
        const listener = (_event: Electron.IpcRendererEvent, state: DesktopIdleState) =>
          cb({ idleMs: state.idleMs, locked: state.locked });
        ipcRenderer.on("chalk:idle", listener);
        return () => ipcRenderer.removeListener("chalk:idle", listener);
      },
    },
  };
  contextBridge.exposeInMainWorld("chalkDesktop", bridge);
}
