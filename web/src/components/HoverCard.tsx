// chalk-web -- the hover card (92-1, generalised in 92-4).
//
// One tooltip with three homes: a desktop roster row, a sender name in the
// message feed, and a voice room row in the sidebar (the room card, 131-3).
// All three open it on a deliberate rest of the pointer, all anchor it to the
// element rather than to the cursor -- a card that follows mouse jitter is
// harder to read than one that stays put -- and all clamp it into the
// viewport the way the sidebar menus do.
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
// has nothing to add to a gesture budget that is spent. The voice row has no
// touch form either: the count badge stays, and the stage lists the names.

import type { ComponentChildren } from "preact"; // 112-4
import { useEffect, useRef, useState } from "preact/hooks";
import { nickTintStyle } from "../chat/nickcolor";
import { presenceClass } from "../chat/presence";
import { ROOM_CARD_MAX_ROWS, type PersonCardInfo, type RoomCardRow } from "../chat/hovercard";
import { CamIcon, DeafIcon, MicOffIcon, ScreenIcon } from "./VoiceBadges"; // 131-3

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

function cardPosition(anchor: HTMLElement, placement: CardPlacement, heightPX: number) {
  const r = anchor.getBoundingClientRect();
  const maxX = Math.max(0, window.innerWidth - CARD_W);
  const maxY = Math.max(0, window.innerHeight - heightPX);
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

  // 131-3: `heightPX` is the clamp's estimate of the card's height. The
  // person card is one size; the room card grows with the room, and a tall
  // card clamped as a short one would run off the bottom of the window.
  const arm = (
    data: T,
    anchor: HTMLElement,
    delayMS: number,
    placement: CardPlacement = "right",
    heightPX: number = CARD_H,
  ) => {
    close();
    const at = cardPosition(anchor, placement, heightPX);
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
  avatar,
}: {
  x: number;
  y: number;
  info: PersonCardInfo;
  testID: string;
  /** 112-4: the card is the one place a picture can be worth looking at, so
   *  it gets a real one -- 44px, beside the name. The caller resolves which
   *  channel's copy to use (pickAvatar), because a card is about a person
   *  and a picture is encrypted per channel. */
  avatar?: ComponentChildren;
}) {
  return (
    <div
      class="chalk-friend-card"
      style={`left:${x}px;top:${y}px`}
      data-testid={testID}
      role="tooltip"
    >
      {avatar && <div class="chalk-friend-card-avatar">{avatar}</div>}
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

// 131-3: the room card. The sidebar's card frame, with one row per person in
// a voice room instead of one person's lines. Rows past the cap fold into a
// count, so a crowded room stays a card and not a column.
const ROOM_ROW_H = 18;

/** roomCardHeight estimates the card's height for the clamp. */
export function roomCardHeight(count: number): number {
  const rows = Math.min(count, ROOM_CARD_MAX_ROWS) + (count > ROOM_CARD_MAX_ROWS ? 1 : 0);
  return GAP * 2 + ROOM_ROW_H + 4 + rows * ROOM_ROW_H;
}

export function RoomCard({
  x,
  y,
  rows,
  testID,
}: {
  x: number;
  y: number;
  rows: RoomCardRow[];
  testID: string;
}) {
  const shown = rows.slice(0, ROOM_CARD_MAX_ROWS);
  const more = rows.length - shown.length;
  return (
    <div
      class="chalk-friend-card chalk-room-card"
      style={`left:${x}px;top:${y}px`}
      data-testid={testID}
      role="tooltip"
    >
      <div class="chalk-room-card-title">{rows.length} in voice</div>
      {shown.map((r) => (
        <div class="chalk-room-card-row" key={r.key} data-user-id={r.key}>
          <span
            class={`chalk-room-card-name ${r.hue !== null ? "chalk-nick-tinted" : ""}`}
            style={r.hue !== null ? nickTintStyle(r.hue) : undefined}
          >
            {r.name}
          </span>
          {r.deafened ? <DeafIcon /> : r.muted ? <MicOffIcon /> : null}
          {r.camera && <CamIcon />}
          {r.screen && <ScreenIcon />}
        </div>
      ))}
      {more > 0 && <div class="chalk-room-card-more">+{more} more</div>}
    </div>
  );
}
