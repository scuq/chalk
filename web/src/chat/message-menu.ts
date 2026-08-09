// What a message's context menu contains, and where it fits on screen.
//
// The row used to carry three hover-revealed buttons pinned to its right
// edge. They painted over the text of any message longer than half a line,
// and reaching them meant crossing the whole feed. Everything now lives in
// one pointer-anchored menu; this module is the part of it worth testing
// without a DOM.

/** One-click reactions, offered above the rest of the menu.
 *
 * Deliberately a fixed list: nothing in the client tracks recently-used
 * emoji today, and six glyphs do not justify inventing persisted state for
 * it. Anything outside the six is one more click away under "react...". */
export const QUICK_REACTIONS = ["👍", "😄", "🎉", "❤️", "👀", "🚀"];

export type MessageMenuItem =
  | { kind: "react" }
  | { kind: "reply" }
  | { kind: "quote" }
  | { kind: "copy" }
  | { kind: "edit" }
  | { kind: "delete"; label: string };

export interface MessageMenuOpts {
  deleted: boolean;
  canReact: boolean;
  canReply: boolean;
  /** 99-3: is there anything a quote could carry? A separate question from
   *  hasText, which asks about the raw body: a gif's body is not empty, but
   *  what its sender SAID is, and quoting "" helps nobody. */
  canQuote: boolean;
  hasText: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** Democratic channels call it "propose deletion" -- see deletepolicy.ts. */
  deleteLabel?: string;
}

/** The menu's items, in display order. Empty means there is nothing to
 *  offer, and the caller should not open a menu at all. A tombstoned row is
 *  the clearest case: its body is gone server-side, so every action on it is
 *  meaningless. */
export function buildMessageMenu(opts: MessageMenuOpts): MessageMenuItem[] {
  if (opts.deleted) return [];
  const items: MessageMenuItem[] = [];
  if (opts.canReact) items.push({ kind: "react" });
  if (opts.canReply) items.push({ kind: "reply" });
  // Above copy: "reply in thread" and "quote" are the two ways to answer,
  // and they belong together. Copy is not an answer, it is an exit.
  if (opts.canQuote) items.push({ kind: "quote" });
  if (opts.hasText) items.push({ kind: "copy" });
  if (opts.canEdit) items.push({ kind: "edit" });
  if (opts.canDelete) items.push({ kind: "delete", label: opts.deleteLabel ?? "delete" });
  return items;
}

/** Do the quick-reaction buttons apply? They are a shortcut for the "react"
 *  item, so they stand or fall with it. */
export function showsQuickReactions(items: MessageMenuItem[]): boolean {
  return items.some((i) => i.kind === "react");
}

/** Keep the menu at least this far from the viewport edge. */
const MENU_MARGIN_PX = 8;

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

/** Place a menu of `size` at `p`, folded back inside `viewport`.
 *
 * The menu is position:fixed (it has to be -- the feed is an overflow:auto
 * scroller that would otherwise clip it), so this works in viewport
 * coordinates. Past the bottom edge it flips ABOVE the anchor rather than
 * merely sliding up, so the pointer never lands on an item it did not aim
 * for; the right edge slides instead, where there is no such hazard. The
 * final clamp wins over both, for a menu taller or wider than the viewport
 * itself. */
export function clampMenuPosition(p: Point, size: Size, viewport: Size): { left: number; top: number } {
  let left = p.x;
  if (left + size.w + MENU_MARGIN_PX > viewport.w) left = viewport.w - size.w - MENU_MARGIN_PX;
  if (left < MENU_MARGIN_PX) left = MENU_MARGIN_PX;

  let top = p.y;
  if (top + size.h + MENU_MARGIN_PX > viewport.h) top = p.y - size.h;
  if (top < MENU_MARGIN_PX) top = MENU_MARGIN_PX;

  return { left, top };
}
