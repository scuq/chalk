// Tile pop-outs (Phase 45, slice 45-5; multi-window since 47-4): video streams
// in windows of their own, so shared screens and faces can sit beside the app
// instead of inside 16:9 tiles in the middle of the chat.
//
// Any number can be open at once -- three people and a screen share is the
// case this exists for -- so each pop-out is tracked by its stage-tile key.
// Two mechanisms, because the good one is rationed:
//
//   * Document Picture-in-Picture (Chromium 116+) -- a real always-on-top OS
//     window, but a document gets exactly ONE. The first pop-out takes it.
//   * an ordinary pop-up window for every pop-out after that, and for every
//     pop-out on Firefox and Safari, which have no document PiP at all. Not
//     always-on-top, but a window all the same.
//
// Neither is guaranteed: PiP can be refused and pop-ups can be blocked, which
// is why opening reports whether it worked rather than throwing -- the caller
// falls back to the in-app expanded view.
//
// Every window is MUTED: remote audio has exactly one output path (VoiceDock's
// sinks), and a second one would double every voice in the room.

/** Minimal shape of the Document PiP API (not in lib.dom yet). */
interface DocumentPiP {
  requestWindow(opts?: { width?: number; height?: number }): Promise<Window>;
  window: Window | null;
}

function api(host: unknown = globalThis): DocumentPiP | null {
  return (host as { documentPictureInPicture?: DocumentPiP })?.documentPictureInPicture ?? null;
}

export function pipSupported(): boolean {
  return api() !== null;
}

/** Ceiling for a spawned window, so a 4K share doesn't ask for a 4K window. */
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

/** One open pop-out window. */
interface Popout {
  win: Window;
  video: HTMLVideoElement;
  stream: MediaStream;
  /** Detaches the end-of-stream watcher for the stream currently shown. */
  unwatch: () => void;
}

const open = new Map<string, Popout>();
const watchers = new Set<() => void>();

function notify(): void {
  for (const fn of watchers) fn();
}

/** subscribePopouts notifies on every open/close, so a view can track state. */
export function subscribePopouts(fn: () => void): () => void {
  watchers.add(fn);
  return () => {
    watchers.delete(fn);
  };
}

/** popoutKeys lists the tile keys currently showing in a window of their own. */
export function popoutKeys(): string[] {
  return [...open.keys()];
}

/**
 * openTilePopout shows stream in its own window and reports whether one
 * opened. false means "no mechanism available, or the browser refused" -- the
 * caller shows the in-app expanded view instead.
 *
 * Popping out a tile that is already popped out raises its window rather than
 * spawning a duplicate.
 */
export async function openTilePopout(
  key: string,
  stream: MediaStream,
  label: string,
  host: Window = window,
): Promise<boolean> {
  const already = open.get(key);
  if (already) {
    if (!already.win.closed) {
      already.win.focus();
      return true;
    }
    drop(key);
  }
  const track = stream.getVideoTracks()[0];
  if (!track) return false;
  const settings = track.getSettings?.() ?? {};
  const size = pipWindowSize(settings.width, settings.height);

  const pip = api(host);
  // The floating window goes to whoever asks first; everyone else gets a
  // plain one. Reusing it for a second tile would evict the first.
  if (pip && !pip.window) {
    try {
      attach(key, await pip.requestWindow(size), stream, label, host);
      return true;
    } catch {
      // Refused (no user gesture, permission policy). A pop-up may still
      // work, and if the gesture is spent that returns false too.
    }
  }
  return openPlain(key, stream, label, size, host);
}

function openPlain(
  key: string,
  stream: MediaStream,
  label: string,
  size: { width: number; height: number },
  host: Window,
): boolean {
  const screen = host.screen;
  // Cascade, so four pop-outs don't land in one stack on top of each other.
  const step = 32 * (open.size % 6);
  const left = Math.max(0, Math.round((screen.availWidth - size.width) / 2) + step);
  const top = Math.max(0, Math.round((screen.availHeight - size.height) / 2) + step);
  // The name is per tile: if we ever lose track of a window (session restore),
  // re-opening that tile reuses it instead of stacking a second one on it.
  const name = "chalk-tile-" + key.replace(/[^a-zA-Z0-9]+/g, "-");
  const win = host.open(
    "",
    name,
    `popup=yes,width=${size.width},height=${size.height},left=${left},top=${top}`,
  );
  if (!win) return false; // blocked
  attach(key, win, stream, label, host);
  win.focus();
  return true;
}

function attach(
  key: string,
  win: Window,
  stream: MediaStream,
  label: string,
  host: Window,
): void {
  const doc = win.document;
  doc.title = label;
  doc.body.innerHTML = "";
  const style = doc.createElement("style");
  style.textContent =
    "html,body{margin:0;height:100%;background:#000;overflow:hidden}" +
    "video{width:100%;height:100%;object-fit:contain;display:block}";
  doc.head.appendChild(style);
  const video = doc.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  video.srcObject = stream;
  doc.body.appendChild(video);

  const po: Popout = { win, video, stream, unwatch: () => {} };
  po.unwatch = watchStream(key, stream);
  open.set(key, po);
  win.addEventListener("pagehide", () => {
    if (open.get(key) === po) drop(key);
  });
  hookHost(host);
  notify();
}

/**
 * watchStream closes the pop-out when its video track ends. The panel that
 * opened it is usually not on screen (the point of a pop-out is to browse
 * elsewhere), so it cannot be the thing that notices a share stopping.
 */
function watchStream(key: string, stream: MediaStream): () => void {
  const track = stream.getVideoTracks()[0];
  if (!track) return () => {};
  const onEnded = () => closeTilePopout(key);
  track.addEventListener("ended", onEnded);
  return () => track.removeEventListener("ended", onEnded);
}

/** drop forgets a pop-out without touching its window (it is already gone). */
function drop(key: string): void {
  const po = open.get(key);
  if (!po) return;
  po.unwatch();
  open.delete(key);
  notify();
}

export function closeTilePopout(key: string): void {
  const po = open.get(key);
  if (!po) return;
  drop(key);
  try {
    po.win.close();
  } catch {
    // Already gone.
  }
}

/** closeAllTilePopouts shuts every pop-out window. Safe to call blind. */
export function closeAllTilePopouts(): void {
  for (const key of [...open.keys()]) closeTilePopout(key);
}

/**
 * syncTilePopouts reconciles the open windows with what the call is actually
 * showing: a tile that is gone (peer left, camera off, share stopped) loses
 * its window, and a tile whose stream was replaced mid-call (renegotiation)
 * keeps its window and gets the new stream.
 */
export function syncTilePopouts(
  live: Array<{ key: string; stream: MediaStream; label: string }>,
): void {
  const byKey = new Map(live.map((t) => [t.key, t]));
  for (const [key, po] of [...open]) {
    if (po.win.closed) {
      drop(key);
      continue;
    }
    const t = byKey.get(key);
    if (!t) {
      closeTilePopout(key);
      continue;
    }
    if (po.stream !== t.stream) {
      po.unwatch();
      po.stream = t.stream;
      po.unwatch = watchStream(key, t.stream);
      po.video.srcObject = t.stream;
    }
    if (po.win.document.title !== t.label) po.win.document.title = t.label;
  }
}

// A pop-up is not a child of the tab in any lifecycle sense: closing the app
// leaves it on screen showing a stream that has stopped. Hook once, lazily,
// so importing this module in a worker or a test does not need a window.
let hooked: Window | null = null;
function hookHost(host: Window): void {
  if (hooked === host) return;
  hooked = host;
  host.addEventListener("pagehide", () => closeAllTilePopouts());
}
