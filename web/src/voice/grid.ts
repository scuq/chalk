// 63-1: tile-grid geometry for group calls.
//
// With three or more participants the call renders as a grid of identical
// tiles instead of the spotlight (big tile + filmstrip): two columns, rows
// added downward as people join, and a dummy tile squaring off the last row
// when the count is odd. The spotlight remains the layout for 1:1 calls,
// for a user-pinned tile, and while a screen share is live -- a share is a
// "look at this", not a face among equals. Kept as a pure module so the
// geometry is testable without a DOM.

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
