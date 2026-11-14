// 137-8, 137-11: the friend chips on the phone list, in up to two lines.
//
// A chip is a button with a presence dot and the name of a friend. A tap opens
// the chat with that friend. The order is the order of the friends list.
// The target is eight chips, so a long name is shortened. Chips that do not fit
// fold into a last "+N" chip. A tap on it opens the full list.
//
// The component measures before paint. It renders every chip, up to
// FRIEND_CHIPS_MAX, and the "+N" chip with visibility hidden. A layout effect
// reads the natural width of each name, the overhead of a chip, the gap, the
// width of "+N", the width of the line, and the mean width of a character.
// fitFriendChips gives the count and the widest name. The component turns that
// width into a whole number of characters, never under MIN_NAME_CHARS, and
// renders each name cut to that many characters as text.
// It measures again when the friends or their names change, and when the width
// of the line changes. The list has a width of 0 while a chat covers it, so
// the line measures again when the list returns.
//
// The cut is text and not CSS for two reasons. An ellipsis costs one letter of
// a four-letter name. A CSS clip can slice a glyph in half. The CSS variable
// --chalk-chip-name-max stays as a guard for a proportional font, where the
// mean character width is only an estimate.

import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { FRIEND_CHIPS_MAX, fitFriendChips, type ChipFit, type ZuckerFriend } from "../chat/zucker";
import { presenceClass, presenceLabel } from "../chat/presence";

// The fewest characters of a name that a chip shows.
const MIN_NAME_CHARS = 4;

interface Props {
  friends: ZuckerFriend[];
  onSelect: (userID: string) => void;
  onMore: () => void;
}

export function FriendChips({ friends, onSelect, onMore }: Props) {
  const shownFriends = friends.slice(0, FRIEND_CHIPS_MAX);
  const empty = friends.length === 0;
  const lineRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<(ChipFit & { chars: number }) | null>(null);
  // The key changes when a chip can change its width or its place.
  const key = shownFriends.map((f) => `${f.userID}:${f.name}`).join("|") + `#${friends.length}`;

  useLayoutEffect(() => {
    setFit(null);
  }, [key]);

  useLayoutEffect(() => {
    const el = lineRef.current;
    if (!el || fit !== null) return;
    const chips = [...el.querySelectorAll<HTMLElement>("[data-chip]")];
    const names = chips.map((c) => c.querySelector<HTMLElement>(".chalk-zucker-chip-name"));
    const more = el.querySelector<HTMLElement>("[data-more]");
    const cs = getComputedStyle(el);
    const width = (e: Element | null | undefined) => e?.getBoundingClientRect().width ?? 0;
    const nameWidths = names.map((n) => width(n));
    const chars = shownFriends.reduce((sum, f) => sum + Array.from(f.name).length, 0);
    const total = nameWidths.reduce((sum, w) => sum + w, 0);
    const charWidth = chars > 0 ? total / chars : 0;
    const got = fitFriendChips({
      nameWidths,
      overhead: chips.length > 0 ? width(chips[0]) - nameWidths[0] : 0,
      gap: parseFloat(cs.columnGap) || 0,
      moreWidth: width(more),
      // One pixel under the real width, so a rounded fraction cannot wrap a line.
      lineWidth: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 1,
      minName: charWidth * MIN_NAME_CHARS,
    });
    setFit({
      ...got,
      chars: charWidth > 0 ? Math.max(MIN_NAME_CHARS, Math.floor(got.nameCap / charWidth + 0.01)) : Infinity,
    });
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
  const visible = measuring ? shownFriends : shownFriends.slice(0, fit.count);
  const rest = friends.length - (measuring ? 0 : visible.length);

  return (
    <div
      ref={lineRef}
      class={`chalk-zucker-chips ${measuring ? "chalk-zucker-chips--measuring" : ""}`}
      style={measuring ? undefined : `--chalk-chip-name-max:${Math.floor(fit.nameCap)}px`}
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
            <span class="chalk-zucker-chip-name">
              {measuring ? f.name : Array.from(f.name).slice(0, fit.chars).join("")}
            </span>
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
