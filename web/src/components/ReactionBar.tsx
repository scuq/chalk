// 37-5 / 75-1: the row of reaction chips under a message, and the card that
// says who sent each one.
//
// The chips used to carry the reactors in a native title= attribute. That is
// invisible on touch -- a phone never hovers -- so on mobile there was no way
// at all to find out who reacted, and on desktop it arrived a second late in
// OS chrome that ignores the theme. This replaces it with one card, opened by
// hover, by keyboard focus, or by a press on touch.
//
// The state lives here, per message, rather than in MessageList: only one chip
// can be under the pointer at a time, and a card left open on another row is
// closed by the same pointerdown that opens the new one.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Message, ReactionSet } from "../state/types";
import { aggregate, reactorList, reactorSummary, type ReactorList } from "../chat/reactions";
import { clampMenuPosition } from "../chat/message-menu";
import { LONG_PRESS_MS, pressWandered } from "../chat/press";

// How long the pointer has to rest on a chip before the card opens. Short
// enough to feel like an answer to pointing at it, long enough that sweeping
// across a row of chips on the way somewhere else doesn't flash three cards.
const HOVER_INTENT_MS = 300;

// Between the chip and the card, so the card reads as attached to it without
// covering it.
const CARD_GAP_PX = 6;

interface Props {
  message: Message;
  sets: readonly ReactionSet[];
  ownUserID?: string | null;
  /** userID → handle for this channel, built once per render by MessageList. */
  handleByUser: Map<string, string>;
  onToggle: (m: Message, emoji: string) => void;
}

interface OpenCard {
  emoji: string;
  count: number;
  who: ReactorList;
  /** The chip's box, in viewport coordinates -- the card is position:fixed. */
  anchor: { left: number; top: number; bottom: number };
}

export function ReactionBar({ message, sets, ownUserID, handleByUser, onToggle }: Props) {
  const [card, setCard] = useState<OpenCard | null>(null);

  // One timer for both gestures: they are mutually exclusive (a device does
  // not hover and press at once) and both end the same way.
  const openTimer = useRef<number | null>(null);
  const pressFired = useRef(false);
  const pressOrigin = useRef<{ x: number; y: number } | null>(null);

  const cancelPending = () => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    pressOrigin.current = null;
  };

  // A row can be unmounted mid-press -- paged out of the feed, or the channel
  // switched under a resting finger. The pending timer must not outlive it.
  useEffect(() => cancelPending, []);

  const tallies = aggregate(sets, ownUserID);
  if (tallies.length === 0) return null;

  const open = (el: HTMLElement, emoji: string, count: number, who: ReactorList) => {
    const r = el.getBoundingClientRect();
    setCard({ emoji, count, who, anchor: { left: r.left, top: r.top, bottom: r.bottom } });
  };

  const close = () => {
    cancelPending();
    setCard(null);
  };

  return (
    <div class="chalk-message-reactions" data-testid={`message-reactions-${message.id}`}>
      {tallies.map((t) => {
        const who = reactorList(t.userIDs, (u) => handleByUser.get(u), ownUserID);
        return (
          <button
            key={t.emoji}
            type="button"
            class={`chalk-reaction ${t.mine ? "chalk-reaction--mine" : ""}`}
            onClick={(e) => {
              // The browser synthesises a click when the finger lifts. Left
              // alone it would toggle the reaction the press was asking about.
              if (pressFired.current) {
                pressFired.current = false;
                e.preventDefault();
                e.stopPropagation();
                return;
              }
              close();
              onToggle(message, t.emoji);
            }}
            onMouseEnter={(e) => {
              const el = e.currentTarget as HTMLElement;
              cancelPending();
              openTimer.current = window.setTimeout(
                () => open(el, t.emoji, t.count, who),
                HOVER_INTENT_MS,
              );
            }}
            onMouseLeave={close}
            // Keyboard reaches the chips already -- they are buttons in the
            // feed's tab order -- so focus opens the card with no delay.
            onFocus={(e) => open(e.currentTarget as HTMLElement, t.emoji, t.count, who)}
            onBlur={close}
            onPointerDown={(e) => {
              if (e.pointerType === "mouse") return; // hover covers desktop
              // The message row underneath runs its own 500ms press to open
              // the context menu. Without this it would open too, on top of
              // the card the chip's own press just asked for.
              e.stopPropagation();
              const el = e.currentTarget as HTMLElement;
              cancelPending();
              pressFired.current = false;
              pressOrigin.current = { x: e.clientX, y: e.clientY };
              openTimer.current = window.setTimeout(() => {
                pressFired.current = true;
                open(el, t.emoji, t.count, who);
              }, LONG_PRESS_MS);
            }}
            onPointerMove={(e) => {
              const o = pressOrigin.current;
              if (o && pressWandered(o, { x: e.clientX, y: e.clientY })) cancelPending();
            }}
            onPointerUp={cancelPending}
            onPointerCancel={cancelPending}
            aria-pressed={t.mine}
            aria-label={`${t.emoji}, reacted by ${reactorSummary(who)}`}
            data-testid={`reaction-${message.id}-${t.emoji}`}
          >
            <span class="chalk-reaction-emoji" aria-hidden="true">{t.emoji}</span>
            <span class="chalk-reaction-count">{t.count}</span>
          </button>
        );
      })}
      {card && <ReactionWho card={card} onClose={close} />}
    </div>
  );
}

// position:fixed rather than absolute for the reason MessageMenu is: the feed
// is an overflow:auto scroller, and an absolutely positioned card on one of
// the last rows would be clipped by it.
function ReactionWho({ card, onClose }: { card: OpenCard; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Measure, then place -- the height depends on how many people reacted, and
  // every size here is in ch against a user-adjustable font scale. Above the
  // chip by preference so the card never sits under the pointer that opened
  // it; below when there is no room above.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const above = card.anchor.top - r.height - CARD_GAP_PX;
    const next = clampMenuPosition(
      {
        x: card.anchor.left,
        y: above >= 0 ? above : card.anchor.bottom + CARD_GAP_PX,
      },
      { w: r.width, h: r.height },
      { w: window.innerWidth, h: window.innerHeight },
    );
    setPos((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : next));
  }, [card]);

  // Escape, the next press anywhere, or the feed scrolling out from under the
  // anchor -- a fixed card does not travel with its row. The pointerdown
  // listener is capture-phase so a tap that lands on another chip still closes
  // this one before that chip opens its own.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onClose, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", onClose, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      class="chalk-reaction-who"
      role="tooltip"
      data-testid="reaction-who"
      style={
        pos
          ? `left:${pos.left}px;top:${pos.top}px`
          : `left:${card.anchor.left}px;top:${card.anchor.top}px;visibility:hidden`
      }
    >
      <div class="chalk-reaction-who-head">
        <span aria-hidden="true">{card.emoji}</span>
        <span>{card.count === 1 ? "1 reaction" : `${card.count} reactions`}</span>
      </div>
      {card.who.names.map((n) => (
        <div key={n} class="chalk-reaction-who-name">{n}</div>
      ))}
      {card.who.more > 0 && (
        <div class="chalk-reaction-who-more">and {card.who.more} more</div>
      )}
    </div>
  );
}
