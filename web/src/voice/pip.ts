// Tile pop-out (Phase 45, slice 45-5): one video stream in a window of its
// own, so a shared screen or a face can sit beside the app instead of inside
// a 16:9 tile in the middle of the chat.
//
// Two mechanisms, because only one of the three engines chalk supports has
// the good one:
//
//   * Document Picture-in-Picture (Chromium 116+) -- a real always-on-top OS
//     window. The video ELEMENT moves into it; the stream is never cloned, so
//     this costs no extra decode and no extra bandwidth.
//   * everywhere else (Firefox, Safari) -- the caller falls back to the
//     in-app expanded view, which is why every entry point here reports
//     whether it worked rather than throwing.
//
// The window is always MUTED: remote audio has exactly one output path
// (VoiceDock's sinks), and a second one would double every voice in the room.

/** Minimal shape of the Document PiP API (not in lib.dom yet). */
interface DocumentPiP {
  requestWindow(opts?: { width?: number; height?: number }): Promise<Window>;
  window: Window | null;
}

function api(): DocumentPiP | null {
  const w = globalThis as unknown as { documentPictureInPicture?: DocumentPiP };
  return w.documentPictureInPicture ?? null;
}

export function pipSupported(): boolean {
  return api() !== null;
}

/** Ceiling for the spawned window, so a 4K share doesn't ask for a 4K window. */
const MAX_W = 1280;
const MAX_H = 800;

/**
 * pipWindowSize picks the window size for a stream of the given intrinsic
 * dimensions: the source's own aspect ratio, scaled down to fit inside
 * MAX_W x MAX_H. Unknown dimensions (a track that hasn't produced a frame
 * yet) fall back to 16:9, which is what every camera tile is anyway.
 */
export function pipWindowSize(
  srcWidth: number | undefined,
  srcHeight: number | undefined,
): { width: number; height: number } {
  const w = srcWidth && srcWidth > 0 ? srcWidth : 1280;
  const h = srcHeight && srcHeight > 0 ? srcHeight : 720;
  const scale = Math.min(1, MAX_W / w, MAX_H / h);
  return {
    width: Math.max(240, Math.round(w * scale)),
    height: Math.max(135, Math.round(h * scale)),
  };
}

/**
 * openStreamPiP shows stream in a document Picture-in-Picture window and
 * returns whether it opened. false means "not supported, or the browser
 * refused" -- the caller shows the in-app expanded view instead.
 *
 * A second call replaces the contents of the window that is already open
 * rather than spawning another: one pop-out at a time, matching the app's own
 * pop-out (popout.ts) and the fact that there is one focused tile.
 */
export async function openStreamPiP(
  stream: MediaStream,
  label: string,
): Promise<boolean> {
  const pip = api();
  if (!pip) return false;
  const track = stream.getVideoTracks()[0];
  if (!track) return false;
  const settings = track.getSettings?.() ?? {};
  const { width, height } = pipWindowSize(settings.width, settings.height);
  try {
    const win = pip.window ?? (await pip.requestWindow({ width, height }));
    win.document.title = label;
    win.document.body.innerHTML = "";
    const style = win.document.createElement("style");
    style.textContent =
      "html,body{margin:0;height:100%;background:#000;overflow:hidden}" +
      "video{width:100%;height:100%;object-fit:contain;display:block}";
    win.document.head.appendChild(style);
    const video = win.document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.srcObject = stream;
    win.document.body.appendChild(video);
    return true;
  } catch {
    // Blocked (no user gesture, permission policy) or the window went away
    // mid-open. Either way the caller has a fallback.
    return false;
  }
}

/** closeStreamPiP shuts the pop-out window if one is open. Safe to call blind. */
export function closeStreamPiP(): void {
  api()?.window?.close();
}
