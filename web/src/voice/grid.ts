// 63-1: tile-grid geometry for group calls.
//
// With three or more participants the call renders as a grid of identical
// tiles instead of the spotlight (big tile + filmstrip): two columns, rows
// added downward as people join, and a dummy tile squaring off the last row
// when the count is odd. The spotlight remains the layout for 1:1 calls and
// while a screen share is live -- a share is a "look at this", not a face
// among equals. Kept as a pure module so the geometry is testable without
// a DOM.
//
// 96-1 put that rule under a viewer's standing choice (resolveGridMode): the
// control bar can force either layout, and "auto" is the rule above.
//
// 133-9 replaced that count rule in the panel with resolveStageMode. The count
// rule gave a voice-only call of two people one large empty 16:9 box. The new
// rule reads the media: cards when no tile has live video, a grid of cameras
// above cards in the mixed case, and the spotlight for a live share.
// resolveGridMode stays exported and tested, but nothing outside its tests
// imports it.

export interface GridPlan {
  /** Grid columns; always 2 -- growth is vertical by design. */
  cols: number;
  /** Grid rows for tiles + dummies. */
  rows: number;
  /** Placeholder tiles needed to fill the last row. */
  dummies: number;
}

export const GRID_MIN_TILES = 3;

/** True when this many tiles should render as the grid (assuming nothing
 * else forces the spotlight: a pin or a live screen share). */
export function useGrid(tileCount: number): boolean {
  return tileCount >= GRID_MIN_TILES;
}

/**
 * 96-1: the layout the VIEWER has asked for. "auto" is the 63-1 rule below;
 * the other two are a standing choice made with the control-bar toggle, and
 * they outrank everything -- a forced grid keeps its tiles while a share is
 * live, a forced spotlight keeps its big tile in a room of nine.
 */
export type VoiceLayout = "auto" | "grid" | "spotlight";

/**
 * resolveGridMode (96-1) decides grid vs spotlight for one render.
 *
 * Deliberately blind to the pinned tile. Until 96-1 a pin forced the
 * spotlight, which meant a focus chosen in a 1:1 call -- where the spotlight
 * is the ONLY layout and clicking a face is just "look at this one" -- was
 * still in force when a third person joined, and the grid never appeared.
 * Leaving the grid is now a layout decision of its own: clicking a GRID tile
 * pins it and sets "spotlight", so intent is recorded where it is expressed
 * and a stale pin from the 1:1 stage cannot speak for it.
 */
export function resolveGridMode(
  layout: VoiceLayout,
  tileCount: number,
  hasLiveShare: boolean,
): boolean {
  if (tileCount === 0) return false;
  if (layout === "grid") return true;
  if (layout === "spotlight") return false;
  return useGrid(tileCount) && !hasLiveShare;
}

/** True when the call is crowded enough (rows beyond a 2x2) that the
 * scratchpad below should give up height to the grid. */
export function isCrowded(tileCount: number): boolean {
  return tileCount > 4;
}

export function gridPlan(tileCount: number): GridPlan {
  const cols = 2;
  const rows = Math.max(1, Math.ceil(tileCount / cols));
  return { cols, rows, dummies: rows * cols - tileCount };
}

/**
 * 133-9: how the stage draws one render.
 *
 * - "cards": no tile has live video. Everyone is a compact card.
 * - "mixed": cameras are 16:9 tiles, and people without video are cards below.
 * - "grid": every tile is a 16:9 tile of equal size.
 * - "spotlight": one big tile with the rest in a strip.
 */
export type StageMode = "cards" | "mixed" | "grid" | "spotlight";

/**
 * resolveStageMode (133-9) returns the stage mode for one render. Rules, in
 * order:
 *
 * 1. If no tile has live video, it returns "cards". This holds when the
 *    viewer forced a layout, because a forced grid or spotlight with no video
 *    is only empty boxes.
 * 2. If the viewer forced "grid" or "spotlight", it returns that layout.
 * 3. If a screen share has live video, it returns "spotlight".
 * 4. Otherwise it returns "mixed".
 */
export function resolveStageMode(
  layout: VoiceLayout,
  tiles: readonly { hasLiveVideo: boolean; isScreen: boolean }[],
): StageMode {
  if (!tiles.some((t) => t.hasLiveVideo)) return "cards";
  if (layout === "grid") return "grid";
  if (layout === "spotlight") return "spotlight";
  if (tiles.some((t) => t.isScreen && t.hasLiveVideo)) return "spotlight";
  return "mixed";
}

/**
 * videoGrid returns the columns and rows for count camera tiles in the mixed
 * layout. One camera gets 1 by 1, two get 2 by 1, three or four get 2 columns,
 * five to nine get 3 columns, and more get 4 columns. The rows are the count
 * divided by the columns, rounded up, and never less than 1.
 */
export function videoGrid(count: number): { cols: number; rows: number } {
  const cols = count <= 1 ? 1 : count === 2 ? 2 : count <= 4 ? 2 : count <= 9 ? 3 : 4;
  return { cols, rows: Math.max(1, Math.ceil(count / cols)) };
}
