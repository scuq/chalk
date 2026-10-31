// 129-1: the figure for the season -- today a ghost for halloween.
//
// One component for every season: the registry says which, a switch picks the
// glyph, and the schedule in season/peek.ts says when it shows. The anchor is
// a zero-size absolute element pinned to the top-right corner of the
// composer footer (the footer is position: relative). The glyph floats over
// the bottom-right corner of the feed, whatever the feed's length or scroll
// position, and takes no room from it. App.tsx mounts this component in the
// footer only for a text channel that is on screen. pointer-events: none stops
// the glyph from taking a click. The fade and the bob are CSS, and reduced
// motion switches them off. The only timer is one setTimeout per schedule step.

import { useEffect, useState } from "preact/hooks";
import type { Season, SeasonId } from "../season/seasons";
import { firstPeek, nextPeek } from "../season/peek";

interface Props {
  season: Season;
}

const LABELS: Record<SeasonId, string> = {
  halloween: "a ghost, for halloween",
  christmas: "a decoration, for christmas",
};

export function SeasonFigure({ season }: Props) {
  const [peek, setPeek] = useState(() => firstPeek());
  useEffect(() => {
    const t = setTimeout(() => setPeek((p) => nextPeek(p.visible)), peek.ms);
    return () => clearTimeout(t);
  }, [peek]);
  return (
    <div class="chalk-season" data-testid="season-anchor">
      <span
        class={"chalk-season-figure" + (peek.visible ? " chalk-season-figure--visible" : "")}
        data-testid="season-figure"
        data-season={season.id}
        data-visible={peek.visible ? "" : undefined}
        role="img"
        aria-label={LABELS[season.id]}
        aria-hidden={!peek.visible}
      >
        {glyph(season.id)}
      </span>
    </div>
  );
}

function glyph(id: SeasonId) {
  switch (id) {
    case "halloween":
      return <Ghost />;
    case "christmas":
      // 129-4 draws this one. Until then the registry holds no christmas
      // window, so this branch is never reached.
      return null;
  }
}

// The ghost: a dome with a wavy hem, eyes and a mouth cut out in the page
// colour so they read as holes rather than paint.
function Ghost() {
  return (
    <svg
      class="chalk-season-svg"
      viewBox="0 0 24 24"
      width="40"
      height="40"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 2a7 7 0 0 0-7 7v12.2l2.4-1.9 2.3 1.9 2.3-1.9 2.3 1.9 2.3-1.9 2.4 1.9V9a7 7 0 0 0-7-7z" />
      <circle class="chalk-season-cut" cx="9.6" cy="9.6" r="1.4" />
      <circle class="chalk-season-cut" cx="14.4" cy="9.6" r="1.4" />
      <ellipse class="chalk-season-cut" cx="12" cy="13.6" rx="1.1" ry="1.5" />
    </svg>
  );
}
