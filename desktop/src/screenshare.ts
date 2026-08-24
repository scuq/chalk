// chalk-desktop -- screen sharing.
//
// 104-1: Electron does not ship Chromium's share picker. Without a
// setDisplayMediaRequestHandler every getDisplayMedia() call fails, so the
// shell supplies one:
//
//   macOS 15+   the system picker (SCContentSharingPicker); Electron drives
//               it when `useSystemPicker` is set and falls back to the
//               handler below on older macOS.
//   elsewhere   our own chooser: desktopCapturer lists screens and windows
//               with thumbnails, the picker window (src/picker/, mode=share)
//               shows them, the choice comes back over IPC.
//
// System audio: voice/call.ts asks for `systemAudio: "include"`. Electron can
// only satisfy that on Windows ('loopback'); on Linux and macOS the share is
// video-only and the page's existing "no system audio" path applies.

import { desktopCapturer, session, type DesktopCapturerSource } from "electron";

export interface ShareSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  /** data: URL of the thumbnail, sized for the chooser. */
  thumbnail: string;
  /** data: URL of the app icon for windows, when the OS gave one. */
  icon: string | null;
}

export type ChooseSource = (sources: ShareSource[]) => Promise<string | null>;

function toShareSource(s: DesktopCapturerSource): ShareSource {
  return {
    id: s.id,
    name: s.name,
    kind: s.id.startsWith("screen:") ? "screen" : "window",
    thumbnail: s.thumbnail.isEmpty() ? "" : s.thumbnail.toDataURL(),
    icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
  };
}

/**
 * installDisplayMediaHandler wires the session. `choose` opens the chooser
 * and resolves with a source id, or null when the user cancelled.
 */
export function installDisplayMediaHandler(ses: Electron.Session, choose: ChooseSource): void {
  ses.setDisplayMediaRequestHandler(
    (_request, callback) => {
      void (async () => {
        let sources: DesktopCapturerSource[];
        try {
          sources = await desktopCapturer.getSources({
            types: ["screen", "window"],
            thumbnailSize: { width: 320, height: 200 },
            fetchWindowIcons: true,
          });
        } catch {
          callback({});
          return;
        }
        const byId = new Map(sources.map((s) => [s.id, s]));
        const id = await choose(sources.map(toShareSource));
        const picked = id === null ? undefined : byId.get(id);
        if (!picked) {
          // No video → Electron rejects the getDisplayMedia() promise, which
          // is what the page expects from a cancelled picker.
          callback({});
          return;
        }
        if (process.platform === "win32") {
          callback({ video: picked, audio: "loopback" });
        } else {
          callback({ video: picked });
        }
      })();
    },
    { useSystemPicker: process.platform === "darwin" },
  );
}

/** defaultSession is what every window here uses; exported for main.ts. */
export function shellSession(): Electron.Session {
  return session.defaultSession;
}
