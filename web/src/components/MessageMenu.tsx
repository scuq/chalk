// The per-message context menu.
//
// Replaces the hover button strip that used to sit on the row's right edge:
// it overlapped the text of any message longer than half a line, and it made
// acting on a message a trip across the whole feed. This opens where the
// pointer already is, from the row's left-gutter marker, a right-click, a
// long-press, or the "r" shortcut.
//
// position:fixed rather than absolute because the feed (.chalk-main) is an
// overflow:auto scroller -- an absolutely positioned menu on one of the last
// rows gets clipped by it, which is exactly what the old "..." menu did.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  QUICK_REACTIONS,
  clampMenuPosition,
  showsQuickReactions,
  type MessageMenuItem,
} from "../chat/message-menu";

interface Props {
  items: MessageMenuItem[];
  /** Viewport coordinates of the anchor: the pointer, or the marker's corner. */
  x: number;
  y: number;
  onPick: (item: MessageMenuItem) => void;
  onQuickReact: (emoji: string) => void;
  onClose: () => void;
}

const LABELS: Record<MessageMenuItem["kind"], string> = {
  react: "react...",
  reply: "reply in thread",
  copy: "copy text",
  edit: "edit",
  delete: "delete",
};

export function MessageMenu({ items, x, y, onPick, onQuickReact, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Measure, then place. Rendering once hidden at the raw anchor and folding
  // the real box back inside the viewport beats guessing at dimensions --
  // the height depends on which items apply, and every size here is in `ch`
  // against a user-adjustable font scale.
  //
  // items.length rather than items in the deps: the caller builds the array
  // fresh on every render, so depending on its identity would re-measure ->
  // setPos -> re-render forever. The equality guard closes the same loop from
  // the other end.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const next = clampMenuPosition(
      { x, y },
      { w: r.width, h: r.height },
      { w: window.innerWidth, h: window.innerHeight },
    );
    setPos((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : next));
  }, [x, y, items.length]);

  // Escape, a click anywhere outside, or the feed scrolling out from under
  // the anchor. The last one matters because a fixed menu does not travel
  // with its row -- it would otherwise hang over an unrelated message.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("click", onClose);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("click", onClose);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  if (items.length === 0) return null;

  // Edit and delete are about owning or moderating a message rather than
  // taking part in the conversation, and delete is irreversible -- so they
  // sit below a rule, away from the items the pointer lands on first.
  const ownerKinds = new Set(["edit", "delete"]);
  const common = items.filter((i) => !ownerKinds.has(i.kind));
  const owner = items.filter((i) => ownerKinds.has(i.kind));

  const renderItem = (item: MessageMenuItem) => (
    <button
      key={item.kind}
      type="button"
      role="menuitem"
      class={`chalk-msgmenu-item chalk-msgmenu-item--${item.kind}`}
      onClick={() => onPick(item)}
      data-testid={`message-menu-${item.kind}`}
    >
      {item.kind === "delete" ? item.label : LABELS[item.kind]}
    </button>
  );

  return (
    <div
      ref={ref}
      class="chalk-msgmenu"
      role="menu"
      aria-label="message actions"
      data-testid="message-menu"
      style={
        pos
          ? `left:${pos.left}px;top:${pos.top}px`
          : `left:${x}px;top:${y}px;visibility:hidden`
      }
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {showsQuickReactions(items) && (
        <div class="chalk-msgmenu-quick" data-testid="message-menu-quick">
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              role="menuitem"
              class="chalk-msgmenu-quick-btn"
              aria-label={`react with ${emoji}`}
              title={`react with ${emoji}`}
              onClick={() => onQuickReact(emoji)}
              data-testid={`message-menu-quick-${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      {common.length > 0 && <div class="chalk-msgmenu-group">{common.map(renderItem)}</div>}
      {owner.length > 0 && <div class="chalk-msgmenu-group">{owner.map(renderItem)}</div>}
    </div>
  );
}
