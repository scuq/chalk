// Phase 120-1: the board -- every participant's video in ONE window of its
// own, each tile free to drag and resize inside it.
//
// 45-5 / 47-4 pop a single tile out, one window per tile, which is the shape
// for "put the shared screen on my second monitor". The board is the other
// shape: "put the whole call over there, and let me arrange it" -- four
// faces in a corner, the share big, whatever the person likes. One window,
// laid out as a grid to start, then the tiles are theirs: drag by the name
// strip, resize by the corner, and a tile you touch comes to the front.
//
// It rides the same mechanics as pip.ts: a plain pop-up (or, with 118's
// "above other windows" pref on and the floating window unclaimed, that),
// built from the opener's own script -- an about:blank pop-up is same-origin,
// so the elements and listeners are made here and simply live over there.
// Styling is property assignment on element.style, never an injected
// <style>: the pop-up inherits the opener's CSP, whose style-src 'self'
// refuses an inline stylesheet, and pip.ts learned that the hard way.
//
// Every video is MUTED, as in pip.ts: remote audio has exactly one output
// path (VoiceDock's sinks), and a second would double every voice.
//
// The layout is not remembered across openings yet -- the grid comes back
// each time. That is the obvious next slice if anyone wants it.

export interface BoardTile {
  key: string;
  stream: MediaStream;
  label: string;
  /** Your own camera, drawn mirrored the way the stage draws it. */
  mirrored?: boolean;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const GAP = 8;
const STRIP = 22; // the name strip's height, which is also the drag handle
const MIN_W = 160;
const MIN_H = 90 + STRIP;

/**
 * boardLayout places n tiles on a w x h board as the tightest grid that
 * holds them, each tile 16:9 (plus its strip) inside its cell, centred.
 * Pure, so the tests can pin it.
 */
export function boardLayout(n: number, w: number, h: number): Rect[] {
  if (n <= 0) return [];
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const cellW = Math.floor((w - GAP * (cols + 1)) / cols);
  const cellH = Math.floor((h - GAP * (rows + 1)) / rows);
  // 16:9 for the picture, the strip on top of that.
  let tw = cellW;
  let th = Math.round((tw * 9) / 16) + STRIP;
  if (th > cellH) {
    th = cellH;
    tw = Math.round(((th - STRIP) * 16) / 9);
  }
  tw = Math.max(MIN_W, tw);
  th = Math.max(MIN_H, th);
  const out: Rect[] = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    out.push({
      left: GAP + c * (cellW + GAP) + Math.floor((cellW - tw) / 2),
      top: GAP + r * (cellH + GAP) + Math.floor((cellH - th) / 2),
      width: tw,
      height: th,
    });
  }
  return out;
}

/** boardWindowSize: most of the screen, capped -- the tiles are resizable,
 * the window is the browser's to resize. */
export function boardWindowSize(availWidth: number, availHeight: number): {
  width: number;
  height: number;
} {
  return {
    width: Math.max(480, Math.min(1280, Math.round(availWidth * 0.8))),
    height: Math.max(320, Math.min(800, Math.round(availHeight * 0.8))),
  };
}

interface Placed {
  root: HTMLElement;
  video: HTMLVideoElement;
  strip: HTMLElement;
  stream: MediaStream;
}

interface Board {
  win: Window;
  stage: HTMLElement;
  tiles: Map<string, Placed>;
  z: number;
}

let board: Board | null = null;
const watchers = new Set<() => void>();
let hooked: Window | null = null;

function notify(): void {
  for (const fn of watchers) fn();
}

/** subscribeBoard notifies on open and close, so a button can show state. */
export function subscribeBoard(fn: () => void): () => void {
  watchers.add(fn);
  return () => {
    watchers.delete(fn);
  };
}

export function boardOpen(): boolean {
  return board !== null && !board.win.closed;
}

interface DocumentPiP {
  requestWindow(opts?: { width?: number; height?: number }): Promise<Window>;
  window: Window | null;
}

/**
 * openBoard shows tiles in the board window and reports whether one opened
 * (false: pop-up blocked, or nothing with video to show). A board that is
 * already open is raised and resynced instead of doubled.
 */
export async function openBoard(
  tiles: BoardTile[],
  host: Window = window,
  opts: { onTop?: boolean } = {},
): Promise<boolean> {
  if (boardOpen()) {
    syncBoard(tiles);
    board!.win.focus();
    return true;
  }
  if (board) forget();
  if (tiles.length === 0) return false;
  const size = boardWindowSize(host.screen.availWidth, host.screen.availHeight);

  let win: Window | null = null;
  const pip = opts.onTop
    ? ((host as { documentPictureInPicture?: DocumentPiP }).documentPictureInPicture ?? null)
    : null;
  if (pip && !pip.window) {
    try {
      win = await pip.requestWindow(size);
    } catch {
      /* refused; the plain path below still applies */
    }
  }
  if (!win) {
    const left = Math.max(0, Math.round((host.screen.availWidth - size.width) / 2));
    const top = Math.max(0, Math.round((host.screen.availHeight - size.height) / 2));
    win = host.open(
      "",
      "chalk-board",
      `popup=yes,width=${size.width},height=${size.height},left=${left},top=${top}`,
    );
  }
  if (!win) return false;

  const doc = win.document;
  doc.title = "chalk — call";
  doc.body.innerHTML = "";
  for (const el of [doc.documentElement, doc.body]) {
    el.style.margin = "0";
    el.style.height = "100%";
    el.style.background = "#000";
    el.style.overflow = "hidden";
  }
  const stage = doc.createElement("div");
  stage.style.position = "relative";
  stage.style.width = "100%";
  stage.style.height = "100%";
  doc.body.appendChild(stage);

  board = { win, stage, tiles: new Map(), z: 1 };
  const b = board;
  const rects = boardLayout(tiles.length, size.width, size.height);
  tiles.forEach((t, i) => place(b, t, rects[i]));
  win.addEventListener("pagehide", () => {
    if (board === b) forget();
  });
  if (hooked !== host) {
    hooked = host;
    host.addEventListener("pagehide", () => closeBoard());
  }
  win.focus();
  notify();
  return true;
}

