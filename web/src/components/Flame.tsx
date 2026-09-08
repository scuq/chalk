// 115-2: the flame -- a channel is heating up.
//
// One implementation for the roster row, the phone's conversation list and
// the channel header, on the UnreadDot precedent: three surfaces that must
// never disagree about what "busy" looks like. The verdict comes from the
// burst store; this only draws it, and reads the live count back for the
// tooltip so the badge can say why it is there.
//
// The glyph is an inline SVG on currentColor like the channel glyphs, so it
// takes the theme's warn colour from CSS and the flicker is a CSS animation
// on transform and opacity -- nothing here ticks.

import { burstStore } from "../chat/burst-store";

interface Props {
  channelID: string;
  /** the window the threshold was measured over, for the tooltip */
  minutes: number;
  /** where it sits: a row badge, or beside the channel's title */
  where?: "row" | "header";
}

export function Flame({ channelID, minutes, where = "row" }: Props) {
  const n = burstStore.countIn(channelID, Date.now());
  const label =
    `busy: ${n} message${n === 1 ? "" : "s"} in the last ` +
    `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return (
    <span
      class={`chalk-flair-flame chalk-flair-flame--${where}`}
      data-testid="flair-flame"
      title={label}
      aria-label={label}
      role="img"
    >
      <svg
        class="chalk-flair-flame-svg"
        viewBox="0 0 24 24"
        width="13"
        height="13"
        fill="currentColor"
        aria-hidden="true"
      >
        {/* Outer tongue. */}
        <path
          class="chalk-flair-flame-outer"
          d="M12 2c1 4 5 5.5 5 11a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5 0 2 1 3 2 3 0-3 0-6 1-9.5z"
        />
        {/* Inner tongue, drawn in the page colour so it reads as the hot
            core rather than a hole. */}
        <path
          class="chalk-flair-flame-inner"
          d="M12 12c1 2 2 3 2 5a2 2 0 0 1-4 0c0-1 .5-2 1-2.5 0 1 .5 1.5 1 1.5 0-1.5-.5-2.5 0-4z"
        />
      </svg>
    </span>
  );
}
