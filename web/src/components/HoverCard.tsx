// chalk-web -- the hover card (92-1, generalised in 92-4).
//
// One tooltip with two homes: a desktop roster row, and a sender name in the
// message feed. Both open it on a deliberate rest of the pointer, both anchor
// it to the element rather than to the cursor -- a card that follows mouse
// jitter is harder to read than one that stays put -- and both clamp it into
// the viewport the way the sidebar menus do.
//
// Two properties of the CSS are load-bearing. `position: fixed` gets the card
// out of the sidebar's and the feed's scroll containers, which would
// otherwise clip it. `pointer-events: none` keeps it from ever being the
// thing under the cursor: it is drawn over what it describes, and
// intercepting the pointer there would both eat the click and flicker the
// card off and on.
//
// Touch never opens it. On the roster a long press is already the nick menu
// (9.7f), and in the feed a long press is already the message menu; a tooltip
// has nothing to add to a gesture budget that is spent.

import { useEffect, useRef, useState } from "preact/hooks";
import { nickTintStyle } from "../chat/nickcolor";
import { presenceClass } from "../chat/presence";
import type { PersonCardInfo } from "../chat/hovercard";

// How long the pointer must rest before the card appears. Keyboard focus
// passes 0 -- tabbing to a row is already deliberate.
export const HOVER_CARD_DELAY_MS = 500;

// The clamp needs the card's size before the card exists. Width is the CSS
// max-width; height is the tallest form (name, display name, state, last
// seen, and a hint or an identity footer) rounded up.
const CARD_W = 220;
const CARD_H = 150;
const GAP = 8;

// Where the card sits relative to what it describes.
//
//   "right" -- beside the anchor. The roster's placement: the sidebar is
//              narrow and what lies to its right is the feed's margin.
//   "below" -- under the anchor, left edges aligned. The feed's placement,
//              because what lies to the right of a sender name is the
//              message you are hovering it to read.
export type CardPlacement = "right" | "below";

export interface OpenCard<T> {
  data: T;
  x: number;
  y: number;
}

function cardPosition(anchor: HTMLElement, placement: CardPlacement) {
  const r = anchor.getBoundingClientRect();
  const maxX = Math.max(0, window.innerWidth - CARD_W);
  const maxY = Math.max(0, window.innerHeight - CARD_H);
  return placement === "below"
    ? { x: Math.min(r.left, maxX), y: Math.min(r.bottom + 4, maxY) }
    : { x: Math.min(r.right + GAP, maxX), y: Math.min(r.top, maxY) };
}

// useHoverCard owns the open card and the rest timer.
//
// `data` is whatever the surface needs to draw the card, and is captured when
// the card opens. Keep it to identifiers where you can: the roster passes a
// userID rather than a resolved friend so a presence push landing while the
// card is up is reflected on the next render.
export function useHoverCard<T>() {
  const [card, setCard] = useState<OpenCard<T> | null>(null);
  const timer = useRef<number | null>(null);

  const close = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setCard(null);
  };

  const arm = (
    data: T,
    anchor: HTMLElement,
    delayMS: number,
    placement: CardPlacement = "right",
  ) => {
    close();
    const at = cardPosition(anchor, placement);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setCard({ data, ...at });
    }, delayMS);
  };

  // A list scrolls under a stationary pointer without firing a pointerleave,
  // which would strand the card over an unrelated row. Capture phase: the
  // scroll happens on the container, not on window.
  useEffect(() => {
    if (!card) return;
    const onScroll = () => setCard(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCard(null);
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [card]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return { card, arm, close };
}

// PersonCard draws a resolved PersonCardInfo. Lines that resolved to null are
// simply absent.
export function PersonCard({
  x,
  y,
  info,
  testID,
}: {
  x: number;
  y: number;
  info: PersonCardInfo;
  testID: string;
}) {
  return (
    <div
      class="chalk-friend-card"
      style={`left:${x}px;top:${y}px`}
      data-testid={testID}
      role="tooltip"
    >
      <div
        class={`chalk-friend-card-name ${info.hue !== null ? "chalk-nick-tinted" : ""}`}
        style={info.hue !== null ? nickTintStyle(info.hue) : undefined}
      >
        {info.name}
      </div>
      {info.displayName && (
        <div class="chalk-friend-card-display">{info.displayName}</div>
      )}
      {info.state && (
        <div class="chalk-friend-card-state">
          <span class={`chalk-presence-dot ${presenceClass(info.state)}`} />
          {info.state}
        </div>
      )}
      {info.seen && <div class="chalk-friend-card-seen">{info.seen}</div>}
      {info.hint && <div class="chalk-friend-card-hint">{info.hint}</div>}
      {info.meta && <div class="chalk-friend-card-meta">{info.meta}</div>}
    </div>
  );
}
