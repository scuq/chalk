// chalk-web -- 129-6: the night frame on a pop-out or board video.
//
// On the Halloween night, theme.css gives the video tiles of the main
// document a green frame. It shows the frame while <html> has the
// data-season-night attribute.
// A pop-out and the board are separate documents with no stylesheet.
// The CSP of the opener refuses an injected <style> (pip.ts gives the reason).
// Their frame is a div with styles set through the CSSOM.
// This module paints every live frame. It repaints them all when
// setNightFrame is called at the start or the end of the night.

/** NightColours are the two CSS colours of a frame: the line and the inner glow. */
export interface NightColours {
  line: string;
  glow: string;
}

let current: NightColours | null = null;
const frames = new Set<HTMLElement>();

function paint(el: HTMLElement, c: NightColours | null): void {
  if (!c) {
    el.style.display = "none";
    return;
  }
  el.style.display = "block";
  el.style.boxShadow = `inset 0 0 0 2px ${c.line}, inset 0 0 28px 6px ${c.glow}`;
}

/**
 * mountNightFrame adds a click-through frame over `container` and returns a
 * function that removes the frame. The container must be positioned and must
 * hold the video. If the night is on, the frame shows at once.
 */
export function mountNightFrame(doc: Document, container: HTMLElement): () => void {
  const el = doc.createElement("div");
  // Set a class, not an attribute, and guard remove. The pop-out and board
  // tests use a minimal element with no setAttribute and no remove.
  // The frame must not make these tests need them.
  el.className = "chalk-season-night-frame";
  const s = el.style;
  s.position = "absolute";
  s.inset = "0";
  s.pointerEvents = "none";
  s.zIndex = "3";
  paint(el, current);
  container.appendChild(el);
  frames.add(el);
  return () => {
    frames.delete(el);
    if (typeof el.remove === "function") el.remove();
  };
}

/** setNightFrame shows every live frame with the colours `c`, or hides every live frame if `c` is null. */
export function setNightFrame(c: NightColours | null): void {
  current = c;
  for (const el of frames) paint(el, c);
}

/** nightFrameCount reports how many frames are live. Tests use it. */
export function nightFrameCount(): number {
  return frames.size;
}
