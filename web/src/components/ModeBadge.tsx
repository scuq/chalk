/**
 * ModeBadge -- a small inline glyph in the channel header showing the
 * channel's governance mode (gov-2):
 *
 *   dictator   -> crown.       "owner acts unilaterally"
 *   democratic -> ballot box.  "actions decided by a member vote"
 *
 * Glyphs are the spec-approved 16x16 paths (fill none, stroke currentColor).
 * Presentational only; the mode is sourced from the channel summary.
 */
export function ModeBadge({ mode }: { mode: string }) {
  const democratic = mode === "democratic";
  const label = democratic
    ? "Democratic -- privileged actions decided by a member vote"
    : "Dictator -- the owner acts unilaterally";

  return (
    <span
      class={"chalk-mode-badge" + (democratic ? " chalk-mode-democratic" : " chalk-mode-dictator")}
      role="img"
      aria-label={label}
      title={label}
      data-mode={democratic ? "democratic" : "dictator"}
      data-testid="mode-badge"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 18 18"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        {democratic ? (
          <>
            <path d="M2 9 L2 15 L16 15 L16 9" />
            <path d="M1 6 L9 3 L17 6 L9 9 Z" />
            <line x1="9" y1="9" x2="9" y2="12" />
          </>
        ) : (
          <>
            <path d="M2 13 L2 6 L6 9 L9 3 L12 9 L16 6 L16 13 Z" />
            <line x1="2" y1="15.5" x2="16" y2="15.5" />
          </>
        )}
      </svg>
    </span>
  );
}