function place(b: Board, t: BoardTile, rect: Rect): void {
  const doc = b.win.document;
  const root = doc.createElement("div");
  const s = root.style;
  s.position = "absolute";
  s.left = rect.left + "px";
  s.top = rect.top + "px";
  s.width = rect.width + "px";
  s.height = rect.height + "px";
  s.minWidth = MIN_W + "px";
  s.minHeight = MIN_H + "px";
  s.background = "#111";
  s.border = "1px solid #333";
  s.boxSizing = "border-box";
  s.display = "flex";
  s.flexDirection = "column";
  // The browser's own resize handle: no code, works in every engine, and
  // the video below fills whatever size the corner is dragged to.
  s.resize = "both";
  s.overflow = "hidden";
  s.zIndex = String(b.z++);

  const strip = doc.createElement("div");
  const ss = strip.style;
  ss.flex = "0 0 " + STRIP + "px";
  ss.height = STRIP + "px";
  ss.lineHeight = STRIP + "px";
  ss.padding = "0 8px";
  ss.fontFamily = "ui-monospace, monospace";
  ss.fontSize = "12px";
  ss.color = "#ddd";
  ss.background = "#222";
  ss.cursor = "move";
  ss.userSelect = "none";
  ss.whiteSpace = "nowrap";
  ss.overflow = "hidden";
  ss.textOverflow = "ellipsis";
  strip.textContent = t.label;

  const video = doc.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  video.srcObject = t.stream;
  const vs = video.style;
  vs.flex = "1 1 auto";
  vs.minHeight = "0";
  vs.width = "100%";
  vs.background = "#000";
  vs.objectFit = "contain";
  vs.display = "block";
  if (t.mirrored) vs.transform = "scaleX(-1)";

  root.appendChild(strip);
  root.appendChild(video);
  b.stage.appendChild(root);
  wireDrag(b, root, strip);
  b.tiles.set(t.key, { root, video, strip, stream: t.stream });
}

/** wireDrag moves the tile by its strip and raises whichever tile is
 * touched. Pointer capture keeps a fast drag from escaping the strip. */
function wireDrag(b: Board, root: HTMLElement, strip: HTMLElement): void {
  root.addEventListener("pointerdown", () => {
    root.style.zIndex = String(b.z++);
  });
  let drag: { dx: number; dy: number } | null = null;
  strip.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.button !== 0) return;
    drag = { dx: e.clientX - root.offsetLeft, dy: e.clientY - root.offsetTop };
    strip.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  strip.addEventListener("pointermove", (e: PointerEvent) => {
    if (!drag) return;
    // Keep the strip reachable: a tile dragged fully off the board could
    // never be dragged back.
    const maxL = Math.max(0, b.stage.clientWidth - MIN_W);
    const maxT = Math.max(0, b.stage.clientHeight - STRIP);
    root.style.left = Math.min(maxL, Math.max(0, e.clientX - drag.dx)) + "px";
    root.style.top = Math.min(maxT, Math.max(0, e.clientY - drag.dy)) + "px";
  });
  const end = (e: PointerEvent) => {
    if (!drag) return;
    drag = null;
    strip.releasePointerCapture?.(e.pointerId);
  };
  strip.addEventListener("pointerup", end);
  strip.addEventListener("pointercancel", end);
}

/**
 * syncBoard reconciles the board with what the call is showing: tiles that
 * are gone leave, new ones arrive (cascaded, since the grid was the person's
 * to rearrange and is not re-imposed), a swapped stream is followed, a
 * changed label is rewritten. The board stays open on an empty call --
 * closing it is the person's call, and the window closes with the app.
 */
export function syncBoard(tiles: BoardTile[]): void {
  if (!board) return;
  if (board.win.closed) {
    forget();
    return;
  }
  const b = board;
  const byKey = new Map(tiles.map((t) => [t.key, t]));
  for (const [key, p] of [...b.tiles]) {
    const t = byKey.get(key);
    if (!t) {
      p.root.remove();
      b.tiles.delete(key);
      continue;
    }
    if (p.stream !== t.stream) {
      p.stream = t.stream;
      p.video.srcObject = t.stream;
    }
    if (p.strip.textContent !== t.label) p.strip.textContent = t.label;
    p.video.style.transform = t.mirrored ? "scaleX(-1)" : "";
  }
  let n = b.tiles.size;
  for (const t of tiles) {
    if (b.tiles.has(t.key)) continue;
    const step = 32 * (n++ % 8);
    place(b, t, { left: GAP + step, top: GAP + step, width: 320, height: 180 + STRIP });
  }
}

function forget(): void {
  board = null;
  notify();
}

export function closeBoard(): void {
  const b = board;
  if (!b) return;
  forget();
  try {
    b.win.close();
  } catch {
    /* already gone */
  }
}
