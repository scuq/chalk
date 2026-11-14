// 137-8: one line of friend chips under the closed "@ friends" row on the phone list.
//
// A chip is a button with a presence dot and the name of a friend. A tap opens
// the chat with that friend. The order is the order of the friends list.
// Chips that do not fit fold into a last "+N" chip. A tap on it opens the full list.
//
// The component measures before paint. It renders every chip, up to
// FRIEND_CHIPS_MAX, and the "+N" chip with visibility hidden. A layout effect
// reads the widths, and chipsThatFit gives the count to keep.
// It measures again when the friends or their names change, and when the width
// of the line changes. The list has a width of 0 while a chat covers it, so
// the line measures again when the list returns.

import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { FRIEND_CHIPS_MAX, chipsThatFit, type ZuckerFriend } from "../chat/zucker";
import { presenceClass, presenceLabel } from "../chat/presence";

interface Props {
  friends: ZuckerFriend[];
  onSelect: (userID: string) => void;
  onMore: () => void;
}

export function FriendChips({ friends, onSelect, onMore }: Props) {
  const shownFriends = friends.slice(0, FRIEND_CHIPS_MAX);
  const empty = friends.length === 0;
  const lineRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<number | null>(null);
  // The key changes when a chip can change its width or its place.
  const key = shownFriends.map((f) => `${f.userID}:${f.name}`).join("|") + `#${friends.length}`;

  useLayoutEffect(() => {
    setFit(null);
  }, [key]);

  useLayoutEffect(() => {
    const el = lineRef.current;
    if (!el || fit !== null) return;
    const chips = [...el.querySelectorAll<HTMLElement>("[data-chip]")];
    const more = el.querySelector<HTMLElement>("[data-more]");
    const cs = getComputedStyle(el);
    const available = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    setFit(
      chipsThatFit(
        chips.map((c) => c.offsetWidth),
        available,
        parseFloat(cs.columnGap) || 0,
        more?.offsetWidth ?? 0,
      ),
    );
  }, [fit, key]);

  // The line does not exist while there are no friends. The effect depends on
  // empty, so the observer attaches when the line appears.
  useLayoutEffect(() => {
    const el = lineRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let last = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === last) return;
      last = el.clientWidth;
      setFit(null);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [empty]);

  if (empty) return null;
  // While fit is null, every chip and the hidden "+N" chip are in the DOM to be measured.
  const measuring = fit === null;
  const visible = measuring ? shownFriends : shownFriends.slice(0, fit);
  const rest = friends.length - (measuring ? 0 : visible.length);

  return (
    <div
      ref={lineRef}
      class={`chalk-zucker-chips ${measuring ? "chalk-zucker-chips--measuring" : ""}`}
      data-testid="zucker-friend-chips"
    >
      {visible.map((f) => (
        <button
          key={f.userID}
          type="button"
          class="chalk-zucker-chip"
          onClick={() => onSelect(f.userID)}
          aria-label={`${f.name}, ${presenceLabel(f.presence)}`}
          data-chip
          data-testid="zucker-friend-chip"
          data-user-id={f.userID}
          data-presence={f.presence}
        >
          <span class="chalk-zucker-chip-pill">
            <span class={`chalk-presence-dot ${presenceClass(f.presence)}`} aria-hidden="true" />
            <span class="chalk-zucker-chip-name">{f.name}</span>
          </span>
        </button>
      ))}
      {(measuring || rest > 0) && (
        <button
          type="button"
          class="chalk-zucker-chip chalk-zucker-chip--more"
          onClick={onMore}
          aria-label={`${rest} more friends, show the list`}
          data-more
          data-testid="zucker-friend-chips-more"
        >
          <span class="chalk-zucker-chip-pill">+{measuring ? friends.length : rest}</span>
        </button>
      )}
    </div>
  );
}
