// 129-1: the figure for the season -- a pumpkin, a ghost, a snowman.
//
// One component serves every season. The registry says which season it is
// and which figures it has. Each visit draws one figure at random, never the
// figure of the visit before. The schedule in season/peek.ts sets the bounds
// of a visit, and season/visits.ts grants a visit: at most 10 in a local day
// on one device, with 1 to 2 hours between them. The aura follows the figure,
// so it has the same limit.
// The anchor is a fixed-size box in the flow of the header brand, after the
// wordmark. Its size is in em, so it scales with the title. The art is
// taller than the box and overflows it, so the header keeps the height of
// the logo and does not reflow when the figure comes and goes.
// pointer-events: none stops the figure from taking a click.
// The fade and the bob are CSS, and reduced motion switches them off. The
// only timer here is one timeout for each schedule step.
// Beside the figure is the aura, a glow along the inner edge of the window.
// The parent switches the aura on inside the aura window of the season.

import { useEffect, useState } from "preact/hooks";
import type { Season } from "../season/seasons";
import { pickFigure } from "../season/seasons";
import { FIGURES } from "../season/figures";
import { firstPeek, nextPeek, type Peek } from "../season/peek";
import { takeVisit } from "../season/visits";

interface Props {
  season: Season;
  /** whether the window-edge glow runs today (the season's aura window) */
  aura: boolean;
}

interface Visit extends Peek {
  figure: string;
}

export function SeasonFigure({ season, aura }: Props) {
  const [visit, setVisit] = useState<Visit>(() => ({
    ...firstPeek(),
    figure: pickFigure(season),
  }));
  useEffect(() => {
    const t = setTimeout(() => {
      // Only a visible page claims a visit. A background tab does not spend
      // the visits of the day where nobody sees them. It checks again later.
      const show = !visit.visible && document.visibilityState === "visible" && takeVisit();
      // A new face each time the figure comes back. Picked as it comes
      // in, never as it goes out: the one on its way out must stay what
      // it was for the whole fade.
      const figure = show ? pickFigure(season, Math.random, visit.figure) : visit.figure;
      setVisit({ ...nextPeek(show), figure });
    }, visit.ms);
    return () => clearTimeout(t);
  }, [visit, season]);
  const key = `${season.id}/${visit.figure}`;
  const fig = FIGURES[key];
  const vis = visit.visible ? "--visible" : "";
  return (
    <div class="chalk-season" data-testid="season-anchor">
      {/* 129-1: the aura -- a glow along the inner edge of the window while
          the figure is out, so the whole room sees the visitor and not only
          one corner. The element is fixed to the viewport and takes no
          clicks. Its colour comes from the rule of the season in theme.css.
          It mounts only inside the aura window of the season. */}
      {aura && (
        <div
          class={"chalk-season-aura" + (vis && " chalk-season-aura--visible")}
          data-testid="season-aura"
          data-season={season.id}
          aria-hidden="true"
        />
      )}
      <span
        class={"chalk-season-figure" + (vis && " chalk-season-figure--visible")}
        data-testid="season-figure"
        data-season={season.id}
        data-figure={visit.figure}
        data-visible={visit.visible ? "" : undefined}
        role="img"
        aria-label={fig ? `${fig.label}, for ${season.id}` : season.id}
        aria-hidden={!visit.visible}
      >
        {fig && <img class="chalk-season-art" src={fig.src} alt="" draggable={false} />}
      </span>
    </div>
  );
}
