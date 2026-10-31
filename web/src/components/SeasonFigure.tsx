// 129-1: the figure for the season -- a pumpkin, a ghost, a snowman.
//
// One component serves every season. The registry says which season it is
// and which figures it has. Each visit draws one figure at random, never the
// figure of the visit before. The schedule in season/peek.ts says when the
// figure shows.
// The anchor is a zero-size element at the top-right corner of the footer.
// The footer is position: relative. So the figure floats over the
// bottom-right corner of the feed, whatever the length or the scroll
// position of the feed, and takes no room from it.
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
    const t = setTimeout(
      () =>
        setVisit((v) => {
          const next = nextPeek(v.visible);
          // A new face each time the figure comes back. Picked as it comes
          // in, never as it goes out: the one on its way out must stay what
          // it was for the whole fade.
          const figure = next.visible ? pickFigure(season, Math.random, v.figure) : v.figure;
          return { ...next, figure };
        }),
      visit.ms,
    );
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
