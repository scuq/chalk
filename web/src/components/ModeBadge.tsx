import { BallotIcon, CrownIcon } from "./icons";

/**
 * ModeBadge -- a small inline glyph in the channel header showing the
 * channel's governance mode (gov-2):
 *
 *   dictator   -> crown.       "owner acts unilaterally"
 *   democratic -> ballot box.  "actions decided by a member vote"
 *
 * The glyphs are CrownIcon and BallotIcon from icons.tsx. They share the
 * 24-unit grid and the stroke of every other icon. The badge takes the accent
 * color in both modes.
 * Presentational only; the mode is sourced from the channel summary.
 */
export function ModeBadge({ mode, onClick }: { mode: string; onClick?: () => void }) {
  const democratic = mode === "democratic";
  const label = democratic
    ? "Democratic -- privileged actions decided by a member vote"
    : "Dictator -- the owner acts unilaterally";

  return (
    <span
      class={"chalk-mode-badge" + (democratic ? " chalk-mode-democratic" : " chalk-mode-dictator")}
      role={onClick ? "button" : "img"}
      aria-label={onClick ? label + " -- open governance" : label}
      title={label}
      data-mode={democratic ? "democratic" : "dictator"}
      data-testid="mode-badge"
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (onClick && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick();
        }
      }}
      style={onClick ? "cursor: pointer" : undefined}
    >
      {democratic ? <BallotIcon /> : <CrownIcon />}
    </span>
  );
}
