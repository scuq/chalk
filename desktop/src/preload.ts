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

export interface DesktopBridge {
  /** "chalk-desktop/<version>" -- lets the page know the shell is present. */
  shell: string;
  platform: NodeJS.Platform;
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
  const bridge: DesktopBridge = {
    shell: `chalk-desktop/${process.env.CHALK_DESKTOP_VERSION ?? "dev"}`,
    platform: process.platform,
  };
  contextBridge.exposeInMainWorld("chalkDesktop", bridge);
}
