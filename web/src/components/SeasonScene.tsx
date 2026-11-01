// 129-9: the scene for the season -- a small pixel animation in the header.
// 129-10: in the always-on hours the scene stays up without a break.
// 129-11: on a phone in zuckermode the scene is a row above the list.
// 129-12: a date in no season shows the neutral scenes. A scene rotates.
//
// One component serves every season and the dates between them. The registry
// says which season it is, or null for a date in no season. season/scene.ts
// holds five scenes for each season and five neutral scenes, and it moves the
// scene. The schedule in season/peek.ts sets the bounds of a visit, and
// season/visits.ts grants a visit under the caps in peek.ts.
// App.tsx mounts the component in one of two places. On a wide screen it sits
// in the header, between the brand and the status bar. The box .chalk-season
// takes the empty middle of the header. The canvas inside it is out of flow,
// so the header keeps its height when the scene comes and goes.
// On a phone in zuckermode, with the `row` prop, ZuckerList renders the
// component as the first child of the list screen. The row has no height
// between visits and opens to 44 px while a visit shows. The classic phone
// layout mounts no scene.
// The list screen unmounts when a conversation opens, so the component starts
// again, with a first pause, when the user comes back to the list. The log of
// visits is in localStorage, so the daily caps hold across that restart.
// The component draws on the canvas only during a visit and for FADE_MS after
// it. A hidden canvas costs no frame. In the always-on hours (ALWAYS_ON in
// season/seasons.ts) the component draws without a break, claims no visit, and
// the daily caps do not count those hours.
// A visit makes a new scene, so no state passes from one visit to the next. A
// scene rotates to the next one every SCENE_SECONDS (see season/scene.ts).
// Each visit starts at a random one of the five scenes. A visit lasts 45 s to
// 75 s and a scene lasts 35 s, so a start at the first scene would almost never
// show scenes 3 to 5. A visit shows two or three scenes, and the always-on
// hours walk all five.
// The fade is CSS. The only timer for the schedule is one timeout for each
// step.
// If the system asks for reduced motion, a visit paints one frame and holds
// it, and the CSS fade is off.

import { useEffect, useRef, useState } from "preact/hooks";
import type { Season } from "../season/seasons";
import { firstPeek, nextPeek, type Peek } from "../season/peek";
import {
  createScene,
  drawScene,
  FPS,
  resizeScene,
  SCALE,
  SCENES_PER_KEY,
  stepScene,
  type SceneKey,
} from "../season/scene";
import { takeVisit } from "../season/visits";

// The time that the canvas takes to fade out. It must equal the opacity
// transition of .chalk-season-canvas in theme.css.
const FADE_MS = 1200;

/**
 * runScene paints a new scene for the key on the canvas and returns the
 * function that ends the visit. The scene starts at a random one of the five
 * scenes of the key.
 *
 * The scene has the size of the canvas in scene pixels. A resize of the canvas
 * resizes the scene and paints it again. Unless the system asks for reduced
 * motion, a requestAnimationFrame loop steps and paints the scene at FPS
 * frames each second. With reduced motion, the scene paints one frame and
 * holds it.
 *
 * The returned function stops the loop FADE_MS later, not at once. The canvas
 * fades out during that time. If the loop stopped first, the scene would
 * freeze in the picture while it fades.
 */
function runScene(
  el: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  key: SceneKey,
): () => void {
  const size = (): [number, number] => [
    Math.max(1, Math.round(el.clientWidth / SCALE)),
    Math.max(1, Math.round(el.clientHeight / SCALE)),
  ];
  const [w, h] = size();
  el.width = w;
  el.height = h;
  ctx.imageSmoothingEnabled = false;
  const scene = createScene(key, w, h, Math.floor(Math.random() * SCENES_PER_KEY));
  const paint = () => {
    ctx.clearRect(0, 0, el.width, el.height);
    drawScene(ctx, scene);
  };
  const fit = () => {
    const [nw, nh] = size();
    if (nw === el.width && nh === el.height) return;
    el.width = nw;
    el.height = nh;
    ctx.imageSmoothingEnabled = false;
    resizeScene(scene, nw, nh);
    paint();
  };
  let raf = 0;
  let last = 0;
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    if (!last) last = now;
    const elapsed = now - last;
    if (elapsed < 1000 / FPS) return;
    last = now;
    stepScene(scene, elapsed / 1000);
    paint();
  };
  paint();
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    raf = requestAnimationFrame(frame);
  }
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
  observer?.observe(el);
  return () => {
    setTimeout(() => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
    }, FADE_MS);
  };
}

interface Props {
  /** the season to show, or null for a date in no season: the neutral scenes then show */
  season: Season | null;
  /** true in the always-on hours: the scene stays up and no visit is claimed */
  always: boolean;
  /** true for the row above the zuckermode list: the box has no height between visits */
  row?: boolean;
}

/**
 * SeasonScene renders the canvas of the season, or of the neutral scenes if
 * `season` is null, and runs the schedule of visits. The scene key is the id of
 * the season, or "neutral". The label for a screen reader is the label of the
 * season, or "Chalk". The canvas is hidden between visits. It has a label for a screen
 * reader while a visit shows. If `always` is true, the canvas stays up without
 * a break and the schedule claims no visit.
 */
export function SeasonScene({ season, always, row = false }: Props) {
  const [visit, setVisit] = useState<Peek>(() => firstPeek());
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      // In the always-on hours no visit is claimed, so the hours do not use up
      // the daily caps.
      const show =
        !always && !visit.visible && document.visibilityState === "visible" && takeVisit();
      setVisit(nextPeek(show));
    }, visit.ms);
    return () => clearTimeout(t);
  }, [visit, always]);
  const key: SceneKey = season?.id ?? "neutral";
  const label = season?.label ?? "Chalk";
  // The canvas is up in a visit and in the always-on hours.
  const live = always || visit.visible;
  useEffect(() => {
    const el = canvas.current;
    const ctx = live ? el?.getContext("2d") : null;
    if (!el || !ctx) return;
    return runScene(el, ctx, key);
  }, [live, key]);
  return (
    <div
      class={
        "chalk-season" +
        (row ? " chalk-season--row" : "") +
        (live ? " chalk-season--live" : "")
      }
      data-testid="season-anchor"
    >
      <canvas
        ref={canvas}
        class={"chalk-season-canvas" + (live ? " chalk-season-canvas--visible" : "")}
        data-testid="season-scene"
        data-season={key}
        data-visible={live ? "" : undefined}
        role="img"
        aria-label={`${label}, an animated pixel scene`}
        aria-hidden={!live}
      />
    </div>
  );
}
